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

type CapsRule = { path: string; r: boolean; w: boolean; d: boolean }
type CapsManifest = { version: 1; updatedAt: number; rules: CapsRule[] }

function safeResolve(root: string, relPath: string): { ok: true; abs: string } | { ok: false; reason: string } {
  const p = String(relPath || '').replaceAll('\\', '/')
  if (!p || p.includes('\0') || p.startsWith('..') || p.includes('/../')) return { ok: false, reason: 'bad_path' }
  if (p.startsWith('.git/') || p.includes('/.git/')) return { ok: false, reason: 'blocked_git' }
  if (p.startsWith('node_modules/') || p.includes('/node_modules/')) return { ok: false, reason: 'blocked_node_modules' }
  if (p.startsWith('dist/') || p.includes('/dist/')) return { ok: false, reason: 'blocked_dist' }
  if (p === '.env' || p.startsWith('.env.')) return { ok: false, reason: 'blocked_env' }
  if (p.startsWith('.npm-cache/') || p.includes('/.npm-cache/')) return { ok: false, reason: 'blocked_cache' }
  const abs = path.resolve(root, p)
  const rootAbs = path.resolve(root)
  if (!abs.startsWith(rootAbs)) return { ok: false, reason: 'outside_root' }
  return { ok: true, abs }
}

function isBlockedForTree(relPath: string) {
  const p = relPath.replaceAll('\\', '/')
  return (
    p === '.git' ||
    p.startsWith('.git/') ||
    p === 'node_modules' ||
    p.startsWith('node_modules/') ||
    p === 'dist' ||
    p.startsWith('dist/') ||
    p === '.npm-cache' ||
    p.startsWith('.npm-cache/') ||
    p === '.env' ||
    p.startsWith('.env.')
  )
}

async function readTree(rootAbs: string, rel: string, depth: number, maxEntries: number) {
  const abs = path.resolve(rootAbs, rel || '.')
  const rootResolved = path.resolve(rootAbs)
  if (!abs.startsWith(rootResolved)) return null
  const name = rel ? path.posix.basename(rel.replaceAll('\\', '/')) : '.'

  const node: any = { type: 'dir', name, path: rel || '.', children: [] as any[] }
  if (depth <= 0) return node

  let entries: any[] = []
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch {
    return node
  }

  for (const ent of entries) {
    if (node.children.length >= maxEntries) break
    const childRel = rel && rel !== '.' ? `${rel}/${ent.name}` : ent.name
    if (isBlockedForTree(childRel)) continue

    if (ent.isDirectory()) {
      const child = await readTree(rootAbs, childRel, depth - 1, maxEntries - node.children.length)
      if (child) node.children.push(child)
    } else {
      node.children.push({ type: 'file', name: ent.name, path: childRel })
    }
  }

  node.children.sort((a: any, b: any) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return String(a.name).localeCompare(String(b.name))
  })
  return node
}

