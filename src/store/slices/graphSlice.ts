import {
  addEdge as rfAddEdge,
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from 'reactflow'
import type { PluginNode } from '../../types/saw'
import type { SawState } from '../storeTypes'
import { makeId } from '../utils/id'
import { getPluginFromCatalog } from '../utils/catalog'
import { makeNodeData } from '../utils/nodeFactory'
import { findFirstMatchingHandles } from '../utils/graphUtils'

export function createGraphSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<
  SawState,
  | 'nodes'
  | 'edges'
  | 'selectedNodeId'
  | 'editableMode'
  | 'fullscreen'
  | 'onNodesChange'
  | 'onEdgesChange'
  | 'setSelectedNodeId'
  | 'setEditableMode'
  | 'addNodeFromPlugin'
  | 'addNodeFromPluginAtIndex'
  | 'moveNodeInPipeline'
  | 'deleteNode'
  | 'deleteSelectedNode'
  | 'reflowPipeline'
  | 'isValidConnection'
  | 'tryAddEdge'
  | 'updateNodeParam'
  | 'updateNodeInput'
  | 'openFullscreen'
  | 'closeFullscreen'
  | 'setNodeViewHeight'
> {
  return {
    nodes: [],
    edges: [],
    selectedNodeId: null,
    editableMode: false,
    fullscreen: { open: false, nodeId: null },

    onNodesChange: (changes: NodeChange[]) =>
      set({ nodes: applyNodeChanges(changes, get().nodes) as PluginNode[] }),
    onEdgesChange: (changes: EdgeChange[]) => set({ edges: applyEdgeChanges(changes, get().edges) }),

    setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
    setEditableMode: (editableMode) => set({ editableMode }),

    addNodeFromPlugin: (pluginId: string, position: XYPosition) => {
      const nodeId = makeId('node')
      const p = getPluginFromCatalog(get().pluginCatalog, pluginId)
      const node: PluginNode = {
        id: nodeId,
        type: 'pluginNode',
        position,
        data: makeNodeData(get().pluginCatalog, pluginId),
        draggable: true,
        selectable: true,
      }
      set((s) => ({
        nodes: [...s.nodes, node],
        logs: [...s.logs, `[graph] added node "${p?.name ?? pluginId}"`],
      }))
      return nodeId
    },

    addNodeFromPluginAtIndex: (pluginId: string, index: number) => {
      const nodeId = makeId('node')
      const p = getPluginFromCatalog(get().pluginCatalog, pluginId)
      // position is temporary; `reflowPipeline()` will set final positions
      const node: PluginNode = {
        id: nodeId,
        type: 'pluginNode',
        position: { x: 80, y: 80 },
        data: makeNodeData(get().pluginCatalog, pluginId),
        draggable: true,
        selectable: true,
      }

      set((s) => {
        const i = Math.max(0, Math.min(s.nodes.length, index))
        const nextNodes = [...s.nodes.slice(0, i), node, ...s.nodes.slice(i)]
        return {
          nodes: nextNodes,
          logs: [...s.logs, `[graph] added node "${p?.name ?? pluginId}"`],
        }
      })

      // Pipeline mode keeps a stable vertical layout
      if (get().layoutMode === 'pipeline') get().reflowPipeline()
      return nodeId
    },

    moveNodeInPipeline: (fromIndex: number, toIndex: number) => {
      set((s) => {
        if (s.nodes.length === 0) return s
        const from = Math.max(0, Math.min(s.nodes.length - 1, fromIndex))
        const to = Math.max(0, Math.min(s.nodes.length - 1, toIndex))
        if (from === to) return s

        const next = [...s.nodes]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved!)
        return { ...s, nodes: next }
      })
      if (get().layoutMode === 'pipeline') get().reflowPipeline()
    },

    deleteNode: (nodeId: string) => {
      set((s) => {
        const nextNodes = s.nodes.filter((n) => n.id !== nodeId)
        const nextEdges = s.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
        const selectedNodeId = s.selectedNodeId === nodeId ? null : s.selectedNodeId
        const fullscreen = s.fullscreen.nodeId === nodeId ? { open: false, nodeId: null } : s.fullscreen
        return {
          ...s,
          nodes: nextNodes,
          edges: nextEdges,
          selectedNodeId,
          fullscreen,
          logs: [...s.logs, `[graph] deleted node ${nodeId}`],
        }
      })
      if (get().layoutMode === 'pipeline') get().reflowPipeline()
    },

    deleteSelectedNode: () => {
      const id = get().selectedNodeId
      if (!id) return
      get().deleteNode(id)
    },

    reflowPipeline: () => {
      const spacingY = 150
      const laneX = 80

      set((s) => {
        // Treat current array order as the pipeline order (top -> bottom).
        const nextNodes = s.nodes.map((n, idx) => ({
          ...n,
          position: { x: laneX, y: 40 + idx * spacingY },
          draggable: false,
        }))

        const nextEdges: Edge[] = []
        for (let i = 0; i < nextNodes.length - 1; i++) {
          const sNode = nextNodes[i]!
          const tNode = nextNodes[i + 1]!
          const match = findFirstMatchingHandles(sNode as any, tNode as any)
          if (!match) continue
          nextEdges.push({
            id: makeId('edge'),
            source: sNode.id,
            target: tNode.id,
            sourceHandle: match.sourceHandle,
            targetHandle: match.targetHandle,
            label: match.type,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: '#a1a1aa' },
            labelStyle: { fill: '#a1a1aa', fontSize: 12 },
          })
        }

        return { nodes: nextNodes as PluginNode[], edges: nextEdges }
      })
    },

    isValidConnection: (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return false
      const sNode = get().nodes.find((n) => n.id === c.source)
      const tNode = get().nodes.find((n) => n.id === c.target)
      if (!sNode || !tNode) return false

      const sType = sNode.data.portTypes[c.sourceHandle]
      const tType = tNode.data.portTypes[c.targetHandle]
      if (!sType || !tType) return false
      return sType === tType
    },

    tryAddEdge: (c: Connection) => {
      // Keep pipeline mode simple: edges are auto-generated
      if (get().layoutMode === 'pipeline') return

      if (!get().isValidConnection(c)) {
        set((s) => ({
          bottomTab: 'errors',
          logs: [...s.logs, '[graph] blocked invalid connection (type mismatch)'],
          errors: [...s.errors, 'TypeError: Cannot connect ports with mismatched types.'],
        }))
        return
      }

      const sNode = get().nodes.find((n) => n.id === c.source)
      const sType = sNode && c.sourceHandle ? sNode.data.portTypes[c.sourceHandle] : undefined

      const next = rfAddEdge(
        {
          ...c,
          id: makeId('edge'),
          label: sType ?? '',
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: '#a1a1aa' },
          labelStyle: { fill: '#a1a1aa', fontSize: 12 },
        },
        get().edges,
      )
      set((s) => ({ edges: next, logs: [...s.logs, '[graph] connected ports'] }))
    },

    updateNodeParam: (nodeId: string, paramId: string, value: string | number) => {
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, params: { ...n.data.params, [paramId]: value } } } : n,
        ),
      }))

      const node = get().nodes.find((n) => n.id === nodeId)
      if (node?.data.pluginId === 'audio_lowpass' && paramId === 'cutoff_hz') {
        void get().recomputeLowpass(nodeId)
      }
    },

    updateNodeInput: (nodeId: string, inputId: string, value: string | number) => {
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, inputs: { ...n.data.inputs, [inputId]: value } } } : n,
        ),
      }))
    },

    openFullscreen: (nodeId: string) => set({ fullscreen: { open: true, nodeId } }),
    closeFullscreen: () => set({ fullscreen: { open: false, nodeId: null } }),

    setNodeViewHeight: (nodeId: string, height: number) => {
      const h = Math.max(140, Math.min(520, Math.round(height)))
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n
          return {
            ...n,
            data: {
              ...n.data,
              runtime: {
                ...n.data.runtime,
                ui: { ...(n.data.runtime?.ui ?? { viewHeight: h }), viewHeight: h },
              },
            },
          }
        }),
      }))
    },
  }
}
