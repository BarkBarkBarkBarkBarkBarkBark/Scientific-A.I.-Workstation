import { useMemo, useState, type DragEvent } from 'react'
import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'
import { getPlugin } from '../mock/plugins'
import { ResizableDivider } from './ui/ResizableDivider'
import { AudioLowpassInspector } from './inspector/AudioLowpassInspector'

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
  const setSelectedNodeId = useSawStore((s) => s.setSelectedNodeId)
  const selectedNodeId = useSawStore((s) => s.selectedNodeId)
  const editableMode = useSawStore((s) => s.editableMode)
  const openEditor = useSawStore((s) => s.openEditor)

  const addNodeFromPluginAtIndex = useSawStore((s) => s.addNodeFromPluginAtIndex)
  const moveNodeInPipeline = useSawStore((s) => s.moveNodeInPipeline)
  const deleteNode = useSawStore((s) => s.deleteNode)
  const setNodeViewHeight = useSawStore((s) => s.setNodeViewHeight)

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

  const activeNode = pipeline.find((n) => n.id === selectedNodeId) ?? null
  const activePlugin = activeNode ? getPlugin(activeNode.data.pluginId) : null
  const activeHeight = activeNode?.data.runtime?.ui?.viewHeight ?? 240

  return (
    <Panel
      title="Pipeline"
      right={<span className="text-[11px] text-zinc-500">{pipeline.length} steps • {connectedCount} links</span>}
      className="min-h-0 overflow-hidden"
    >
      <div className="flex h-full flex-col">
        {/* Tabs */}
        <div className="flex items-center gap-1 overflow-auto border-b border-zinc-800 bg-zinc-950/40 px-2 py-2">
          {pipeline.length === 0 ? (
            <div className="px-2 text-xs text-zinc-500">No modules yet</div>
          ) : (
            pipeline.map((n, idx) => {
              const p = getPlugin(n.data.pluginId)
              const active = n.id === selectedNodeId
              return (
                <div
                  key={n.id}
                  className={[
                    'flex items-center gap-2 rounded-md border px-2 py-1',
                    active
                      ? 'border-emerald-700 bg-emerald-900/20'
                      : 'border-zinc-800 bg-zinc-950/40 hover:bg-zinc-900',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedNodeId(n.id)}
                    className={[
                      'text-xs font-semibold',
                      active ? 'text-zinc-100' : 'text-zinc-300',
                    ].join(' ')}
                    title="Select module"
                  >
                    {idx + 1}. {p.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteNode(n.id)}
                    className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                    title="Remove module"
                  >
                    ×
                  </button>
                </div>
              )
            })
          )}
        </div>

        {/* Module view (resizable per module) */}
        <div className="px-3 pt-3">
          <Panel
            title={activePlugin ? `Module View — ${activePlugin.name}` : 'Module View'}
            right={<span className="text-[11px] text-zinc-500">wheel to zoom waveform • drag to pan</span>}
            className="overflow-hidden"
          >
            <div className="overflow-auto p-3" style={{ height: activeHeight }}>
              {!activeNode || !activePlugin ? (
                <div className="text-sm text-zinc-400">
                  Select a module tab to view its output/UI here.
                </div>
              ) : activePlugin.id === 'audio_lowpass' ? (
                <AudioLowpassInspector nodeId={activeNode.id} />
              ) : (
                <div className="space-y-2">
                  <div className="text-sm text-zinc-200">{activePlugin.description}</div>
                  <div className="text-xs text-zinc-500">
                    (Module-specific visualization will live here; for now use the Inspector on the right.)
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-zinc-500">
                    {activePlugin.inputs.map((i) => (
                      <span key={i.id} className="rounded bg-zinc-900 px-2 py-0.5">
                        in:{i.type}
                      </span>
                    ))}
                    {activePlugin.outputs.map((o) => (
                      <span key={o.id} className="rounded bg-zinc-900 px-2 py-0.5">
                        out:{o.type}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </div>

        <div className="mx-3 my-2 rounded-md border border-zinc-800 bg-zinc-950/30">
          <ResizableDivider
            orientation="horizontal"
            value={activeHeight}
            setValue={(v) => {
              if (!activeNode) return
              setNodeViewHeight(activeNode.id, v)
            }}
            min={140}
            max={520}
          />
        </div>

        {/* Pipeline list (drop zones + reorder) */}
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          <div className="space-y-2">
          <DropZone
            index={0}
            active={activeDropIndex === 0}
            onDropAt={onDropAt}
            onEnter={() => setActiveDropIndex(0)}
            onLeave={() => setActiveDropIndex(null)}
          />

          {pipeline.map((n, idx) => {
            const p = getPlugin(n.data.pluginId)
            const selected = selectedNodeId === n.id
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
                    setSelectedNodeId(n.id)
                    if (editableMode) openEditor(n.id)
                  }}
                  className={[
                    'rounded-lg border px-3 py-3',
                    'bg-zinc-950/50',
                    'cursor-pointer select-none',
                    selected ? 'border-emerald-700' : 'border-zinc-800 hover:border-zinc-700',
                  ].join(' ')}
                  title="Click to inspect • Drag to reorder"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-zinc-100">{p.name}</div>
                      <div className="mt-0.5 text-[11px] text-zinc-500">
                        {p.id} • v{p.version}
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
                    {p.inputs.map((i) => (
                      <span key={i.id} className="rounded bg-zinc-900 px-2 py-0.5">
                        in:{i.type}
                      </span>
                    ))}
                    {p.outputs.map((o) => (
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