async function runGit(root: string, args: string[]) {
  const r = await execFileAsync('git', args, { cwd: root })
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

async function runGitAllowFail(root: string, args: string[]) {
  try {
    const r = await execFileAsync('git', args, { cwd: root })
    return { ok: true as const, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
  } catch (e: any) {
    return {
      ok: false as const,
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? ''),
      message: String(e?.message ?? e),
    }
  }
}

export default defineConfig(({ mode }) => {
  // Load all env vars (including non-VITE_*) for dev-server proxy
  const env = loadEnv(mode, process.cwd(), '')
  const OPENAI_API_KEY = env.OPENAI_API_KEY
  const OPENAI_MODEL = env.OPENAI_MODEL || 'gpt-4o-mini'
  const ROOT = process.cwd()
  const SAW_DIR = path.join(ROOT, '.saw')
  const CAPS_PATH = path.join(SAW_DIR, 'caps.json')
  const SESSION_LOG = path.join(SAW_DIR, 'session.ndjson')

  async function loadCaps(): Promise<CapsManifest> {
    try {
      const raw = await fs.readFile(CAPS_PATH, 'utf8')
      const j = JSON.parse(raw) as CapsManifest
      if (j && j.version === 1 && Array.isArray(j.rules)) return j
    } catch {
      // ignore
    }
    return { version: 1, updatedAt: Date.now(), rules: [] }
  }

  async function saveCaps(m: CapsManifest) {
    await fs.mkdir(SAW_DIR, { recursive: true })
    await fs.writeFile(CAPS_PATH, JSON.stringify(m), 'utf8')
  }

  const RECOVERY_PATH = path.join(SAW_DIR, 'recovery.json')

  async function appendSession(event: any) {
    try {
      await fs.mkdir(SAW_DIR, { recursive: true })
      const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n'
      await fs.appendFile(SESSION_LOG, line, 'utf8')
    } catch {
      // ignore
    }
  }

  async function readSessionTail(maxLines: number) {
    try {
      const raw = await fs.readFile(SESSION_LOG, 'utf8')
      const lines = raw.trim().split('\n')
      return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
    } catch {
      return ''
    }
  }

  async function writeRecovery(data: any) {
    await fs.mkdir(SAW_DIR, { recursive: true })
    await fs.writeFile(RECOVERY_PATH, JSON.stringify(data), 'utf8')
  }

  async function clearRecovery() {
    try {
      await fs.writeFile(RECOVERY_PATH, JSON.stringify({ inProgress: false, updatedAt: Date.now() }), 'utf8')
    } catch {
      // ignore
    }
  }

  function getCapsForPath(m: CapsManifest, rel: string): CapsRule {
    // default: readable, not writable/deletable
    const def: CapsRule = { path: '*', r: true, w: false, d: false }
    const p = rel.replaceAll('\\', '/')

    let best: CapsRule | null = null
    let bestLen = -1
    for (const rule of m.rules) {
      const rp = String(rule.path || '').replaceAll('\\', '/')
      if (!rp) continue
      // Root rule: "." or "./" applies to everything.
      if (rp === '.' || rp === './') {
        if (1 > bestLen) {
          best = rule
          bestLen = 1
        }
        continue
      }
      if (rp.endsWith('/')) {
        if (p.startsWith(rp) && rp.length > bestLen) {
          best = rule
          bestLen = rp.length
        }
      } else {
        if (p === rp && rp.length > bestLen) {
          best = rule
          bestLen = rp.length
        }
      }
    }
    return best ?? def
  }

  async function validateProject(): Promise<{ ok: true } | { ok: false; output: string }> {
    try {
      const r = await execFileAsync('npm', ['run', 'build'], {
        cwd: ROOT,
        env: { ...process.env, npm_config_cache: path.join(ROOT, '.npm-cache') },
      })
      return { ok: true }
    } catch (e: any) {
      const out = String(e?.stdout ?? '') + '\n' + String(e?.stderr ?? '')
      return { ok: false, output: out.trim() }
    }
  }

  async function gitHead() {
    const r = await runGit(ROOT, ['rev-parse', 'HEAD'])
    return r.stdout.trim()
  }

  async function gitDirty() {
    const r = await runGit(ROOT, ['status', '--porcelain'])
    return r.stdout.trim()
  }

  async function gitStashPush() {
    await runGit(ROOT, ['stash', 'push', '-u', '-m', 'saw:auto-pre'])
    const r = await runGit(ROOT, ['rev-parse', 'refs/stash'])
    return r.stdout.trim()
  }

  async function gitStashPop() {
    return await runGit(ROOT, ['stash', 'pop'])
  }

  async function rollbackTo(head: string) {
    await runGit(ROOT, ['reset', '--hard', head])
    await runGit(ROOT, ['clean', '-fd'])
  }

  function parsePatchTouched(patch: string) {
    const touched = new Set<string>()
    const deleted = new Set<string>()
    const added = new Set<string>()
    const lines = patch.split('\n')
    for (const ln of lines) {
      const m1 = ln.match(/^\+\+\+\s+b\/(.+)$/)
      const m2 = ln.match(/^---\s+a\/(.+)$/)
      const m3 = ln.match(/^diff --git a\/(.+)\s+b\/(.+)$/)
      if (m3) touched.add(m3[2]!)
      if (m1) {
        if (m1[1] === '/dev/null') continue
        touched.add(m1[1]!)
      }
      if (m2) {
        if (m2[1] === '/dev/null') continue
        touched.add(m2[1]!)
      }
      if (ln.startsWith('deleted file mode ')) {
        // best-effort: deletion path captured by previous diff --git
      }
    }
    // Heuristic: detect /dev/null markers
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!
      const dm = ln.match(/^diff --git a\/(.+)\s+b\/(.+)$/)
      if (!dm) continue
      const a = dm[1]!
      const b = dm[2]!
      const next1 = lines[i + 1] ?? ''
      const next2 = lines[i + 2] ?? ''
      const header = next1 + '\n' + next2
      if (header.includes('--- a/') && header.includes('+++ /dev/null')) deleted.add(a)
      if (header.includes('--- /dev/null') && header.includes('+++ b/')) added.add(b)
    }
    return { touched: [...touched], deleted: [...deleted], added: [...added] }
  }

  return {
    plugins: [
      react(),
      {
        name: 'saw-openai-proxy',
        configureServer(server) {
          // Crash recovery: if a previous safe-apply crashed mid-flight, restore last-good.
          void (async () => {
            try {
              const raw = await fs.readFile(RECOVERY_PATH, 'utf8')
              const j = JSON.parse(raw) as any
              if (j?.inProgress && typeof j?.preHead === 'string' && j.preHead.length > 0) {
                await rollbackTo(j.preHead)
                  await appendSession({ type: 'recovery.rollback', preHead: j.preHead, op: j?.op ?? 'unknown' })
              }
              await clearRecovery()
            } catch {
              // ignore
            }
          })()

          server.middlewares.use(async (req, res, next) => {
            if (!req.url) return next()

            // -----------------------
            // Dev FS + Git endpoints
            // -----------------------
            if (req.method === 'GET' && req.url.startsWith('/api/dev/caps')) {
              const caps = await loadCaps()
              return json(res, 200, caps)
            }

            if (req.method === 'POST' && req.url.startsWith('/api/dev/caps')) {
              let body: { path: string; caps: { r: boolean; w: boolean; d: boolean } }
              try {
                body = (await readJson(req)) as { path: string; caps: { r: boolean; w: boolean; d: boolean } }
              } catch {
                return json(res, 400, { error: 'Invalid JSON body' })
              }
              const rel = String(body.path || '').replaceAll('\\', '/')
              const resolved = safeResolve(ROOT, rel)
              if (!resolved.ok) return json(res, 400, { error: 'invalid_path', reason: resolved.reason })

              const m = await loadCaps()
              const next: CapsRule = {
                path: rel,
                r: Boolean(body.caps?.r),
                w: Boolean(body.caps?.w),
                d: Boolean(body.caps?.d),
              }
              const idx = m.rules.findIndex((r) => r.path === rel)
              if (idx >= 0) m.rules[idx] = next
              else m.rules.push(next)
              m.updatedAt = Date.now()
              await saveCaps(m)
              await appendSession({ type: 'caps.set', path: rel, caps: next })
              return json(res, 200, m)
            }

            if (req.method === 'GET' && req.url.startsWith('/api/dev/session/log')) {
              const u = new URL(req.url, 'http://localhost')
              const tail = Math.max(10, Math.min(2000, Number(u.searchParams.get('tail') || 200)))
              const ndjson = await readSessionTail(tail)
              return json(res, 200, { tail, ndjson })
            }

            if (req.method === 'GET' && req.url.startsWith('/api/dev/tree')) {
              const u = new URL(req.url, 'http://localhost')
              const root = (u.searchParams.get('root') || '.').replaceAll('\\', '/')
              const depth = Math.max(1, Math.min(10, Number(u.searchParams.get('depth') || 6)))
              const maxEntries = Math.max(200, Math.min(10000, Number(u.searchParams.get('max') || 4000)))
              if (root !== '.' && isBlockedForTree(root)) return json(res, 400, { error: 'invalid_root' })
              const tree = await readTree(ROOT, root, depth, maxEntries)
              return json(res, 200, { root, depth, tree })
            }

            if (req.method === 'GET' && req.url.startsWith('/api/dev/file')) {
              const u = new URL(req.url, 'http://localhost')
              const rel = u.searchParams.get('path') || ''
              const resolved = safeResolve(ROOT, rel)
              if (!resolved.ok) return json(res, 400, { error: 'invalid_path', reason: resolved.reason })
              const caps = getCapsForPath(await loadCaps(), rel)
              if (!caps.r) return json(res, 403, { error: 'forbidden', op: 'read', path: rel })
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
              const caps = getCapsForPath(await loadCaps(), body.path)
              if (!caps.w) return json(res, 403, { error: 'forbidden', op: 'write', path: body.path })

              try {
                await fs.writeFile(resolved.abs, String(body.content ?? ''), 'utf8')
                // Trigger Vite's HMR pipeline without a full page reload (keeps app state).
                // This updates only the modules impacted by the changed file.
                server.watcher.emit('change', resolved.abs)
                await appendSession({ type: 'file.write', path: body.path, bytes: String(body.content ?? '').length })
                return json(res, 200, { ok: true })
              } catch (e: any) {
                return json(res, 500, { error: 'write_failed', details: String(e?.message ?? e) })
              }
            }

            // -----------------------
            // Safe apply pipeline
            // -----------------------
            if (req.method === 'POST' && req.url.startsWith('/api/dev/safe/write')) {
              let body: { path: string; content: string }
              try {
                body = (await readJson(req)) as { path: string; content: string }
              } catch {
                return json(res, 400, { error: 'Invalid JSON body' })
              }
              const rel = String(body.path || '').replaceAll('\\', '/')
              const resolved = safeResolve(ROOT, rel)
              if (!resolved.ok) return json(res, 400, { error: 'invalid_path', reason: resolved.reason })

              const caps = getCapsForPath(await loadCaps(), rel)
              if (!caps.w) {
                await appendSession({ type: 'safe.write.forbidden', path: rel })
                return json(res, 403, { error: 'forbidden', op: 'safe_write', path: rel })
              }

              const preHead = await gitHead()
              const dirty = await gitDirty()
              const hadStash = Boolean(dirty)
              let stashRef: string | null = null
              if (hadStash) stashRef = await gitStashPush()

              await writeRecovery({ inProgress: true, startedAt: Date.now(), preHead, hadStash, stashRef, op: 'write', path: rel })
              await appendSession({ type: 'safe.write.start', path: rel, preHead })
              try {
                await fs.writeFile(resolved.abs, String(body.content ?? ''), 'utf8')
                server.watcher.emit('change', resolved.abs)

                const v = await validateProject()
                if (!v.ok) {
                  await rollbackTo(preHead)
                  if (hadStash) await gitStashPop().catch(() => null)
                  await clearRecovery()
                await appendSession({ type: 'safe.write.rollback', path: rel, reason: 'validation_failed', output: v.output.slice(0, 4000) })
                  return json(res, 400, { error: 'validation_failed', output: v.output })
                }

                if (hadStash) {
                  const pop = await gitStashPop().catch((e) => ({ stderr: String(e) } as any))
                  // If conflicts, leave stash as-is (git will tell in stderr)
                  void pop
                }
                await clearRecovery()
                await appendSession({ type: 'safe.write.ok', path: rel })
                return json(res, 200, { ok: true })
              } catch (e: any) {
                await rollbackTo(preHead).catch(() => null)
                if (hadStash) await gitStashPop().catch(() => null)
                await clearRecovery()
                await appendSession({ type: 'safe.write.rollback', path: rel, reason: 'exception', details: String(e?.message ?? e).slice(0, 2000) })
                return json(res, 500, { error: 'safe_write_failed', details: String(e?.message ?? e) })
              }
            }

            if (req.method === 'POST' && req.url.startsWith('/api/dev/safe/delete')) {
              let body: { path: string }
              try {
                body = (await readJson(req)) as { path: string }
              } catch {
                return json(res, 400, { error: 'Invalid JSON body' })
              }
              const rel = String(body.path || '').replaceAll('\\', '/')
              const resolved = safeResolve(ROOT, rel)
              if (!resolved.ok) return json(res, 400, { error: 'invalid_path', reason: resolved.reason })
              const caps = getCapsForPath(await loadCaps(), rel)
              if (!caps.d) {
                await appendSession({ type: 'safe.delete.forbidden', path: rel })
                return json(res, 403, { error: 'forbidden', op: 'safe_delete', path: rel })
              }

              const preHead = await gitHead()
              const dirty = await gitDirty()
              const hadStash = Boolean(dirty)
              let stashRef: string | null = null
              if (hadStash) stashRef = await gitStashPush()
              await writeRecovery({ inProgress: true, startedAt: Date.now(), preHead, hadStash, stashRef, op: 'delete', path: rel })
              await appendSession({ type: 'safe.delete.start', path: rel, preHead })

              try {
                await fs.rm(resolved.abs, { force: true })
                server.watcher.emit('change', resolved.abs)

                const v = await validateProject()
                if (!v.ok) {
                  await rollbackTo(preHead)
                  if (hadStash) await gitStashPop().catch(() => null)
                  await clearRecovery()
                  await appendSession({ type: 'safe.delete.rollback', path: rel, reason: 'validation_failed', output: v.output.slice(0, 4000) })
                  return json(res, 400, { error: 'validation_failed', output: v.output })
                }

                if (hadStash) await gitStashPop().catch(() => null)
                await clearRecovery()
                await appendSession({ type: 'safe.delete.ok', path: rel })
                return json(res, 200, { ok: true })
              } catch (e: any) {
                await rollbackTo(preHead).catch(() => null)
                if (hadStash) await gitStashPop().catch(() => null)
                await clearRecovery()
                await appendSession({ type: 'safe.delete.rollback', path: rel, reason: 'exception', details: String(e?.message ?? e).slice(0, 2000) })
                return json(res, 500, { error: 'safe_delete_failed', details: String(e?.message ?? e) })
              }
            }

            if (req.method === 'POST' && req.url.startsWith('/api/dev/safe/applyPatch')) {
              let body: { patch: string }
              try {
                body = (await readJson(req)) as { patch: string }
              } catch {
                return json(res, 400, { error: 'Invalid JSON body' })
              }
              const patch = String(body.patch ?? '')
              if (!patch.trim()) return json(res, 400, { error: 'empty_patch' })
              if (!patch.includes('--- ') || !patch.includes('+++ ')) {
                await appendSession({ type: 'safe.patch.reject', reason: 'invalid_diff_missing_headers' })
                return json(res, 400, { error: 'invalid_diff', details: 'Patch must include --- / +++ headers (unified diff).' })
              }

              const parsed = parsePatchTouched(patch)
              const manifest = await loadCaps()
              for (const p of parsed.touched) {
                const resolved = safeResolve(ROOT, p)
                if (!resolved.ok) return json(res, 400, { error: 'invalid_path', path: p, reason: resolved.reason })
                const caps = getCapsForPath(manifest, p)
                if (!caps.w) {
                  await appendSession({ type: 'safe.patch.forbidden', op: 'write', path: p })
                  return json(res, 403, { error: 'forbidden', op: 'safe_patch_write', path: p })
                }
              }
              for (const p of parsed.deleted) {
                const resolved = safeResolve(ROOT, p)
                if (!resolved.ok) return json(res, 400, { error: 'invalid_path', path: p, reason: resolved.reason })
                const caps = getCapsForPath(manifest, p)
                if (!caps.d) {
                  await appendSession({ type: 'safe.patch.forbidden', op: 'delete', path: p })
                  return json(res, 403, { error: 'forbidden', op: 'safe_patch_delete', path: p })
                }
              }

              const preHead = await gitHead()
              const dirty = await gitDirty()
              const hadStash = Boolean(dirty)
              let stashRef: string | null = null
              if (hadStash) stashRef = await gitStashPush()
              await writeRecovery({ inProgress: true, startedAt: Date.now(), preHead, hadStash, stashRef, op: 'applyPatch', touched: parsed })
              await appendSession({ type: 'safe.patch.start', preHead, touched: parsed.touched, deleted: parsed.deleted })

              const tmpPatch = path.join(SAW_DIR, `tmp_${Date.now()}.patch`)
              try {
                await fs.mkdir(SAW_DIR, { recursive: true })
                await fs.writeFile(tmpPatch, patch, 'utf8')
                // Pre-check so invalid patches don't trigger rollback/reloads.
                const chk = await runGitAllowFail(ROOT, ['apply', '--check', '--whitespace=nowarn', tmpPatch])
                if (!chk.ok) {
                  const preview = patch.split('\n').slice(0, 24).join('\n')
                  await appendSession({
                    type: 'safe.patch.reject',
                    reason: 'apply_check_failed',
                    message: chk.message.slice(0, 2000),
                    stderr: chk.stderr.slice(0, 2000),
                    preview,
                  })
                  if (hadStash) await gitStashPop().catch(() => null)
                  await clearRecovery()
                  return json(res, 400, { error: 'patch_check_failed', details: chk.stderr || chk.message })
                }

                const ap = await runGitAllowFail(ROOT, ['apply', '--whitespace=nowarn', tmpPatch])
                if (!ap.ok) {
                  const preview = patch.split('\n').slice(0, 24).join('\n')
                  await appendSession({
                    type: 'safe.patch.reject',
                    reason: 'apply_failed',
                    message: ap.message.slice(0, 2000),
                    stderr: ap.stderr.slice(0, 2000),
                    preview,
                  })
                  await rollbackTo(preHead).catch(() => null)
                  if (hadStash) await gitStashPop().catch(() => null)
                  await clearRecovery()
                  return json(res, 400, { error: 'patch_apply_failed', details: ap.stderr || ap.message })
                }
                for (const p of parsed.touched) {
                  const resolved = safeResolve(ROOT, p)
                  if (resolved.ok) server.watcher.emit('change', resolved.abs)
                }

                const v = await validateProject()
                if (!v.ok) {
                  await rollbackTo(preHead)
                  if (hadStash) await gitStashPop().catch(() => null)
                  await clearRecovery()
                  await appendSession({ type: 'safe.patch.rollback', reason: 'validation_failed', output: v.output.slice(0, 4000) })
                  return json(res, 400, { error: 'validation_failed', output: v.output })
                }

                if (hadStash) await gitStashPop().catch(() => null)
                await clearRecovery()
                await appendSession({ type: 'safe.patch.ok', touched: parsed.touched })
                return json(res, 200, { ok: true, touched: parsed.touched })
              } catch (e: any) {
                await rollbackTo(preHead).catch(() => null)
                if (hadStash) await gitStashPop().catch(() => null)
                await clearRecovery()
                await appendSession({ type: 'safe.patch.rollback', reason: 'exception', details: String(e?.message ?? e).slice(0, 2000) })
                return json(res, 500, { error: 'safe_patch_failed', details: String(e?.message ?? e) })
              } finally {
                await fs.rm(tmpPatch, { force: true }).catch(() => null)
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
                await appendSession({ type: 'git.commit', message: msg })
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
                'You are SAW Assistant inside a live dev environment.',
                'You CAN propose code/file changes by outputting a unified diff, and the UI can apply it safely.',
                'You are given prior chat messages + a context block that may include: repo_index_root, repo_index_src, attached_files, recent_logs_tail, recent_errors_tail, recent_session_tail.',
                'Treat those blocks as your visible environment. Do NOT claim you cannot see files/history if those blocks are present.',
                '',
                'When the user asks to modify files/code (edit/add/remove/rename/fix/refactor/commit/create/write):',
                '- Output ONLY a single ```diff``` fenced block containing a unified diff (git style).',
                '- IMPORTANT: Do NOT output placeholders like "New file: path". Always output a real unified diff.',
                '- For creating a new file, you MUST include these header lines (even if empty):',
                '  diff --git a/<path> b/<path>',
                '  new file mode 100644',
                '  index 0000000..e69de29',
                '  --- /dev/null',
                '  +++ b/<path>',
                '- Prefer minimal changes.',
                '- Touch only files mentioned by the user or clearly relevant.',
                '- Do not mention that you "cannot" modify files; instead provide the diff.',
                '- If a commit is requested, add a final line AFTER the diff: COMMIT_MESSAGE: <message>',
                '',
                'When the user is asking general questions (no edits): respond normally, concise.',
                'If the user asks "what files can you see?", answer using repo_index_root/repo_index_src and attached_files.',
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


