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
import type { PluginDefinition } from '../types/saw'
import { generatePlanFallback } from '../ai/planFallback'
import { approveAgentTool, getAiStatus, requestAgentChat, requestAiPlan, type AgentToolCall, type ChatMessage } from '../ai/client'
import type { AiStatus } from '../types/ai'
import { audioBufferFromPcm, decodeAudioFile, encodeWavFromAudioBuffer } from '../audio/webaudio'
import { sourceFiles } from '../dev/sourceFiles'
import type { PatchProposal } from '../types/patch'
import { parsePatchProposalFromAssistant } from '../patching/parsePatchProposal'
import { fetchWorkspacePlugins } from '../plugins/workspace'

type BottomTab = 'logs' | 'errors' | 'ai' | 'chat' | 'dev' | 'todo'

type FullscreenState = {
  open: boolean
  nodeId: string | null
}

type LayoutMode = 'pipeline' | 'graph'

type SawState = {
  nodes: PluginNode[]
  edges: Edge[]
  selectedNodeId: string | null
  editableMode: boolean
  fullscreen: FullscreenState
  bottomTab: BottomTab
  goalText: string
  logs: string[]
  errors: string[]
  errorLog: Array<{ ts: number; tag: string; text: string }>
  aiMessages: string[]
  aiBusy: boolean
  aiStatus: AiStatus | null
  layoutMode: LayoutMode
  chatBusy: boolean
  chat: { messages: ChatMessage[]; conversationId: string | null; pendingTool: AgentToolCall | null }
  dev: { attachedPaths: string[]; lastForbidden?: { op: string; path: string; patch?: string } | null }
  patchReview: { open: boolean; busy: boolean; proposal: PatchProposal | null; lastError?: string }
  workspacePlugins: PluginDefinition[]
  pluginCatalog: PluginDefinition[]
  refreshWorkspacePlugins: () => Promise<void>

  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  setSelectedNodeId: (id: string | null) => void
  setEditableMode: (enabled: boolean) => void
  setBottomTab: (tab: BottomTab) => void
  clearErrors: () => void
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
  openFullscreen: (nodeId: string) => void
  closeFullscreen: () => void
  refreshAiStatus: () => Promise<void>
  submitGoal: (goal: string) => Promise<void>
  sendChat: (text: string) => Promise<void>
  approvePendingTool: (approved: boolean) => Promise<void>
  clearChat: () => void
  devAttachPath: (path: string) => void
  devDetachPath: (path: string) => void
  devClearAttachments: () => void
  applyPatch: (patch: string) => Promise<{ ok: boolean; error?: string }> 
  commitAll: (message: string) => Promise<{ ok: boolean; error?: string }>
  grantWriteCaps: (rulePath: string) => Promise<{ ok: boolean; error?: string }>
  clearLastForbidden: () => void
  openPatchReviewFromMessage: (assistantText: string) => void
  closePatchReview: () => void
  applyPatchProposal: (opts?: { commit?: boolean; commitMessage?: string }) => Promise<{ ok: boolean; error?: string }>

  // Audio plugin (real WebAudio)
  loadMp3ToNode: (nodeId: string, file: File) => Promise<void>
  recomputeLowpass: (nodeId: string) => Promise<void>
  setNodeViewHeight: (nodeId: string, height: number) => void

  // Workspace plugins (generic runtime)
  runPluginNode: (nodeId: string) => Promise<{ ok: boolean; error?: string }>

  // Layout
  layout: {
    leftWidth: number
    leftWidthOpen: number
    leftCollapsed: boolean
    rightWidth: number
    rightWidthOpen: number
    rightCollapsed: boolean
    bottomHeight: number
  }
  setLayout: (patch: Partial<SawState['layout']>) => void
  toggleLeftSidebar: () => void
  toggleRightSidebar: () => void

  consoleFullscreen: boolean
  openConsoleFullscreen: () => void
  closeConsoleFullscreen: () => void
}

