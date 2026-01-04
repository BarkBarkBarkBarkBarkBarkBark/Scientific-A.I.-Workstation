import { create } from 'zustand'
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
import type { PluginNode, PluginNodeData } from '../types/saw'
import { plugins, getPlugin } from '../mock/plugins'
import { generateAiPlan } from '../mock/ai'
import { makeMockCode, makeMockCodeIndex, makeMockGitPreview } from '../mock/codegen'
import { getAiStatus, requestAiPlan } from '../ai/client'
import type { AiStatus } from '../types/ai'
import { decodeAudioFile, renderLowpass } from '../audio/webaudio'

type BottomTab = 'logs' | 'errors' | 'ai' | 'dev'

type EditorState = {
  open: boolean
  nodeId: string | null
}

type LayoutMode = 'pipeline' | 'graph'

type SawState = {
  nodes: PluginNode[]
  edges: Edge[]
  selectedNodeId: string | null
  editableMode: boolean
  editor: EditorState
  bottomTab: BottomTab
  goalText: string
  logs: string[]
  errors: string[]
  aiMessages: string[]
  aiBusy: boolean
  aiStatus: AiStatus | null
  layoutMode: LayoutMode

  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  setSelectedNodeId: (id: string | null) => void
  setEditableMode: (enabled: boolean) => void
  setBottomTab: (tab: BottomTab) => void
  setGoalText: (text: string) => void
  setLayoutMode: (mode: LayoutMode) => void

  addNodeFromPlugin: (pluginId: string, position: XYPosition) => string
  addNodeFromPluginAtIndex: (pluginId: string, index: number) => string
  moveNodeInPipeline: (fromIndex: number, toIndex: number) => void
  deleteNode: (nodeId: string) => void
  deleteSelectedNode: () => void
  reflowPipeline: () => void
  isValidConnection: (c: Connection) => boolean
  tryAddEdge: (c: Connection) => void
  updateNodeParam: (nodeId: string, paramId: string, value: string | number) => void
  openEditor: (nodeId: string) => void
  closeEditor: () => void
  updateNodeCode: (nodeId: string, code: string) => void
  refreshAiStatus: () => Promise<void>
  submitGoal: (goal: string) => Promise<void>

  // Audio plugin (real WebAudio)
  loadMp3ToNode: (nodeId: string, file: File) => Promise<void>
  recomputeLowpass: (nodeId: string) => Promise<void>
  setNodeViewHeight: (nodeId: string, height: number) => void

  // Layout
  layout: { leftWidth: number; rightWidth: number; bottomHeight: number }
  setLayout: (patch: Partial<SawState['layout']>) => void
}

