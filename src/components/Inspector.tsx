import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'
import { AudioLowpassInspector } from './inspector/AudioLowpassInspector'

export function Inspector() {
  const selectedNodeId = useSawStore((s) => s.selectedNodeId)
  const node = useSawStore((s) => s.nodes.find((n) => n.id === selectedNodeId) ?? null)
  const updateNodeParam = useSawStore((s) => s.updateNodeParam)
  const openFullscreen = useSawStore((s) => s.openFullscreen)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)

  if (!node) {
    return (
      <Panel title="Inspector" className="min-h-0 overflow-hidden">
        <div className="p-4 text-sm text-zinc-400">
          Select a node to inspect parameters and mocked code structure.
        </div>
      </Panel>
    )
  }

  const plugin = pluginCatalog.find((p) => p.id === node.data.pluginId)
  if (!plugin) {
    return (
      <Panel title="Inspector" className="min-h-0 overflow-hidden">
        <div className="p-4 text-sm text-zinc-400">Unknown plugin: {node.data.pluginId}</div>
      </Panel>
    )
  }

  return (
    <Panel
      title="Inspector"
      right={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-500">{plugin.name}</span>
          <button
            type="button"
            onClick={() => openFullscreen(node.id)}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
          >
            Fullscreen
          </button>
        </div>
      }
      className="min-h-0 overflow-hidden"
    >
      <div className="min-h-0 overflow-auto p-3">
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-sm font-semibold text-zinc-100">{plugin.name}</div>
          <div className="mt-1 text-xs text-zinc-400">{plugin.description}</div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
            <span className="rounded bg-zinc-900 px-2 py-0.5">id: {plugin.id}</span>
            <span className="rounded bg-zinc-900 px-2 py-0.5">v{plugin.version}</span>
            <span className="rounded bg-zinc-900 px-2 py-0.5">status: {node.data.status}</span>
          </div>
        </div>

        {plugin.id === 'audio_lowpass' && (
          <div className="mt-3">
            <AudioLowpassInspector nodeId={node.id} />
          </div>
        )}

        <div className="mt-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-200">Parameters</div>
          <div className="space-y-2">
            {plugin.parameters.length === 0 && (
              <div className="text-sm text-zinc-500">No editable parameters.</div>
            )}
            {plugin.parameters.map((def) => {
              const v = node.data.params[def.id]
              const label = (
                <div className="text-xs text-zinc-400">
                  {def.label} <span className="text-zinc-600">({def.kind})</span>
                </div>
              )

              if (def.kind === 'select') {
                return (
                  <div key={def.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
                    {label}
                    <select
                      value={String(v)}
                      onChange={(e) => updateNodeParam(node.id, def.id, e.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    >
                      {(def.options ?? []).map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              }

              if (def.kind === 'number') {
                return (
                  <div key={def.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
                    {label}
                    <input
                      type="number"
                      value={typeof v === 'number' ? v : Number(v)}
                      min={def.min}
                      max={def.max}
                      step="any"
                      onChange={(e) => updateNodeParam(node.id, def.id, Number(e.target.value))}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                  </div>
                )
              }

              return (
                <div key={def.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
                  {label}
                  <input
                    value={String(v ?? '')}
                    onChange={(e) => updateNodeParam(node.id, def.id, e.target.value)}
                    className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>
              )
            })}
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-200">
            Code Structure (mock)
          </div>
          <div className="space-y-2">
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
              <div className="text-xs font-semibold text-zinc-300">Classes</div>
              <div className="mt-1 space-y-2 text-xs text-zinc-400">
                {node.data.codeIndex.classes.map((c) => (
                  <div key={c.name} className="rounded bg-zinc-950 px-2 py-1">
                    <div className="font-mono text-zinc-200">{c.name}</div>
                    <div className="mt-1 text-zinc-500">
                      methods: {c.methods.join(', ') || '—'}
                    </div>
                    <div className="text-zinc-500">
                      attributes: {c.attributes.join(', ') || '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
              <div className="text-xs font-semibold text-zinc-300">Functions</div>
              <div className="mt-1 space-y-1 text-xs text-zinc-400">
                {node.data.codeIndex.functions.map((f) => (
                  <div key={f.name} className="rounded bg-zinc-950 px-2 py-1 font-mono text-zinc-200">
                    {f.signature}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
              <div className="text-xs font-semibold text-zinc-300">Methods / Attributes</div>
              <div className="mt-1 text-xs text-zinc-500">
                (Shown per-class above; placeholder for richer AST parsing later.)
              </div>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  )
}


