import { Handle, Position, type NodeProps } from 'reactflow'
import { useMemo } from 'react'
import type { PluginNodeData } from '../../types/saw'
import { useSawStore } from '../../store/useSawStore'

function statusColor(status: PluginNodeData['status']) {
  if (status === 'running') return 'bg-sky-500'
  if (status === 'error') return 'bg-rose-500'
  return 'bg-zinc-500'
}

export function PluginNode(props: NodeProps<PluginNodeData>) {
  const catalog = useSawStore((s) => s.pluginCatalog)
  const p = useMemo(() => catalog.find((x) => x.id === props.data.pluginId) ?? null, [catalog, props.data.pluginId])

  return (
    <div className="w-[240px] rounded-lg border border-zinc-700 bg-zinc-950/70 shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">{props.data.title}</div>
          <div className="text-[11px] text-zinc-500">{p?.id ?? props.data.pluginId}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusColor(props.data.status)}`} />
          <span className="text-[11px] text-zinc-400">{props.data.status}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 px-3 py-2 text-[11px]">
        <div className="space-y-1">
          <div className="text-zinc-500">Inputs</div>
          {!p || p.inputs.length === 0 ? <div className="text-zinc-600">—</div> : null}
          {(p?.inputs ?? []).map((input, idx) => {
            const handleId = `in:${input.id}`
            return (
              <div key={input.id} className="relative flex items-center justify-between gap-2">
                <Handle
                  type="target"
                  position={Position.Left}
                  id={handleId}
                  style={{
                    left: -8,
                    top: 54 + idx * 22,
                    width: 10,
                    height: 10,
                    background: '#27272a',
                    border: '1px solid #3f3f46',
                  }}
                />
                <div className="truncate text-zinc-200">{input.name}</div>
                <div className="text-zinc-500">{input.type}</div>
              </div>
            )
          })}
        </div>

        <div className="space-y-1">
          <div className="text-zinc-500 text-right">Outputs</div>
          {!p || p.outputs.length === 0 ? <div className="text-zinc-600 text-right">—</div> : null}
          {(p?.outputs ?? []).map((output, idx) => {
            const handleId = `out:${output.id}`
            return (
              <div key={output.id} className="relative flex items-center justify-between gap-2">
                <div className="truncate text-zinc-200">{output.name}</div>
                <div className="text-zinc-500">{output.type}</div>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={handleId}
                  style={{
                    right: -8,
                    top: 54 + idx * 22,
                    width: 10,
                    height: 10,
                    background: '#27272a',
                    border: '1px solid #3f3f46',
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>

      <div className="border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">
        Click to inspect • Connect matching types
      </div>
    </div>
  )
}


