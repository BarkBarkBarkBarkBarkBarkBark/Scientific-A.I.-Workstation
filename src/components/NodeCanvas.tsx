import { useCallback, useRef, type DragEvent } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  type ReactFlowInstance,
  type Connection,
} from 'reactflow'
import { useSawStore } from '../store/useSawStore'
import { PluginNode } from './nodes/PluginNode'
import { Panel } from './ui/Panel'

const nodeTypes = { pluginNode: PluginNode }

function CanvasInner() {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const rfRef = useRef<ReactFlowInstance | null>(null)

  const nodes = useSawStore((s) => s.nodes)
  const edges = useSawStore((s) => s.edges)
  const onNodesChange = useSawStore((s) => s.onNodesChange)
  const onEdgesChange = useSawStore((s) => s.onEdgesChange)
  const setSelectedNodeId = useSawStore((s) => s.setSelectedNodeId)
  const addNodeFromPlugin = useSawStore((s) => s.addNodeFromPlugin)
  const tryAddEdge = useSawStore((s) => s.tryAddEdge)
  const isValidConnection = useSawStore((s) => s.isValidConnection)
  const editableMode = useSawStore((s) => s.editableMode)
  const openFullscreen = useSawStore((s) => s.openFullscreen)
  const layoutMode = useSawStore((s) => s.layoutMode)

  const onConnect = useCallback(
    (c: Connection) => {
      tryAddEdge(c)
    },
    [tryAddEdge],
  )

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      const pluginId =
        e.dataTransfer.getData('application/saw-plugin') || e.dataTransfer.getData('text/plain')
      if (!pluginId) return
      if (!wrapperRef.current || !rfRef.current) return

      const pos = rfRef.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      addNodeFromPlugin(pluginId, pos)
    },
    [addNodeFromPlugin],
  )

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  return (
    <Panel
      title="Node Graph"
      right={
        <span className="text-[11px]">
          {layoutMode === 'pipeline'
            ? 'Pipeline mode • Drop to add rows top→bottom'
            : 'Graph mode • Drag plugins in • Connect matching types'}
        </span>
      }
      className="min-h-0 overflow-hidden"
    >
      <div ref={wrapperRef} className="h-full w-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onInit={(inst) => {
            rfRef.current = inst
          }}
          onPaneClick={() => setSelectedNodeId(null)}
          onNodeClick={(_, node) => {
            setSelectedNodeId(node.id)
            if (editableMode) openFullscreen(node.id)
          }}
          isValidConnection={isValidConnection}
          nodesDraggable={layoutMode !== 'pipeline'}
          nodesConnectable={layoutMode !== 'pipeline'}
          fitView
          proOptions={{ hideAttribution: true }}
          className="bg-zinc-950"
        >
          <Background color="#27272a" gap={18} />
          <MiniMap
            pannable
            zoomable
            nodeColor={() => '#334155'}
            maskColor="#0a0a0a99"
            style={{ background: '#09090b' }}
          />
          <Controls />
        </ReactFlow>
      </div>
    </Panel>
  )
}

export function NodeCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}


