import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

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

export default defineConfig(({ mode }) => {
  // Load all env vars (including non-VITE_*) for dev-server proxy
  const env = loadEnv(mode, process.cwd(), '')
  const OPENAI_API_KEY = env.OPENAI_API_KEY
  const OPENAI_MODEL = env.OPENAI_MODEL || 'gpt-4o-mini'

  return {
    plugins: [
      react(),
      {
        name: 'saw-openai-proxy',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url) return next()

            if (req.method === 'GET' && req.url.startsWith('/api/ai/status')) {
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  enabled: Boolean(OPENAI_API_KEY),
                  model: OPENAI_MODEL,
                }),
              )
              return
            }

            if (req.method === 'POST' && req.url.startsWith('/api/ai/plan')) {
              if (!OPENAI_API_KEY) {
                res.statusCode = 503
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }))
                return
              }

              let body: AiPlanRequest
              try {
                body = (await readJson(req)) as AiPlanRequest
              } catch {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Invalid JSON body' }))
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
                  res.statusCode = 502
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: 'OpenAI request failed', details: t }))
                  return
                }

                const j: any = await r.json()
                const content: string | undefined = j?.choices?.[0]?.message?.content
                if (!content) {
                  res.statusCode = 502
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: 'OpenAI returned empty content' }))
                  return
                }

                // Parse plan JSON
                let plan: any
                try {
                  plan = JSON.parse(content)
                } catch {
                  plan = { summary: content, suggestedPlugins: [], connections: [], suggestionsText: [] }
                }

                res.setHeader('Content-Type', 'application/json')
                res.end(
                  JSON.stringify({
                    summary: String(plan.summary ?? ''),
                    suggestedPlugins: Array.isArray(plan.suggestedPlugins) ? plan.suggestedPlugins : [],
                    connections: Array.isArray(plan.connections) ? plan.connections : [],
                    suggestionsText: Array.isArray(plan.suggestionsText) ? plan.suggestionsText : [],
                    logs: [
                      '[openai] planned pipeline (dev proxy)',
                      `[openai] model: ${OPENAI_MODEL}`,
                    ],
                    errors: [],
                  }),
                )
                return
              } catch (e: any) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Proxy error', details: String(e?.message ?? e) }))
                return
              }
            }

            if (req.method === 'POST' && req.url.startsWith('/api/ai/chat')) {
              if (!OPENAI_API_KEY) {
                res.statusCode = 503
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }))
                return
              }

              let body: AiChatRequest
              try {
                body = (await readJson(req)) as AiChatRequest
              } catch {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Invalid JSON body' }))
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
                  res.statusCode = 502
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: 'OpenAI request failed', details: t }))
                  return
                }

                const j: any = await r.json()
                const content: string | undefined = j?.choices?.[0]?.message?.content
                res.setHeader('Content-Type', 'application/json')
                res.end(
                  JSON.stringify({
                    message: content ?? '',
                    model: OPENAI_MODEL,
                  }),
                )
                return
              } catch (e: any) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Proxy error', details: String(e?.message ?? e) }))
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


