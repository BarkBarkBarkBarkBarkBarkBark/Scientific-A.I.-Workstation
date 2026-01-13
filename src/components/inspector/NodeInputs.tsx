import { useSawStore } from '../../store/useSawStore'

function inputKind(inputType: string) {
  const t = inputType.toLowerCase()
  if (['number', 'float', 'int', 'integer'].includes(t)) return 'number'
  return 'text'
}

export function NodeInputs(props: { nodeId: string; title?: string }) {
  const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) ?? null)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)
  const updateNodeInput = useSawStore((s) => s.updateNodeInput)

  if (!node) return null
  const plugin = pluginCatalog.find((p) => p.id === node.data.pluginId) ?? null
  if (!plugin) return null

  return (
    <div>
      <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-200">{props.title ?? 'Inputs'}</div>
      <div className="space-y-2">
        {plugin.inputs.length === 0 && <div className="text-sm text-zinc-500">No editable inputs.</div>}
        {plugin.inputs.map((input) => {
          const v = node.data.inputs?.[input.id]
          const kind = inputKind(input.type)
          const label = (
            <div className="text-xs text-zinc-400">
              {input.name} <span className="text-zinc-600">({input.type})</span>
            </div>
          )

          if (kind === 'number') {
            return (
              <div key={input.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
                {label}
                <input
                  type="number"
                  value={typeof v === 'number' ? v : Number(v ?? '')}
                  step="any"
                  onChange={(e) => updateNodeInput(node.id, input.id, Number(e.target.value))}
                  className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>
            )
          }

          return (
            <div key={input.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
              {label}
              <input
                value={String(v ?? '')}
                onChange={(e) => updateNodeInput(node.id, input.id, e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
