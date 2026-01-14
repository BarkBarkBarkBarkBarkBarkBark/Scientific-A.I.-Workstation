import { useMemo } from 'react'
import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'

export function Inspector() {
  const nodes = useSawStore((s) => s.nodes)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)
  const rightCollapsed = useSawStore((s) => s.layout.rightCollapsed)
  const toggleRightSidebar = useSawStore((s) => s.toggleRightSidebar)

  const steps = useMemo(() => {
    return nodes.map((node, idx) => {
      const plugin = pluginCatalog.find((p) => p.id === node.data.pluginId) ?? null
      const last = node.data.runtime?.exec?.last ?? null
      const outputs = (last?.outputs ?? {}) as any
      return {
        idx,
        node,
        plugin,
        outputs,
        lastOk: last?.ok ?? null,
      }
    })
  }, [nodes, pluginCatalog])

  if (rightCollapsed) {
    return (
      <Panel
        title="Outputs"
        right={
          <button
            type="button"
            onClick={toggleRightSidebar}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Expand Outputs"
          >
            Expand
          </button>
        }
        className="min-h-0 overflow-hidden"
      >
        <div className="flex h-full items-center justify-center p-2">
          <button
            type="button"
            onClick={toggleRightSidebar}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Expand Outputs"
          >
            ‹
          </button>
        </div>
      </Panel>
    )
  }

  return (
    <Panel
      title="Outputs"
      right={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleRightSidebar}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Minimize Outputs"
          >
            Minimize
          </button>
        </div>
      }
      className="min-h-0 overflow-hidden"
    >
      <div className="min-h-0 overflow-y-auto p-3">
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs font-semibold tracking-wide text-zinc-200">Dynamic outputs</div>
          <div className="mt-1 text-xs text-zinc-500">
            Copy a token like <span className="font-mono text-zinc-300">{'{{steps.1.rolls}}'}</span> and paste it into a later input/param.
          </div>
        </div>

        {steps.length === 0 ? (
          <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-sm text-zinc-400">
            No modules yet.
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {steps.map((s) => {
              const stepNum = s.idx + 1
              const outs = s.plugin?.outputs ?? []
              const statusBadge =
                s.lastOk == null ? '—' : s.lastOk ? 'ok' : 'error'

              return (
                <div key={s.node.id} className="rounded-md border border-zinc-800 bg-zinc-950/30 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-zinc-100">
                        step {stepNum}: {s.plugin?.name ?? s.node.data.pluginId}
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-500">
                        {s.plugin?.id ?? s.node.data.pluginId} • last: {statusBadge}
                      </div>
                    </div>
                  </div>

                  {outs.length === 0 ? (
                    <div className="mt-2 text-[11px] text-zinc-500">No declared outputs.</div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {outs.map((o) => {
                        const token = `{{steps.${stepNum}.${o.id}}}`
                        const raw = s.outputs?.[o.id]
                        const preview =
                          raw == null
                            ? '—'
                            : typeof raw === 'string'
                              ? raw
                              : JSON.stringify(raw)

                        return (
                          <div key={o.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-zinc-200">
                                  {o.name} <span className="text-[11px] font-normal text-zinc-500">({o.type})</span>
                                </div>
                                <div className="mt-1 break-all font-mono text-[11px] text-zinc-400">{token}</div>
                              </div>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(token)
                                  } catch {
                                    // ignore
                                  }
                                }}
                                className="shrink-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
                                title="Copy token"
                              >
                                Copy
                              </button>
                            </div>

                            <div className="mt-2 text-[11px] text-zinc-500">last value</div>
                            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-200">
                              {preview}
                            </pre>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Panel>
  )
}


