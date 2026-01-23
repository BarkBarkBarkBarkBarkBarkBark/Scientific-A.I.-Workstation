import Editor from '@monaco-editor/react'
import { useEffect, useMemo, useState } from 'react'
import { useSawStore } from '../store/useSawStore'
import { Panel } from './ui/Panel'
import { ResizableDivider } from './ui/ResizableDivider'

function joinDiffs(diffs: string[]) {
  const parts = diffs
    .map((d) => String(d ?? '').trim())
    .filter(Boolean)
    .map((d) => (d.endsWith('\n') ? d : d + '\n'))
  return parts.join('\n')
}

export function PatchReviewModal() {
  const patchReview = useSawStore((s) => s.patchReview)
  const closePatchReview = useSawStore((s) => s.closePatchReview)
  const applyPatchProposal = useSawStore((s) => s.applyPatchProposal)
  const layout = useSawStore((s) => s.layout)
  const setLayout = useSawStore((s) => s.setLayout)

  const proposal = patchReview.proposal
  const files = proposal?.files ?? []

  const [selectedPath, setSelectedPath] = useState<string>('')
  const [commitMsg, setCommitMsg] = useState<string>('')
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth))

  const selected = useMemo(() => {
    if (!proposal) return null
    const p = selectedPath || files[0]?.path || ''
    return files.find((f) => f.path === p) ?? files[0] ?? null
  }, [files, proposal, selectedPath])

  useEffect(() => {
    if (!patchReview.open) return
    setSelectedPath(files[0]?.path ?? '')
    setCommitMsg(proposal ? `SAW: ${proposal.summary || 'apply patch'}` : 'SAW: apply patch')
    setVw(typeof window === 'undefined' ? 1200 : window.innerWidth)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePatchReview()
    }
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchReview.open])

  if (!patchReview.open || !proposal) return null

  const allDiff = joinDiffs(files.map((f) => f.diff))

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6">
      <div className="h-[86vh] w-[92vw] max-w-[1600px]">
        <Panel
          title={`Patch Review — ${proposal.id}`}
          right={
            <div className="flex items-center gap-2">
              <div className="text-[11px] text-zinc-500">
                risk:{' '}
                <span className="font-semibold text-zinc-200">{proposal.risk}</span>
              </div>
              <button
                type="button"
                onClick={closePatchReview}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
              >
                Close (Esc)
              </button>
            </div>
          }
          className="h-full overflow-hidden"
        >
          <div
            className="grid h-full min-h-0 gap-2 p-2"
            style={{ gridTemplateColumns: `${layout.patchReviewFilesWidth}px 12px 1fr` }}
          >
            <Panel title={`Files (${files.length})`} className="min-h-0 overflow-hidden">
              <div className="h-full overflow-auto p-2">
                <div className="space-y-1">
                  {files.map((f) => {
                    const active = f.path === (selected?.path ?? '')
                    return (
                      <button
                        key={f.path}
                        type="button"
                        onClick={() => setSelectedPath(f.path)}
                        className={[
                          'w-full rounded-md border px-2 py-1.5 text-left text-[11px] font-mono transition',
                          active
                            ? 'border-emerald-700 bg-emerald-900/20 text-zinc-100'
                            : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                        ].join(' ')}
                        title={f.path}
                      >
                        {f.path}
                      </button>
                    )
                  })}
                </div>
              </div>
            </Panel>

            <div className="rounded-md border border-zinc-800 bg-zinc-950/40">
              <ResizableDivider
                orientation="vertical"
                value={layout.patchReviewFilesWidth}
                setValue={(v) => setLayout({ patchReviewFilesWidth: v })}
                min={240}
                max={Math.max(320, vw - 520)}
              />
            </div>

            <div className="min-h-0 space-y-2">
              <Panel title="Summary" className="overflow-hidden">
                <div className="space-y-2 p-3 text-sm">
                  <div className="text-zinc-100">{proposal.summary || '(no summary)'}</div>
                  <div className="text-xs text-zinc-500">Scope: {proposal.scope.domain}</div>
                  {proposal.rationale ? (
                    <div className="text-xs text-zinc-400">{proposal.rationale}</div>
                  ) : null}
                  {proposal.validation_steps?.length ? (
                    <div className="text-xs text-zinc-500">
                      validations:
                      <ul className="mt-1 list-disc pl-4">
                        {proposal.validation_steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="text-xs text-zinc-500">validations: (none)</div>
                  )}
                </div>
              </Panel>

              <Panel title={selected ? `Unified diff — ${selected.path}` : 'Unified diff'} className="min-h-0 overflow-hidden">
                <div className="h-[46vh] overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
                  <Editor
                    height="100%"
                    defaultLanguage="diff"
                    theme="vs-dark"
                    value={selected?.diff ?? ''}
                    options={{
                      readOnly: true,
                      fontSize: 12,
                      minimap: { enabled: false },
                      wordWrap: 'off',
                      scrollBeyondLastLine: false,
                    }}
                  />
                </div>
              </Panel>

              <Panel title="Actions" className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 p-3">
                  <button
                    type="button"
                    disabled={patchReview.busy}
                    onClick={async () => {
                      await applyPatchProposal({ commit: false })
                    }}
                    className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
                  >
                    Accept Apply
                  </button>
                  <button
                    type="button"
                    disabled={patchReview.busy}
                    onClick={async () => {
                      await applyPatchProposal({ commit: true, commitMessage: commitMsg })
                    }}
                    className="rounded-md border border-emerald-700 bg-emerald-900/20 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/30 disabled:opacity-50"
                  >
                    Apply + Commit
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(allDiff)
                      } catch {
                        // ignore
                      }
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
                    title="Copy concatenated unified diff to clipboard"
                  >
                    Copy diff
                  </button>

                  <div className="ml-auto flex min-w-[360px] flex-1 items-center gap-2">
                    <div className="text-[11px] text-zinc-500">commit</div>
                    <input
                      value={commitMsg}
                      onChange={(e) => setCommitMsg(e.target.value)}
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      placeholder="Commit message"
                    />
                  </div>

                  {patchReview.lastError ? (
                    <div className="w-full text-[11px] text-rose-300">
                      {patchReview.lastError}
                    </div>
                  ) : null}
                </div>
              </Panel>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}