function id(prefix = 'n') {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`
}

function mergeCatalog(workspace: PluginDefinition[]) {
  return [...workspace]
}

function getPluginFromCatalog(catalog: PluginDefinition[], pluginId: string): PluginDefinition | null {
  return catalog.find((p) => p.id === pluginId) ?? null
}

function makeNodeData(catalog: PluginDefinition[], pluginId: string): PluginNodeData {
  const p = getPluginFromCatalog(catalog, pluginId)
  if (!p) {
    // Fallback stub so UI doesn't crash; node will show unknown plugin id.
    return {
      pluginId,
      title: pluginId,
      status: 'error',
      params: {},
      portTypes: {},
      code: `# Unknown plugin: ${pluginId}`,
      codeIndex: { classes: [], functions: [] },
      git: { base: '', current: '', diff: '', commitMessage: 'SAW: apply patch' },
      runtime: { ui: { viewHeight: 220 } },
    }
  }
  const params: Record<string, string | number> = {}
  for (const def of p.parameters) params[def.id] = def.default

  const portTypes: Record<string, string> = {}
  for (const input of p.inputs) portTypes[`in:${input.id}`] = input.type
  for (const output of p.outputs) portTypes[`out:${output.id}`] = output.type

  const code = ''
  const codeIndex = { classes: [], functions: [] }
  const git = { base: '', current: '', diff: '', commitMessage: 'SAW: apply patch' }

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

