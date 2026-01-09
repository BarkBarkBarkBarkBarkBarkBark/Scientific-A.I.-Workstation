import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'
import { AudioLowpassInspector } from './inspector/AudioLowpassInspector'
import { NodeParameters } from './inspector/NodeParameters'

export function Inspector() {
  const selectedNodeId = useSawStore((s) => s.selectedNodeId)
  const node = useSawStore((s) => s.nodes.find((n) => n.id === selectedNodeId) ?? null)
  const updateNodeParam = useSawStore((s) => s.updateNodeParam)
  const openFullscreen = useSawStore((s) => s.openFullscreen)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)
  const rightCollapsed = useSawStore((s) => s.layout.rightCollapsed)
  const toggleRightSidebar = useSawStore((s) => s.toggleRightSidebar)

  if (rightCollapsed) {
    return (
      <Panel
        title="Inspector"
        right={
          <button
            type="button"
            onClick={toggleRightSidebar}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Expand Inspector"
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
            title="Expand Inspector"
          >
            ‹
          </button>
        </div>
      </Panel>
    )
  }

  if (!node) {
    return (
      <Panel title="Inspector" className="min-h-0 overflow-hidden">
        <div className="p-4 text-sm text-zinc-400">
          Select a node to inspect parameters.
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
            onClick={toggleRightSidebar}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Minimize Inspector"
          >
            Minimize
          </button>
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
      <div className="min-h-0 overflow-y-scroll p-3">
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
          <NodeParameters nodeId={node.id} />
        </div>

        <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs font-semibold tracking-wide text-zinc-200">Code</div>
          <div className="mt-1 text-xs text-zinc-500">
            Open <span className="font-semibold text-zinc-300">Fullscreen</span> to view the plugin manifest + wrapper.
          </div>
        </div>
      </div>
    </Panel>
  )
}


