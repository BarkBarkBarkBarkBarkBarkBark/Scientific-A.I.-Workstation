import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type AiPlanRequest = {
  goal: string
  plugins: {
    id: string
    name: string
    description: string
    inputs: { id: string; name: string; type: string }[]
    outputs: { id: string; name: string; type: string }[]
  }[]
}

type AiChatRequest = {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
}

function readJson(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c: any) => {
      raw += String(c)
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function json(res: any, statusCode: number, body: any) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function safeResolve(root: string, relPath: string): { ok: true; abs: string } | { ok: false; reason: string } {
  const p = String(relPath || '').replaceAll('\\', '/')
  if (!p || p.includes('\0') || p.startsWith('..') || p.includes('/../')) return { ok: false, reason: 'bad_path' }
  if (p.startsWith('.git/') || p.includes('/.git/')) return { ok: false, reason: 'blocked_git' }
  if (p.startsWith('node_modules/') || p.includes('/node_modules/')) return { ok: false, reason: 'blocked_node_modules' }
  const abs = path.resolve(root, p)
  const rootAbs = path.resolve(root)
  if (!abs.startsWith(rootAbs)) return { ok: false, reason: 'outside_root' }
  return { ok: true, abs }
}

async function runGit(root: string, args: string[]) {
  const r = await execFileAsync('git', args, { cwd: root })
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

export default defineConfig(({ mode }) => {
  // Load all env vars (including non-VITE_*) for dev-server proxy
  const env = loadEnv(mode, process.cwd(), '')
  const OPENAI_API_KEY = env.OPENAI_API_KEY
  const OPENAI_MODEL = env.OPENAI_MODEL || 'gpt-4o-mini'
  const ROOT = process.cwd()

  return {
    plugins: [
      react(),
      {
        name: 'saw-openai-proxy',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url) return next()

            // -----------------------
            // Dev FS + Git endpoints
            // -----------------------
            if (req.method === 'GET' && req.url.startsWith('/api/dev/file')) {
              const u = new URL(req.url, 'http://localhost')
              const rel = u.searchParams.get('path') || ''
              const resolved = safeResolve(ROOT, rel)
              if (!resolved.ok) return json(res, 400, { error: 'invalid_path', reason: resolved.reason })
              try {
                const content = await fs.readFile(resolved.abs, 'utf8')
                return json(res, 200, { path: rel, content })
              } catch (e: any) {
                return json(res, 404, { error: 'read_failed', details: String(e?.message ?? e) })
              }
            }

            if (req.method === 'POST' && req.url.startsWith('/api/dev/file')) {
              let body: { path: string; content: string }
              try {
                body = (await readJson(req)) as { path: string; content: string }
              } catch {
                return json(res, 400, { error: 'Invalid JSON body' })
              }
              const resolved = safeResolve(ROOT, body.path)
              if (!resolved.ok) return json(res, 400, { error: 'invalid_path', reason: resolved.reason })

              try {
                await fs.writeFile(resolved.abs, String(body.content ?? ''), 'utf8')
                // Trigger Vite's HMR pipeline without a full page reload (keeps app state).
                // This updates only the modules impacted by the changed file.
                server.watcher.emit('change', resolved.abs)
                return json(res, 200, { ok: true })
              } catch (e: any) {
                return json(res, 500, { error: 'write_failed', details: String(e?.message ?? e) })
              }
            }

            if (req.method === 'GET' && req.url.startsWith('/api/dev/git/status')) {
              try {
                const u = new URL(req.url, 'http://localhost')
                const rel = u.searchParams.get('path') || ''
                const s = await runGit(ROOT, ['status', '--porcelain'])

                if (rel) {
                  const resolved = safeResolve(ROOT, rel)
                  if (!resolved.ok) return json(res, 400, { error: 'invalid_path', reason: resolved.reason })
                  const d = await runGit(ROOT, ['diff', '--', rel])
                  return json(res, 200, { status: s.stdout, diff: d.stdout, path: rel })
                }

                const d = await runGit(ROOT, ['diff'])
                return json(res, 200, { status: s.stdout, diff: d.stdout, path: null })
              } catch (e: any) {
                return json(res, 500, { error: 'git_failed', details: String(e?.message ?? e) })
              }
            }

            if (req.method === 'POST' && req.url.startsWith('/api/dev/git/commit')) {
              let body: { message: string }
              try {
                body = (await readJson(req)) as { message: string }
              } catch {
                return json(res, 400, { error: 'Invalid JSON body' })
              }
              const msg = String(body.message ?? '').trim()
              if (!msg) return json(res, 400, { error: 'missing_commit_message' })
              try {
                await runGit(ROOT, ['add', '-A'])
                const r = await runGit(ROOT, ['commit', '-m', msg, '--no-gpg-sign'])
                return json(res, 200, { ok: true, stdout: r.stdout, stderr: r.stderr })
              } catch (e: any) {
                return json(res, 500, { error: 'git_commit_failed', details: String(e?.message ?? e) })
              }
            }

            if (req.method === 'GET' && req.url.startsWith('/api/ai/status')) {
              json(res, 200, { enabled: Boolean(OPENAI_API_KEY), model: OPENAI_MODEL })
              return
            }

            if (req.method === 'POST' && req.url.startsWith('/api/ai/plan')) {
              if (!OPENAI_API_KEY) {
                json(res, 503, { error: 'OPENAI_API_KEY not set' })
                return
              }

              let body: AiPlanRequest
              try {
                body = (await readJson(req)) as AiPlanRequest
              } catch {
                json(res, 400, { error: 'Invalid JSON body' })
                return
              }

              const system = [
                'You are SAW Planner: plan a scientific analysis pipeline using ONLY the provided plugins.',
                'Return ONLY valid JSON with these keys:',
                '- summary: string',
                '- suggestedPlugins: string[] (plugin ids)',
                '- connections: {fromPluginId: string, toPluginId: string}[]',
                '- suggestionsText: string[] (short bullets)',
                'Constraints:',
                '- Use only plugin ids from the provided list.',
                '- Keep the pipeline linear unless explicitly required.',
                '- Prefer: load -> clean/filter -> transform -> model -> visualize.',
              ].join('\n')

              const user = JSON.stringify({
                goal: body.goal,
                plugins: body.plugins,
              })

              try {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    model: OPENAI_MODEL,
                    temperature: 0.2,
                    response_format: { type: 'json_object' },
                    messages: [
                      { role: 'system', content: system },
                      { role: 'user', content: user },
                    ],
                  }),
                })

                if (!r.ok) {
                  const t = await r.text()
                  json(res, 502, { error: 'OpenAI request failed', details: t })
                  return
                }

                const j: any = await r.json()
                const content: string | undefined = j?.choices?.[0]?.message?.content
                if (!content) {
                  json(res, 502, { error: 'OpenAI returned empty content' })
                  return
                }

                // Parse plan JSON
                let plan: any
                try {
                  plan = JSON.parse(content)
                } catch {
                  plan = { summary: content, suggestedPlugins: [], connections: [], suggestionsText: [] }
                }

                json(res, 200, {
                  summary: String(plan.summary ?? ''),
                  suggestedPlugins: Array.isArray(plan.suggestedPlugins) ? plan.suggestedPlugins : [],
                  connections: Array.isArray(plan.connections) ? plan.connections : [],
                  suggestionsText: Array.isArray(plan.suggestionsText) ? plan.suggestionsText : [],
                  logs: ['[openai] planned pipeline (dev proxy)', `[openai] model: ${OPENAI_MODEL}`],
                  errors: [],
                })
                return
              } catch (e: any) {
                json(res, 500, { error: 'Proxy error', details: String(e?.message ?? e) })
                return
              }
            }

            if (req.method === 'POST' && req.url.startsWith('/api/ai/chat')) {
              if (!OPENAI_API_KEY) {
                json(res, 503, { error: 'OPENAI_API_KEY not set' })
                return
              }

              let body: AiChatRequest
              try {
                body = (await readJson(req)) as AiChatRequest
              } catch {
                json(res, 400, { error: 'Invalid JSON body' })
                return
              }

              const system = [
                'You are SAW Assistant: help the user build scientific pipelines, debug nodes, and explain outputs.',
                'Be concise. Suggest concrete next actions in the UI when possible.',
              ].join('\n')

              const messages = Array.isArray(body.messages) ? body.messages : []
              const finalMessages = [{ role: 'system', content: system }, ...messages]

              try {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    model: OPENAI_MODEL,
                    temperature: 0.3,
                    messages: finalMessages,
                  }),
                })

                if (!r.ok) {
                  const t = await r.text()
                  json(res, 502, { error: 'OpenAI request failed', details: t })
                  return
                }

                const j: any = await r.json()
                const content: string | undefined = j?.choices?.[0]?.message?.content
                json(res, 200, { message: content ?? '', model: OPENAI_MODEL })
                return
              } catch (e: any) {
                json(res, 500, { error: 'Proxy error', details: String(e?.message ?? e) })
                return
              }
            }

            next()
          })
        },
      },
    ],
    server: {
      port: 5173,
      strictPort: true,
    },
  }
})


