import type { SawState } from '../storeTypes'
import { normalizePatchText } from '../utils/patch'

export function createDevOpsSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<
  SawState,
  | 'dev'
  | 'devAttachPath'
  | 'devDetachPath'
  | 'devClearAttachments'
  | 'applyPatch'
  | 'commitAll'
  | 'grantWriteCaps'
  | 'clearLastForbidden'
> {
  return {
    dev: { attachedPaths: [] },

    devAttachPath: (path: string) => {
      const p = String(path || '').replaceAll('\\', '/')
      if (!p) return
      set((s) => {
        if (s.dev.attachedPaths.includes(p)) return s
        return { dev: { ...s.dev, attachedPaths: [...s.dev.attachedPaths, p] } }
      })
    },

    devDetachPath: (path: string) => {
      const p = String(path || '').replaceAll('\\', '/')
      set((s) => ({ dev: { ...s.dev, attachedPaths: s.dev.attachedPaths.filter((x) => x !== p) } }))
    },

    devClearAttachments: () => set((s) => ({ dev: { ...s.dev, attachedPaths: [] } })),

    clearLastForbidden: () => set((s) => ({ dev: { ...s.dev, lastForbidden: null } })),

    grantWriteCaps: async (rulePath: string) => {
      const p = String(rulePath || '').replaceAll('\\', '/').trim()
      if (!p) return { ok: false, error: 'missing_path' }
      try {
        const r = await fetch('/api/dev/caps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p, caps: { r: true, w: true, d: false } }),
        })
        if (!r.ok) {
          const t = await r.text()
          set((s) => ({
            bottomTab: 'errors',
            errors: [...s.errors, `CapsError: ${t}`],
            errorLog: [...s.errorLog, { ts: Date.now(), tag: 'caps', text: `CapsError: ${t}` }],
          }))
          return { ok: false, error: t }
        }
        set((s) => ({
          logs: [...s.logs, `[caps] enabled W for "${p}"`],
          dev: { ...s.dev, lastForbidden: null },
        }))
        return { ok: true }
      } catch (e: any) {
        const msg = String(e?.message ?? e)
        set((s) => ({
          bottomTab: 'errors',
          errors: [...s.errors, `CapsError: ${msg}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'caps', text: `CapsError: ${msg}` }],
        }))
        return { ok: false, error: msg }
      }
    },

    applyPatch: async (patch: string) => {
      try {
        const p = normalizePatchText(patch)
        const r = await fetch('/api/dev/safe/applyPatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patch: p }),
        })
        if (!r.ok) {
          const t = await r.text()
          set((s) => ({
            bottomTab: 'errors',
            errors: [...s.errors, `SafePatchError: ${t}`],
            errorLog: [...s.errorLog, { ts: Date.now(), tag: 'safePatch', text: `SafePatchError: ${t}` }],
          }))

          // Friendlier guidance when blocked by caps
          try {
            const j = JSON.parse(t) as any
            if (j?.error === 'forbidden' && typeof j?.path === 'string') {
              set((s) => ({ dev: { ...s.dev, lastForbidden: { op: String(j?.op ?? ''), path: j.path, patch: p } } }))
              set((s) => ({
                chat: {
                  ...s.chat,
                  messages: [
                    ...s.chat.messages,
                    {
                      role: 'assistant',
                      content:
                        `Blocked by capabilities (write disabled).\n\n` +
                        `Path: ${j.path}\n\n` +
                        `Fix: Console → Dev → Capabilities.\n` +
                        `- Set Rule path to "${j.path}" (or "." to allow root)\n` +
                        `- Enable W\n` +
                        `- Retry Apply patch`,
                    },
                  ],
                },
              }))
            }
            if (j?.error === 'target_dirty' && Array.isArray(j?.paths) && j.paths.length) {
              set((s) => ({
                chat: {
                  ...s.chat,
                  messages: [
                    ...s.chat.messages,
                    {
                      role: 'assistant',
                      content:
                        `Apply patch blocked (target has local edits).\n\n` +
                        `Paths:\n- ${j.paths.map((x: any) => String(x)).join('\n- ')}\n\n` +
                        `Fix:\n- Revert/commit those files, then retry Apply patch.`,
                    },
                  ],
                },
              }))
            }
          } catch {
            // ignore
          }

          set((s) => ({
            chat: { ...s.chat, messages: [...s.chat.messages, { role: 'assistant', content: `Apply patch failed:\n${t}` }] },
          }))
          return { ok: false, error: t }
        }
        set((s) => ({ logs: [...s.logs, '[safe] patch applied'] }))
        return { ok: true }
      } catch (e: any) {
        const msg = String(e?.message ?? e)
        set((s) => ({
          bottomTab: 'errors',
          errors: [...s.errors, `SafePatchError: ${msg}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'safePatch', text: `SafePatchError: ${msg}` }],
        }))
        set((s) => ({
          chat: { ...s.chat, messages: [...s.chat.messages, { role: 'assistant', content: `Apply patch failed:\n${msg}` }] },
        }))
        return { ok: false, error: msg }
      }
    },

    commitAll: async (message: string) => {
      try {
        const msg = String(message ?? '').trim()
        if (!msg) return { ok: false, error: 'missing_commit_message' }
        const r = await fetch('/api/dev/git/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        })
        if (!r.ok) {
          const t = await r.text()
          set((s) => ({
            bottomTab: 'errors',
            errors: [...s.errors, `CommitError: ${t}`],
            errorLog: [...s.errorLog, { ts: Date.now(), tag: 'git', text: `CommitError: ${t}` }],
          }))
          set((s) => ({
            chat: { ...s.chat, messages: [...s.chat.messages, { role: 'assistant', content: `Commit failed:\n${t}` }] },
          }))
          return { ok: false, error: t }
        }
        set((s) => ({ logs: [...s.logs, `[git] committed: ${msg}`] }))
        set((s) => ({
          chat: { ...s.chat, messages: [...s.chat.messages, { role: 'assistant', content: `Committed:\n${msg}` }] },
        }))
        return { ok: true }
      } catch (e: any) {
        const msg = String(e?.message ?? e)
        set((s) => ({
          bottomTab: 'errors',
          errors: [...s.errors, `CommitError: ${msg}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'git', text: `CommitError: ${msg}` }],
        }))
        set((s) => ({
          chat: { ...s.chat, messages: [...s.chat.messages, { role: 'assistant', content: `Commit failed:\n${msg}` }] },
        }))
        return { ok: false, error: msg }
      }
    },
  }
}
