import { useEffect, useMemo, useState } from 'react'
import { useSawStore } from '../store/useSawStore'
import { parsePatchProposalFromAssistant } from '../patching/parsePatchProposal'

function normalizeNewFileShorthand(text: string): string | null {
  // Accept a very small shorthand to keep the UX robust when the model slips.
  // Example:
  // ```diff
  // New file: machine-doc/test.md
  // ```
  const m = text.match(/^\s*New file:\s*([^\n\r]+)\s*$/m)
  if (!m?.[1]) return null
  const p = m[1].trim().replaceAll('\\', '/')
  if (!p || p.includes('\0') || p.startsWith('..') || p.includes('/../')) return null
  return [
    `diff --git a/${p} b/${p}`,
    'new file mode 100644',
    'index 0000000..e69de29',
    '--- /dev/null',
    `+++ b/${p}`,
    '',
  ].join('\n')
}

function extractDiff(text: string): string | null {
  const m = text.match(/```diff\s*([\s\S]*?)```/m)
  if (m?.[1]) {
    const d = m[1].trim()
    const normalized = normalizeNewFileShorthand(d)
    if (normalized) return normalized
    // Basic sanity: unified diffs should include ---/+++ lines.
    if (!/^\s*---\s+/m.test(d) || !/^\s*\+\+\+\s+/m.test(d)) return null
    return d
  }
  const idx = text.indexOf('diff --git ')
  if (idx >= 0) {
    const d = text.slice(idx).trim()
    if (!/^\s*---\s+/m.test(d) || !/^\s*\+\+\+\s+/m.test(d)) return null
    return d
  }
  return null
}

function extractCommitMessage(text: string): string | null {
  const m = text.match(/COMMIT_MESSAGE:\s*(.+)\s*$/m)
  return m?.[1]?.trim() ?? null
}