const _useSawStore = create<SawState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  editableMode: false,
  fullscreen: { open: false, nodeId: null },
  bottomTab: 'logs',
  goalText: '',
  logs: [
    '[runtime] SAW boot: ok',
    '[runtime] execution engine: SAW API plugins',
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
  errorLog: [],
  aiMessages: [
    'AI: Drop a "Load CSV" → "Normalize" → "PCA" chain to quickly sanity-check a dataset.',
  ],
  aiBusy: false,
  aiStatus: null,
  chatBusy: false,
  chat: {
    messages: [
      {
        role: 'assistant',
        content:
          'SAW Chat is ready. Ask for pipeline help, debugging ideas, or how to use a module.',
      },
    ],
    conversationId: null,
    pendingTool: null,
  },
  dev: { attachedPaths: [] },
  patchReview: { open: false, busy: false, proposal: null, lastError: '' },
  workspacePlugins: [],
  pluginCatalog: mergeCatalog([]),
  refreshWorkspacePlugins: async () => {
    try {
      const ws = await fetchWorkspacePlugins()
      set({ workspacePlugins: ws, pluginCatalog: mergeCatalog(ws), logs: [...get().logs, `[plugins] loaded workspace plugins (${ws.length})`] })
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      set((s) => ({ logs: [...s.logs, `[plugins] workspace fetch failed: ${msg}`] }))
    }
  },
  layoutMode: 'pipeline',
  layout: {
    leftWidth: 280,
    leftWidthOpen: 280,
    leftCollapsed: false,
    rightWidth: 340,
    rightWidthOpen: 340,
    rightCollapsed: false,
    bottomHeight: 240,
  },
  consoleFullscreen: false,

  onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) as PluginNode[] }),
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),

  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setEditableMode: (editableMode) => set({ editableMode }),
  setBottomTab: (bottomTab) => set({ bottomTab }),
  clearErrors: () => set((s) => ({ errors: [], logs: [...s.logs, '[console] errors cleared'] })),
  setGoalText: (goalText) => set({ goalText }),
  setLayoutMode: (layoutMode) => set({ layoutMode }),
  setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),
  toggleLeftSidebar: () => {
    set((s) => {
      if (s.layout.leftCollapsed) {
        return {
          layout: {
            ...s.layout,
            leftCollapsed: false,
            leftWidth: s.layout.leftWidthOpen || 280,
          },
        }
      }
      return {
        layout: {
          ...s.layout,
          leftCollapsed: true,
          leftWidthOpen: s.layout.leftWidth,
          leftWidth: 56,
        },
      }
    })
  },
  toggleRightSidebar: () => {
    set((s) => {
      if (s.layout.rightCollapsed) {
        return {
          layout: {
            ...s.layout,
            rightCollapsed: false,
            rightWidth: s.layout.rightWidthOpen || 340,
          },
        }
      }
      return {
        layout: {
          ...s.layout,
          rightCollapsed: true,
          rightWidthOpen: s.layout.rightWidth,
          rightWidth: 56,
        },
      }
    })
  },
  openConsoleFullscreen: () => set({ consoleFullscreen: true }),
  closeConsoleFullscreen: () => set({ consoleFullscreen: false }),

  addNodeFromPlugin: (pluginId, position) => {
    const nodeId = id('node')
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

  addNodeFromPluginAtIndex: (pluginId, index) => {
    const nodeId = id('node')
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
      const fullscreen =
        s.fullscreen.nodeId === nodeId ? { open: false, nodeId: null } : s.fullscreen
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
          'TypeError: Cannot connect ports with mismatched types.',
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

  openFullscreen: (nodeId) => set({ fullscreen: { open: true, nodeId } }),
  closeFullscreen: () => set({ fullscreen: { open: false, nodeId: null } }),

  refreshAiStatus: async () => {
    try {
      const status = await getAiStatus()
      set({ aiStatus: status })
    } catch {
      set({ aiStatus: { enabled: false, model: 'unknown' } })
    }
  },

  clearChat: () => {
    set((s) => ({
      chat: {
        messages: [
          {
            role: 'assistant',
            content: 'SAW Chat is ready. Ask for pipeline help, debugging ideas, or how to use a module.',
          },
        ],
        conversationId: null,
        pendingTool: null,
      },
      logs: [...s.logs, '[chat] cleared'],
    }))
  },

  sendChat: async (text) => {
    const content = text.trim()
    if (!content) return

    set({ chatBusy: true })
    set((s) => ({
      bottomTab: 'chat',
      chat: { ...s.chat, messages: [...s.chat.messages, { role: 'user', content }] },
      logs: [...s.logs, '[chat] user message'],
    }))

    try {
      const state = get()
      const r = await requestAgentChat(state.chat.conversationId, content)
      const status = (r as any).status
      const cid = (r as any).conversation_id ?? state.chat.conversationId
      const pending = status === 'needs_approval' ? ((r as any).tool_call ?? null) : null
      const msg =
        status === 'needs_approval'
          ? `Approval required: ${(pending as any)?.name ?? 'tool'}`
          : (r as any).message || (r as any).error || ''

      set((s) => ({
        chatBusy: false,
        chat: { ...s.chat, conversationId: cid, pendingTool: pending, messages: [...s.chat.messages, { role: 'assistant', content: msg }] },
      }))
    } catch (e: any) {
      set((s) => ({
        chatBusy: false,
        bottomTab: 'errors',
        errors: [...s.errors, `AgentChatError: ${String(e?.message ?? e)}`],
        errorLog: [
          ...s.errorLog,
          { ts: Date.now(), tag: 'chat', text: `AgentChatError: ${String(e?.message ?? e)}` },
        ],
        chat: {
          ...s.chat,
          pendingTool: null,
          messages: [
            ...s.chat.messages,
            {
              role: 'assistant',
              content: 'Agent chat is unavailable (check OPENAI_API_KEY + restart SAW API + Patch Engine).',
            },
          ],
        },
      }))
    }
  },

  approvePendingTool: async (approved) => {
    const state = get()
    const cid = state.chat.conversationId
    const pending = state.chat.pendingTool
    if (!cid || !pending?.id) return
    set({ chatBusy: true })
    try {
      const r = await approveAgentTool(cid, pending.id, Boolean(approved))
      const status = (r as any).status
      const nextCid = (r as any).conversation_id ?? cid
      const nextPending = status === 'needs_approval' ? ((r as any).tool_call ?? null) : null
      const msg =
        status === 'needs_approval'
          ? `Approval required: ${((nextPending as any)?.name ?? 'tool') as string}`
          : (r as any).message || (r as any).error || ''
      set((s) => ({
        chatBusy: false,
        chat: { ...s.chat, conversationId: nextCid, pendingTool: nextPending, messages: [...s.chat.messages, { role: 'assistant', content: msg }] },
      }))
    } catch (e: any) {
      set((s) => ({
        chatBusy: false,
        chat: {
          ...s.chat,
          pendingTool: null,
          messages: [...s.chat.messages, { role: 'assistant', content: `Approve failed: ${String(e?.message ?? e)}` }],
        },
      }))
    }
  },

  devAttachPath: (path) => {
    const p = String(path || '').replaceAll('\\', '/')
    if (!p) return
    set((s) => {
      if (s.dev.attachedPaths.includes(p)) return s
      return { dev: { attachedPaths: [...s.dev.attachedPaths, p] } as any } as any
    })
  },

  devDetachPath: (path) => {
    const p = String(path || '').replaceAll('\\', '/')
    set((s) => ({ dev: { attachedPaths: s.dev.attachedPaths.filter((x) => x !== p) } as any } as any))
  },

  devClearAttachments: () => set({ dev: { attachedPaths: [] } as any } as any),

  openPatchReviewFromMessage: (assistantText) => {
    const parsed = parsePatchProposalFromAssistant(String(assistantText ?? ''))
    if (!parsed.ok) {
      set((s) => ({
        patchReview: { ...s.patchReview, lastError: `PatchProposal parse failed: ${parsed.error}` },
      }))
      return
    }
    set({
      patchReview: { open: true, busy: false, proposal: parsed.proposal, lastError: '' },
      bottomTab: 'chat',
    })
  },

  closePatchReview: () => set({ patchReview: { open: false, busy: false, proposal: null, lastError: '' } }),

  applyPatchProposal: async (opts) => {
    const pr = get().patchReview
    const proposal = pr.proposal
    if (!proposal) return { ok: false, error: 'missing_proposal' }

    const patch = proposal.files
      .map((f) => String(f.diff ?? '').trim())
      .filter(Boolean)
      .map((d) => (d.endsWith('\n') ? d : d + '\n'))
      .join('\n')

    set((s) => ({ patchReview: { ...s.patchReview, busy: true, lastError: '' } }))
    const r = await get().applyPatch(patch)
    if (!r.ok) {
      set((s) => ({ patchReview: { ...s.patchReview, busy: false, lastError: r.error ?? 'apply_failed' } }))
      return r
    }

    if (opts?.commit) {
      const msg = String(opts?.commitMessage ?? `SAW: ${proposal.summary || 'apply patch'}`).trim() || 'SAW: apply patch'
      const cr = await get().commitAll(msg)
      if (!cr.ok) {
        set((s) => ({ patchReview: { ...s.patchReview, busy: false, lastError: cr.error ?? 'commit_failed' } }))
        return cr
      }
    }

    set((s) => ({ patchReview: { ...s.patchReview, busy: false, open: false, proposal: null, lastError: '' } }))
    return { ok: true }
  },

  grantWriteCaps: async (rulePath) => {
    const p = String(rulePath || '').replaceAll('\\', '/').trim()
    if (!p) return { ok: false, error: 'missing_path' }
    try {
      const r = await fetch('/api/dev/caps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p, caps: { r: true, w: true, d: false } }),
      })
      if (!r.ok) {
        const t = await r.text()
        set((s) => ({
          bottomTab: 'errors',
          errors: [...s.errors, `CapsError: ${t}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'caps', text: `CapsError: ${t}` }],
        }))
        return { ok: false, error: t }
      }
      set((s) => ({
        logs: [...s.logs, `[caps] enabled W for "${p}"`],
        dev: { ...(s.dev as any), lastForbidden: null } as any,
      }))
      return { ok: true }
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      set((s) => ({
        bottomTab: 'errors',
        errors: [...s.errors, `CapsError: ${msg}`],
        errorLog: [...s.errorLog, { ts: Date.now(), tag: 'caps', text: `CapsError: ${msg}` }],
      }))
      return { ok: false, error: msg }
    }
  },

  clearLastForbidden: () =>
    set((s) => ({ dev: { ...(s.dev as any), lastForbidden: null } as any } as any)),

  applyPatch: async (patch) => {
    try {
      let p = String(patch ?? '')
      // Normalize to avoid invisible chars / missing newline causing git apply parsing issues.
      p = p.replaceAll('\r\n', '\n')
      p = p.replace(/[\u200B-\u200D\uFEFF]/g, '')
      if (!p.endsWith('\n')) p += '\n'

      const r = await fetch('/api/dev/safe/applyPatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: p }),
      })
      if (!r.ok) {
        const t = await r.text()
        set((s) => ({
          bottomTab: 'errors',
          errors: [...s.errors, `SafePatchError: ${t}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'safePatch', text: `SafePatchError: ${t}` }],
        }))
        // Friendlier guidance when blocked by caps
        try {
          const j = JSON.parse(t) as any
          if (j?.error === 'forbidden' && typeof j?.path === 'string') {
            set((s) => ({
              dev: { ...(s.dev as any), lastForbidden: { op: String(j?.op ?? ''), path: j.path, patch: p } } as any,
            }))
            set((s) => ({
              chat: {
                ...s.chat,
                messages: [
                  ...s.chat.messages,
                  {
                    role: 'assistant',
                    content:
                      `Blocked by capabilities (write disabled).\n\n` +
                      `Path: ${j.path}\n\n` +
                      `Fix: Console → Dev → Capabilities.\n` +
                      `- Set Rule path to "${j.path}" (or "." to allow root)\n` +
                      `- Enable W\n` +
                      `- Retry Apply patch`,
                  },
                ],
              },
            }))
          }
          if (j?.error === 'target_dirty' && Array.isArray(j?.paths) && j.paths.length) {
            set((s) => ({
              chat: {
                ...s.chat,
                messages: [
                  ...s.chat.messages,
                  {
                    role: 'assistant',
                    content:
                      `Apply patch blocked (target has local edits).\n\n` +
                      `Paths:\n- ${j.paths.map((x: any) => String(x)).join('\n- ')}\n\n` +
                      `Fix:\n- Revert/commit those files, then retry Apply patch.`,
                  },
                ],
              },
            }))
          }
        } catch {
          // ignore
        }
        set((s) => ({
          chat: {
            ...s.chat,
            messages: [
              ...s.chat.messages,
              { role: 'assistant', content: `Apply patch failed:\n${t}` },
            ],
          },
        }))
        return { ok: false, error: t }
      }
      set((s) => ({ logs: [...s.logs, '[safe] patch applied'] }))
      return { ok: true }
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      set((s) => ({
        bottomTab: 'errors',
        errors: [...s.errors, `SafePatchError: ${msg}`],
        errorLog: [...s.errorLog, { ts: Date.now(), tag: 'safePatch', text: `SafePatchError: ${msg}` }],
      }))
      set((s) => ({
        chat: {
          ...s.chat,
          messages: [
            ...s.chat.messages,
            { role: 'assistant', content: `Apply patch failed:\n${msg}` },
          ],
        },
      }))
      return { ok: false, error: msg }
    }
  },

  commitAll: async (message) => {
    try {
      const msg = String(message ?? '').trim()
      if (!msg) return { ok: false, error: 'missing_commit_message' }
      const r = await fetch('/api/dev/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      })
      if (!r.ok) {
        const t = await r.text()
        set((s) => ({
          bottomTab: 'errors',
          errors: [...s.errors, `CommitError: ${t}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'git', text: `CommitError: ${t}` }],
        }))
        set((s) => ({
          chat: { ...s.chat, messages: [...s.chat.messages, { role: 'assistant', content: `Commit failed:\n${t}` }] },
        }))
        return { ok: false, error: t }
      }
      set((s) => ({ logs: [...s.logs, `[git] committed: ${msg}`] }))
      set((s) => ({
        chat: { ...s.chat, messages: [...s.chat.messages, { role: 'assistant', content: `Committed:\n${msg}` }] },
      }))
      return { ok: true }
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      set((s) => ({
        bottomTab: 'errors',
        errors: [...s.errors, `CommitError: ${msg}`],
        errorLog: [...s.errorLog, { ts: Date.now(), tag: 'git', text: `CommitError: ${msg}` }],
      }))
      set((s) => ({
        chat: { ...s.chat, messages: [...s.chat.messages, { role: 'assistant', content: `Commit failed:\n${msg}` }] },
      }))
      return { ok: false, error: msg }
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

  runPluginNode: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId) ?? null
    if (!node) return { ok: false, error: 'missing_node' }
    const pluginId = node.data.pluginId

    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, status: 'running' } } : n)),
      logs: [...s.logs, `[run] ${pluginId}: start`],
    }))

    try {
      const r = await fetch('/api/saw/plugins/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugin_id: pluginId,
          inputs: {},
          params: node.data.params ?? {},
        }),
      })
      if (!r.ok) throw new Error(await r.text())
      const j = (await r.json()) as { ok: boolean; outputs: any; logs?: any[]; error?: any }
      const ok = Boolean(j?.ok)
      const logs = Array.isArray(j?.logs) ? j.logs : []
      const ranAt = Date.now()

      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n
          return {
            ...n,
            data: {
              ...n.data,
              status: ok ? 'idle' : 'error',
              runtime: {
                ...(n.data.runtime ?? {}),
                exec: { last: { ok, outputs: j?.outputs ?? {}, logs, error: j?.error ?? null, ranAt } },
              },
            },
          }
        }),
        logs: [
          ...s.logs,
          `[run] ${pluginId}: ${ok ? 'ok' : 'error'}`,
          ...logs.map((l) => `[${pluginId}] ${typeof l === 'string' ? l : JSON.stringify(l)}`),
        ],
        errors: ok ? s.errors : [...s.errors, `PluginRunError: ${pluginId}`],
      }))

      return { ok: true }
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n
          return {
            ...n,
            data: {
              ...n.data,
              status: 'error',
              runtime: {
                ...(n.data.runtime ?? {}),
                exec: { last: { ok: false, outputs: {}, logs: [], error: msg, ranAt: Date.now() } },
              },
            },
          }
        }),
        bottomTab: 'errors',
        errors: [...s.errors, `PluginRunError: ${pluginId}: ${msg}`],
        errorLog: [...s.errorLog, { ts: Date.now(), tag: 'plugin', text: `PluginRunError: ${pluginId}: ${msg}` }],
        logs: [...s.logs, `[run] ${pluginId}: failed (${msg})`],
      }))
      return { ok: false, error: msg }
    }
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
      plan = await requestAiPlan(goal, get().pluginCatalog)
      set((s) => ({
        aiStatus: s.aiStatus ?? { enabled: true, model: 'openai' },
        logs: [...s.logs, ...plan.logs],
      }))
    } catch (e: any) {
      const fallback = generatePlanFallback(goal, get().pluginCatalog)
      plan = fallback
      set((s) => ({
        bottomTab: 'ai',
        logs: [...s.logs, `[planner] openai unavailable; using local fallback (${String(e?.message ?? e)})`],
      }))
    } finally {
      set({ aiBusy: false })
    }

    set((s) => ({
      errors: [...s.errors, ...(plan?.errors ?? [])],
      errorLog: [
        ...s.errorLog,
        ...(plan?.errors ?? []).map((t: string) => ({ ts: Date.now(), tag: 'aiPlan', text: String(t) })),
      ],
      aiMessages: [
        ...s.aiMessages,
        `AI Plan:\n${plan.summary}`,
        ...(plan.suggestionsText ?? []).map((t: string) => `AI: ${t}`),
      ],
    }))

    // Best-effort auto-drop (plan or fallback)
    const suggested: string[] = Array.isArray(plan?.suggestedPlugins) ? plan.suggestedPlugins : []
    if (suggested.length === 0) return

    if (get().layoutMode === 'pipeline') {
      for (const pluginId of suggested) {
        if (!get().pluginCatalog.find((p) => p.id === pluginId)) continue
        get().addNodeFromPluginAtIndex(pluginId, get().nodes.length)
      }
      get().reflowPipeline()
      return
    }

    // Graph mode fallback: keep old horizontal spread
    const base = { x: 120, y: 140 }
    const spacing = 280
    for (const [i, pluginId] of suggested.entries()) {
      if (!get().pluginCatalog.find((p) => p.id === pluginId)) continue
      get().addNodeFromPlugin(pluginId, { x: base.x + i * spacing, y: base.y })
    }
  },

  loadMp3ToNode: async (nodeId, file) => {
    // Decode (real)
    try {
      const original = await decodeAudioFile(file)
      // Upload a WAV version for runtime execution
      let uploadedWavPath: string | null = null
      try {
        const wav = encodeWavFromAudioBuffer(original)
        const fd = new FormData()
        const base = file.name.replace(/\.[^.]+$/, '')
        fd.append('file', wav, `${base || 'audio'}.wav`)
        const r = await fetch('/api/saw/files/upload_audio_wav', { method: 'POST', body: fd })
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as { ok: boolean; path: string }
        uploadedWavPath = String(j.path || '')
      } catch (e: any) {
        uploadedWavPath = null
        set((s) => ({ logs: [...s.logs, `[audio] upload failed: ${String(e?.message ?? e)}`] }))
      }
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
                  uploadedWavPath,
                  original,
                  lastError: null,
                },
              },
            },
          }
        }),
        logs: [...s.logs, `[audio] decoded "${file.name}"`, ...(uploadedWavPath ? [`[audio] uploaded wav: ${uploadedWavPath}`] : [])],
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
        errorLog: [...s.errorLog, { ts: Date.now(), tag: 'audio', text: `AudioDecodeError: ${String(e?.message ?? e)}` }],
      }))
    }
  },

  recomputeLowpass: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node || node.data.pluginId !== 'audio_lowpass') return
    const original = node.data.runtime?.audio?.original ?? null
    if (!original) return
    const uploadedWavPath = node.data.runtime?.audio?.uploadedWavPath ?? null
    if (!uploadedWavPath) return

    const cutoff = Number(node.data.params['cutoff_hz'] ?? 1200)
    try {
      const r = await fetch('/api/saw/plugins/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugin_id: 'audio_lowpass',
          inputs: { wav_path: { data: uploadedWavPath, metadata: {} } },
          params: { cutoff_hz: cutoff },
        }),
      })
      if (!r.ok) throw new Error(await r.text())
      const j = (await r.json()) as { ok: boolean; outputs: any; logs?: any[] }
      const audio = j?.outputs?.audio?.data
      const sr = Number(audio?.sample_rate_hz ?? original.sampleRate)
      const samples = (audio?.samples ?? []) as number[][]
      const filtered = audioBufferFromPcm(samples, sr)
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
        logs: [...s.logs, `[audio] rendered lowpass (runtime) @ ${Math.round(cutoff)} Hz`],
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
        errors: [...s.errors, `AudioRuntimeError: ${String(e?.message ?? e)}`],
        errorLog: [...s.errorLog, { ts: Date.now(), tag: 'audio', text: `AudioRuntimeError: ${String(e?.message ?? e)}` }],
      }))
    }
  },
}))

// Preserve app state across Vite HMR updates while still picking up NEW actions/state fields.
// Strategy: if an old store exists, migrate its state into the newly created store,
// then replace the global pointer with the new store.
const STORE_KEY = '__SAW_ZUSTAND_STORE__'
const existingStore = (globalThis as any)[STORE_KEY] as any
if (existingStore?.getState) {
  const prev = existingStore.getState() as any
  // Merge previous state onto fresh defaults so newly-added fields exist.
  _useSawStore.setState({ ..._useSawStore.getState(), ...prev } as any, true)
}
export const useSawStore: typeof _useSawStore = _useSawStore;
(globalThis as any)[STORE_KEY] = useSawStore;

// Persist a small subset across full page reloads (commit/HMR edge cases).
try {
  const KEY = '__SAW_PERSIST__'
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(KEY)
    if (raw) {
      const j = JSON.parse(raw) as any
      const cur = useSawStore.getState() as any
      // IMPORTANT: merge into the existing store state (do NOT replace), otherwise we can wipe required fields like `layout`.
      useSawStore.setState({
        chat: j.chat ?? cur.chat,
        dev: { ...(cur.dev ?? {}), ...(j.dev ?? {}) },
        logs: j.logs ?? cur.logs,
        errors: j.errors ?? cur.errors,
        errorLog: j.errorLog ?? cur.errorLog,
        bottomTab: j.bottomTab ?? cur.bottomTab,
      } as any)
    }
    useSawStore.subscribe((s) => {
      window.localStorage.setItem(
        KEY,
        JSON.stringify({
          chat: { messages: (s.chat?.messages ?? []).slice(-60) },
          dev: { attachedPaths: s.dev?.attachedPaths ?? [] },
          logs: (s.logs ?? []).slice(-120),
          errors: (s.errors ?? []).slice(-120),
          errorLog: (s.errorLog ?? []).slice(-200),
          bottomTab: s.bottomTab,
        }),
      )
    })
  }
} catch {
  // ignore
}