function id(prefix = 'n') {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`
}

function makeNodeData(pluginId: string): PluginNodeData {
  const p = getPlugin(pluginId)
  const params: Record<string, string | number> = {}
  for (const def of p.parameters) params[def.id] = def.default

  const portTypes: Record<string, string> = {}
  for (const input of p.inputs) portTypes[`in:${input.id}`] = input.type
  for (const output of p.outputs) portTypes[`out:${output.id}`] = output.type

  const code = makeMockCode(p)
  const codeIndex = makeMockCodeIndex(p)
  const git = makeMockGitPreview(code)

  const data: PluginNodeData = {
    pluginId,
    title: p.name,
    status: 'idle',
    params,
    portTypes,
    code,
    codeIndex,
    git,
    runtime: {
      ui: { viewHeight: pluginId === 'audio_lowpass' ? 320 : 220 },
    },
  }

  if (pluginId === 'audio_lowpass') {
    data.runtime = {
      audio: { fileName: null, original: null, filtered: null, lastError: null },
      ui: { viewHeight: 360 },
    }
  }

  return data
}

function findFirstMatchingHandles(source: PluginNode, target: PluginNode) {
  const out = Object.entries(source.data.portTypes).filter(([hid]) => hid.startsWith('out:'))
  const inn = Object.entries(target.data.portTypes).filter(([hid]) => hid.startsWith('in:'))
  for (const [outH, outT] of out) {
    for (const [inH, inT] of inn) {
      if (outT === inT) return { sourceHandle: outH, targetHandle: inH, type: outT }
    }
  }
  return null
}

export const useSawStore = create<SawState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  editableMode: false,
  editor: { open: false, nodeId: null },
  bottomTab: 'logs',
  goalText: '',
  logs: [
    '[runtime] SAW boot: ok',
    '[runtime] execution engine: mocked (frontend-only)',
    '[graph] drag plugins in to build a pipeline',
  ],
  errors: [
    'Traceback (most recent call last):',
    '  File "pipeline.py", line 42, in <module>',
    '    run_pipeline()',
    '  File "pipeline.py", line 19, in run_pipeline',
    '    df = load_csv(path="data/missing.csv")',
    'FileNotFoundError: [Errno 2] No such file or directory: data/missing.csv',
  ],
  aiMessages: [
    'AI: Drop a "Load CSV" → "Normalize" → "PCA" chain to quickly sanity-check a dataset.',
  ],
  aiBusy: false,
  aiStatus: null,
  layoutMode: 'pipeline',
  layout: { leftWidth: 280, rightWidth: 340, bottomHeight: 240 },

  onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) as PluginNode[] }),
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),

  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setEditableMode: (editableMode) => set({ editableMode }),
  setBottomTab: (bottomTab) => set({ bottomTab }),
  setGoalText: (goalText) => set({ goalText }),
  setLayoutMode: (layoutMode) => set({ layoutMode }),
  setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),

  addNodeFromPlugin: (pluginId, position) => {
    const nodeId = id('node')
    const p = getPlugin(pluginId)
    const node: PluginNode = {
      id: nodeId,
      type: 'pluginNode',
      position,
      data: makeNodeData(pluginId),
      draggable: true,
      selectable: true,
    }
    set((s) => ({
      nodes: [...s.nodes, node],
      logs: [...s.logs, `[graph] added node "${p.name}"`],
    }))
    return nodeId
  },

  addNodeFromPluginAtIndex: (pluginId, index) => {
    const nodeId = id('node')
    const p = getPlugin(pluginId)
    // position is temporary; `reflowPipeline()` will set final positions
    const node: PluginNode = {
      id: nodeId,
      type: 'pluginNode',
      position: { x: 80, y: 80 },
      data: makeNodeData(pluginId),
      draggable: true,
      selectable: true,
    }

    set((s) => {
      const i = Math.max(0, Math.min(s.nodes.length, index))
      const nextNodes = [...s.nodes.slice(0, i), node, ...s.nodes.slice(i)]
      return {
        nodes: nextNodes,
        logs: [...s.logs, `[graph] added node "${p.name}"`],
      }
    })

    // Pipeline mode keeps a stable vertical layout
    if (get().layoutMode === 'pipeline') get().reflowPipeline()
    return nodeId
  },

  moveNodeInPipeline: (fromIndex, toIndex) => {
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

  deleteNode: (nodeId) => {
    set((s) => {
      const nextNodes = s.nodes.filter((n) => n.id !== nodeId)
      const nextEdges = s.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
      const selectedNodeId = s.selectedNodeId === nodeId ? null : s.selectedNodeId
      const editor =
        s.editor.nodeId === nodeId ? { open: false, nodeId: null } : s.editor
      return {
        ...s,
        nodes: nextNodes,
        edges: nextEdges,
        selectedNodeId,
        editor,
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
        const match = findFirstMatchingHandles(sNode, tNode)
        if (!match) continue
        nextEdges.push({
          id: id('edge'),
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

  isValidConnection: (c) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return false
    const sNode = get().nodes.find((n) => n.id === c.source)
    const tNode = get().nodes.find((n) => n.id === c.target)
    if (!sNode || !tNode) return false

    const sType = sNode.data.portTypes[c.sourceHandle]
    const tType = tNode.data.portTypes[c.targetHandle]
    if (!sType || !tType) return false
    return sType === tType
  },

  tryAddEdge: (c) => {
    // Keep pipeline mode simple: edges are auto-generated
    if (get().layoutMode === 'pipeline') return

    if (!get().isValidConnection(c)) {
      set((s) => ({
        bottomTab: 'errors',
        logs: [...s.logs, '[graph] blocked invalid connection (type mismatch)'],
        errors: [
          ...s.errors,
          'TypeError: Cannot connect ports with mismatched types (mock validator).',
        ],
      }))
      return
    }

    const sNode = get().nodes.find((n) => n.id === c.source)
    const sType =
      sNode && c.sourceHandle ? sNode.data.portTypes[c.sourceHandle] : undefined

    const next = rfAddEdge(
      {
        ...c,
        id: id('edge'),
        label: sType ?? '',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#a1a1aa' },
        labelStyle: { fill: '#a1a1aa', fontSize: 12 },
      },
      get().edges,
    )
    set((s) => ({ edges: next, logs: [...s.logs, '[graph] connected ports'] }))
  },

  updateNodeParam: (nodeId, paramId, value) => {
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

  openEditor: (nodeId) => set({ editor: { open: true, nodeId } }),
  closeEditor: () => set({ editor: { open: false, nodeId: null } }),

  updateNodeCode: (nodeId, code) => {
    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id !== nodeId) return n
        const git = {
          ...n.data.git,
          current: code,
          diff: n.data.git.diff,
        }
        return { ...n, data: { ...n.data, code, git } }
      }),
    }))
  },

  refreshAiStatus: async () => {
    try {
      const status = await getAiStatus()
      set({ aiStatus: status })
    } catch {
      set({ aiStatus: { enabled: false, model: 'unknown' } })
    }
  },

  setNodeViewHeight: (nodeId, height) => {
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

  submitGoal: async (goal) => {
    set({ aiBusy: true })
    set((s) => ({
      goalText: goal,
      bottomTab: 'ai',
      logs: [...s.logs, '[planner] generating plan...'],
    }))

    let plan = null as any
    try {
      plan = await requestAiPlan(goal, plugins)
      set((s) => ({
        aiStatus: s.aiStatus ?? { enabled: true, model: 'openai' },
        logs: [...s.logs, ...plan.logs],
      }))
    } catch (e: any) {
      const fallback = generateAiPlan(goal, plugins)
      plan = fallback
      set((s) => ({
        bottomTab: 'ai',
        logs: [...s.logs, `[planner] openai unavailable; using mock planner (${String(e?.message ?? e)})`],
      }))
    } finally {
      set({ aiBusy: false })
    }

    set((s) => ({
      errors: [...s.errors, ...(plan?.errors ?? [])],
      aiMessages: [
        ...s.aiMessages,
        `AI Plan:\n${plan.summary}`,
        ...(plan.suggestionsText ?? []).map((t: string) => `AI: ${t}`),
      ],
    }))

    // Best-effort auto-drop (plan or mock)
    const suggested: string[] = Array.isArray(plan?.suggestedPlugins) ? plan.suggestedPlugins : []
    if (suggested.length === 0) return

    if (get().layoutMode === 'pipeline') {
      for (const pluginId of suggested) {
        if (!plugins.find((p) => p.id === pluginId)) continue
        get().addNodeFromPluginAtIndex(pluginId, get().nodes.length)
      }
      get().reflowPipeline()
      return
    }

    // Graph mode fallback: keep old horizontal spread
    const base = { x: 120, y: 140 }
    const spacing = 280
    for (const [i, pluginId] of suggested.entries()) {
      if (!plugins.find((p) => p.id === pluginId)) continue
      get().addNodeFromPlugin(pluginId, { x: base.x + i * spacing, y: base.y })
    }
  },

  loadMp3ToNode: async (nodeId, file) => {
    // Decode (real)
    try {
      const original = await decodeAudioFile(file)
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n
          if (n.data.pluginId !== 'audio_lowpass') return n
          return {
            ...n,
            data: {
              ...n.data,
              runtime: {
                ...n.data.runtime,
                audio: {
                  ...(n.data.runtime?.audio ?? {
                    fileName: null,
                    original: null,
                    filtered: null,
                    lastError: null,
                  }),
                  fileName: file.name,
                  original,
                  lastError: null,
                },
              },
            },
          }
        }),
        logs: [...s.logs, `[audio] decoded "${file.name}"`],
      }))
      await get().recomputeLowpass(nodeId)
    } catch (e: any) {
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n
          if (n.data.pluginId !== 'audio_lowpass') return n
          return {
            ...n,
            data: {
              ...n.data,
              runtime: {
                ...n.data.runtime,
                audio: {
                  ...(n.data.runtime?.audio ?? {
                    fileName: null,
                    original: null,
                    filtered: null,
                    lastError: null,
                  }),
                  lastError: String(e?.message ?? e),
                },
              },
            },
          }
        }),
        bottomTab: 'errors',
        errors: [...s.errors, `AudioDecodeError: ${String(e?.message ?? e)}`],
      }))
    }
  },

  recomputeLowpass: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node || node.data.pluginId !== 'audio_lowpass') return
    const original = node.data.runtime?.audio?.original ?? null
    if (!original) return

    const cutoff = Number(node.data.params['cutoff_hz'] ?? 1200)
    try {
      const filtered = await renderLowpass({ input: original, cutoffHz: cutoff })
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n
          if (n.data.pluginId !== 'audio_lowpass') return n
          return {
            ...n,
            data: {
              ...n.data,
              runtime: {
                ...n.data.runtime,
                audio: {
                  ...(n.data.runtime?.audio ?? {
                    fileName: null,
                    original: null,
                    filtered: null,
                    lastError: null,
                  }),
                  filtered,
                  lastError: null,
                },
              },
            },
          }
        }),
        logs: [...s.logs, `[audio] rendered lowpass @ ${Math.round(cutoff)} Hz`],
      }))
    } catch (e: any) {
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n
          if (n.data.pluginId !== 'audio_lowpass') return n
          return {
            ...n,
            data: {
              ...n.data,
              runtime: {
                ...n.data.runtime,
                audio: {
                  ...(n.data.runtime?.audio ?? {
                    fileName: null,
                    original: null,
                    filtered: null,
                    lastError: null,
                  }),
                  lastError: String(e?.message ?? e),
                },
              },
            },
          }
        }),
        bottomTab: 'errors',
        errors: [...s.errors, `AudioRenderError: ${String(e?.message ?? e)}`],
      }))
    }
  },
}))


