import { useSawStore } from '../../store/useSawStore'

export function NodeParameters(props: { nodeId: string; title?: string }) {
  const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) ?? null)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)
  const updateNodeParam = useSawStore((s) => s.updateNodeParam)

  if (!node) return null
  const plugin = pluginCatalog.find((p) => p.id === node.data.pluginId) ?? null
  if (!plugin) return null

  return (
    <div>
      <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-200">{props.title ?? 'Parameters'}</div>
      <div className="space-y-2">
        {plugin.parameters.length === 0 && <div className="text-sm text-zinc-500">No editable parameters.</div>}
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
  )
}