export function ChatPanel() {
  const [text, setText] = useState('')
  const [patchMode, setPatchMode] = useState(false)
  const [openaiEnabled, setOpenaiEnabled] = useState<boolean | null>(null)

  const messages = useSawStore((s) => s.chat.messages)
  const pendingTool = useSawStore((s) => s.chat.pendingTool)
  const approvePendingTool = useSawStore((s) => s.approvePendingTool)
  const busy = useSawStore((s) => s.chatBusy)
  const sendChat = useSawStore((s) => s.sendChat)
  const provider = useSawStore((s) => s.chat.provider ?? null)
  const desiredProvider = useSawStore((s) => s.chat.desiredProvider ?? 'copilot')
  const setChatProvider = useSawStore((s) => s.setChatProvider)
  const streamMode = useSawStore((s) => s.chat.streamMode ?? 'json')
  const attached = useSawStore((s) => s.dev.attachedPaths)
  const devClearAttachments = useSawStore((s) => s.devClearAttachments)
  const applyPatch = useSawStore((s) => s.applyPatch)
  const commitAll = useSawStore((s) => s.commitAll)
  const openPatchReviewFromMessage = useSawStore((s) => s.openPatchReviewFromMessage)
  const lastForbidden = useSawStore((s) => s.dev.lastForbidden ?? null)
  const grantWriteCaps = useSawStore((s) => s.grantWriteCaps)
  const clearLastForbidden = useSawStore((s) => s.clearLastForbidden)

  const view = useMemo(() => {
    return messages.filter((m) => m.role !== 'system')
  }, [messages])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/saw/health')
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as any
        if (!cancelled) setOpenaiEnabled(Boolean(j?.openai_enabled))
      } catch {
        if (!cancelled) setOpenaiEnabled(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-3">
        <div className="relative mb-3">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-md bg-zinc-950/70 backdrop-blur-md"
          />
          <div className="relative flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-transparent px-2 py-1 text-[11px] text-zinc-400">
            <div>
              agent: <span className="font-mono text-zinc-200">{provider || 'unknown'}</span>
              <span className="text-zinc-700">/</span>
              selected: <span className="font-mono text-zinc-200">{desiredProvider}</span>
            </div>
            <div className="text-zinc-700">•</div>
            <div className="flex items-center gap-1">
              use:
              <button
                type="button"
                disabled={busy}
                onClick={() => setChatProvider('copilot')}
                className={[
                  'rounded border px-2 py-1 text-[11px] font-semibold disabled:opacity-50',
                  desiredProvider === 'copilot'
                    ? 'border-zinc-600 bg-zinc-900 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-900',
                ].join(' ')}
                title="Route the next chat request to Copilot"
              >
                Copilot
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setChatProvider('openai')}
                className={[
                  'rounded border px-2 py-1 text-[11px] font-semibold disabled:opacity-50',
                  desiredProvider === 'openai'
                    ? 'border-zinc-600 bg-zinc-900 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-900',
                ].join(' ')}
                title="Route the next chat request to OpenAI"
              >
                OpenAI
              </button>
            </div>
            <div className="text-zinc-700">•</div>
            <div>
              stream: <span className="font-mono text-zinc-200">{streamMode}</span>
            </div>
            <div className="text-zinc-700">•</div>
            <div>
              openai key:{' '}
              {openaiEnabled === null ? (
                <span className="font-mono text-zinc-500">unknown</span>
              ) : openaiEnabled ? (
                <span className="font-mono text-emerald-400">configured</span>
              ) : (
                <span className="font-mono text-zinc-500">missing</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        <div
          aria-hidden
          className="pointer-events-none sticky top-0 z-10 -mx-3 h-6 bg-gradient-to-b from-zinc-950/90 to-transparent backdrop-blur"
        />

        {lastForbidden?.path && (
          <div className="mb-3 rounded-md border border-amber-900/40 bg-amber-950/20 p-2 text-[11px] text-amber-100">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">Permission required</div>
              <button
                type="button"
                onClick={clearLastForbidden}
                className="rounded border border-amber-900/40 bg-zinc-950 px-2 py-1 text-[11px] text-amber-100 hover:bg-zinc-900"
              >
                Dismiss
              </button>
            </div>
            <div className="mt-1 text-amber-200">
              blocked: <span className="font-mono">{lastForbidden.path}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const r = await grantWriteCaps(lastForbidden.path)
                  if (!r.ok) return
                  if (lastForbidden.patch) await applyPatch(lastForbidden.patch)
                }}
                className="rounded-md bg-amber-500 px-2 py-1 text-[11px] font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
              >
                Enable W for this path + retry
              </button>
              {lastForbidden.path.includes('/') && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    const dir = lastForbidden.path.split('/').slice(0, -1).join('/') + '/'
                    const r = await grantWriteCaps(dir)
                    if (!r.ok) return
                    if (lastForbidden.patch) await applyPatch(lastForbidden.patch)
                  }}
                  className="rounded-md border border-amber-900/40 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-zinc-900 disabled:opacity-50"
                >
                  Enable W for directory + retry
                </button>
              )}
              {!lastForbidden.path.includes('/') && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    const r = await grantWriteCaps('.')
                    if (!r.ok) return
                    if (lastForbidden.patch) await applyPatch(lastForbidden.patch)
                  }}
                  className="rounded-md border border-amber-900/40 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-zinc-900 disabled:opacity-50"
                >
                  Enable W for root (.) + retry
                </button>
              )}
            </div>
            <div className="mt-1 text-amber-200">
              This keeps SAW safe-by-default but lets you approve changes with one click.
            </div>
          </div>
        )}
        {attached.length > 0 && (
          <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-[11px] text-zinc-300">
            <div className="flex items-center justify-between gap-2">
              <div>
                attached: <span className="font-mono text-zinc-100">{attached.length}</span>
              </div>
              <button
                type="button"
                onClick={devClearAttachments}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-900"
              >
                Clear
              </button>
            </div>
            <div className="mt-1 text-zinc-500">
              These files will be sent as context (server enforces read caps).
            </div>
          </div>
        )}
        <div className="space-y-2">
          {view.map((m, i) => (
            <div
              key={i}
              className={[
                'rounded-md border p-2 text-sm',
                m.role === 'user'
                  ? 'border-zinc-800 bg-zinc-950/40 text-zinc-100'
                  : 'border-emerald-900/40 bg-emerald-950/20 text-zinc-100',
              ].join(' ')}
            >
              <div className="mb-1 text-[11px] font-semibold text-zinc-500">
                {m.role === 'user' ? 'You' : 'SAW'}
              </div>
              <div className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</div>
              {m.role === 'assistant' && parsePatchProposalFromAssistant(m.content).ok && (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openPatchReviewFromMessage(m.content)}
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
                    title="Review per-file diffs before applying"
                  >
                    Review patch
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const patch = extractDiff(m.content)
                      if (!patch) return
                      await applyPatch(patch)
                    }}
                    className="rounded-md bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
                    title="Apply patch via safe pipeline (validates + rolls back on failure)"
                  >
                    Apply patch
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const patch = extractDiff(m.content)
                      if (!patch) return
                      const r = await applyPatch(patch)
                      if (!r.ok) return
                      const msg = extractCommitMessage(m.content) || 'SAW: apply patch'
                      await commitAll(msg)
                    }}
                    className="rounded-md border border-emerald-700 bg-emerald-900/20 px-2 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-900/30 disabled:opacity-50"
                    title="Apply patch then commit (stages all changes)"
                  >
                    Apply + Commit
                  </button>
                  <div className="text-[11px] text-zinc-500">
                    uses safe apply (validates; auto-rollback on fail)
                  </div>
                </div>
              )}
              {m.role === 'assistant' && !extractDiff(m.content) && extractCommitMessage(m.content) && (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const msg = extractCommitMessage(m.content)
                      if (!msg) return
                      await commitAll(msg)
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
                    title="Commit current working tree state (stages all changes)"
                  >
                    Commit
                  </button>
                  <div className="text-[11px] text-zinc-500">stages all changes</div>
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="text-xs text-zinc-500">Thinking…</div>
          )}
        </div>
      </div>

      {pendingTool?.id && (
        <div className="border-t border-emerald-900/30 bg-emerald-950/10 p-3">
          <div className="rounded-md border border-emerald-900/40 bg-emerald-950/20 p-2 text-[11px] text-zinc-100">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">Approval required</div>
              <div className="font-mono text-zinc-300">{pendingTool.name}</div>
            </div>
            <pre className="mt-2 max-h-[180px] overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-200">
              {JSON.stringify(pendingTool.arguments ?? {}, null, 2)}
            </pre>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void approvePendingTool(true)}
                className="rounded-md bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
              >
                Approve + run
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void approvePendingTool(false)}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      <form
        className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/40 p-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const msg = text.trim()
          if (!msg) return
          setText('')
          const editIntent =
            /\b(edit|change|modify|add|remove|delete|rename|fix|refactor|commit|patch|create|make|write|append|new\s+file)\b/i.test(
              msg,
            )
          // NOTE: Chat now uses a server-side tool-calling agent; do NOT wrap with PROPOSE_PATCH,
          // because it encourages raw diffs that can be malformed and fail Patch Engine checks.
          // Keep the toggle for now but treat it as a UI hint only.
          void editIntent
          await sendChat(msg)
        }}
      >
        <button
          type="button"
          onClick={() => setPatchMode((v) => !v)}
          className={[
            'rounded-md border px-2 py-2 text-xs font-semibold',
            patchMode
              ? 'border-emerald-700 bg-emerald-900/20 text-emerald-200'
              : 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900',
          ].join(' ')}
          title="When enabled, sends a patch-format request and expects a unified diff response."
        >
          Patch
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask SAW… (e.g. ‘How do I connect audio_lowpass to plot?’)"
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  )
}


