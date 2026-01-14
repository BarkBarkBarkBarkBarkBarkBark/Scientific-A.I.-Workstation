import { useMemo, useState, type DragEvent } from 'react'
import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'

function DropZone(props: {
  index: number
  active: boolean
  onDropAt: (index: number, e: DragEvent) => void
  onEnter: () => void
  onLeave: () => void
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragEnter={(e) => {
        e.preventDefault()
        props.onEnter()
      }}
      onDragLeave={() => props.onLeave()}
      onDrop={(e) => props.onDropAt(props.index, e)}
      className={[
        'rounded-md border border-dashed',
        'px-3 py-2',
        'text-center text-[11px]',
        props.active
          ? 'border-emerald-600 bg-emerald-900/15 text-emerald-200'
          : 'border-zinc-800 bg-zinc-950/20 text-zinc-600 hover:border-zinc-700',
      ].join(' ')}
    >
      Drop here
    </div>
  )
}

export function PipelineBuilder() {
  const nodes = useSawStore((s) => s.nodes)
  const edges = useSawStore((s) => s.edges)
  const layoutMode = useSawStore((s) => s.layoutMode)
  const openFullscreen = useSawStore((s) => s.openFullscreen)

  const addNodeFromPluginAtIndex = useSawStore((s) => s.addNodeFromPluginAtIndex)
  const moveNodeInPipeline = useSawStore((s) => s.moveNodeInPipeline)
  const deleteNode = useSawStore((s) => s.deleteNode)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)

  const [activeDropIndex, setActiveDropIndex] = useState<number | null>(null)

  const pipeline = useMemo(() => nodes, [nodes])
  const connectedCount = edges.length

  if (layoutMode !== 'pipeline') return null

  const onDropAt = (index: number, e: DragEvent) => {
    e.preventDefault()
    setActiveDropIndex(null)

    const pluginId =
      e.dataTransfer.getData('application/saw-plugin') || e.dataTransfer.getData('text/plain')
    const movingNodeId = e.dataTransfer.getData('application/saw-pipeline-node')

    if (movingNodeId) {
      const from = pipeline.findIndex((n) => n.id === movingNodeId)
      if (from >= 0) {
        // Drop zones represent insertion BEFORE the item at `index`.
        const to = Math.max(0, Math.min(pipeline.length - 1, index))
        moveNodeInPipeline(from, to)
      }
      return
    }

    if (pluginId) {
      addNodeFromPluginAtIndex(pluginId, index)
    }
  }

  return (
    <Panel
      title="Pipeline"
      right={<span className="text-[11px] text-zinc-500">{pipeline.length} steps • {connectedCount} links</span>}
      className="min-h-0 overflow-hidden"
    >
      <div className="flex h-full flex-col">
        {/* Pipeline list (drop zones + reorder) */}
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
          <div className="space-y-2">
          <DropZone
            index={0}
            active={activeDropIndex === 0}
            onDropAt={onDropAt}
            onEnter={() => setActiveDropIndex(0)}
            onLeave={() => setActiveDropIndex(null)}
          />

          {pipeline.map((n, idx) => {
            const p = pluginCatalog.find((pp) => pp.id === n.data.pluginId) ?? null
            return (
              <div key={n.id} className="space-y-2">
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/saw-pipeline-node', n.id)
                    e.dataTransfer.setData('text/plain', n.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => {
                    openFullscreen(n.id)
                  }}
                  className={[
                    'rounded-lg border px-3 py-3',
                    'bg-zinc-950/50',
                    'cursor-pointer select-none',
                    'border-zinc-800 hover:border-zinc-700',
                  ].join(' ')}
                  title="Click to open fullscreen • Drag to reorder"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-zinc-100">{p?.name ?? n.data.pluginId}</div>
                      <div className="mt-0.5 text-[11px] text-zinc-500">
                        {p?.id ?? n.data.pluginId} • v{p?.version ?? '—'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400">
                        step {idx + 1}
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteNode(n.id)
                        }}
                        className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                        title="Remove step"
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-zinc-500">
                    {(p?.inputs ?? []).map((i) => (
                      <span key={i.id} className="rounded bg-zinc-900 px-2 py-0.5">
                        in:{i.type}
                      </span>
                    ))}
                    {(p?.outputs ?? []).map((o) => (
                      <span key={o.id} className="rounded bg-zinc-900 px-2 py-0.5">
                        out:{o.type}
                      </span>
                    ))}
                  </div>
                </div>

                <DropZone
                  index={idx + 1}
                  active={activeDropIndex === idx + 1}
                  onDropAt={onDropAt}
                  onEnter={() => setActiveDropIndex(idx + 1)}
                  onLeave={() => setActiveDropIndex(null)}
                />
              </div>
            )
          })}

          {pipeline.length === 0 && (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-400">
              Drag a plugin from the left into a drop zone to create the first step.
            </div>
          )}
          </div>
        </div>
      </div>
    </Panel>
  )
}


