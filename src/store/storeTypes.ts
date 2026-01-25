import type { Edge, EdgeChange, NodeChange, XYPosition, Connection } from 'reactflow'
import type { PluginDefinition, PluginNode } from '../types/saw'
import type { AiStatus } from '../types/ai'
import type { AgentToolCall, ChatMessage } from '../ai/client'
import type { PatchProposal } from '../types/patch'

export type BottomTab = 'logs' | 'errors' | 'ai' | 'chat' | 'dev' | 'todo'
export type LayoutMode = 'pipeline' | 'graph'

export type FullscreenState = {
  open: boolean
  nodeId: string | null
}

export type SawState = {
  // Graph
  nodes: PluginNode[]
  edges: Edge[]
  selectedNodeId: string | null
  editableMode: boolean
  fullscreen: FullscreenState

  // UI
  bottomTab: BottomTab
  layoutMode: LayoutMode
  layout: {
    leftWidth: number
    leftWidthOpen: number
    leftCollapsed: boolean
    rightWidth: number
    rightWidthOpen: number
    rightCollapsed: boolean
    bottomHeight: number

    // Bottom console split view
    bottomChatWidth: number

    // Additional resizable panes
    patchReviewFilesWidth: number
    pluginBuilderSettingsWidth: number
    moduleFullscreenLeftWidth: number
    moduleFullscreenDirTreeWidth: number
    todoEditorWidth: number
  }
  consoleFullscreen: boolean

  // Console
  logs: string[]
  errors: string[]
  errorLog: Array<{ ts: number; tag: string; text: string }>

  // AI
  goalText: string
  aiMessages: string[]
  aiBusy: boolean
  aiStatus: AiStatus | null

  // Chat
  chatBusy: boolean
  chat: {
    messages: ChatMessage[]
    conversationId: string | null
    pendingTool: AgentToolCall | null
    streamMode?: 'sse' | 'json'
    provider?: string | null
    desiredProvider?: 'copilot' | 'openai'
  }

  // Dev / patch engine
  dev: { attachedPaths: string[]; lastForbidden?: { op: string; path: string; patch?: string } | null }
  patchReview: { open: boolean; busy: boolean; proposal: PatchProposal | null; lastError?: string }

  // Plugins
  workspacePlugins: PluginDefinition[]
  pluginCatalog: PluginDefinition[]

  // Actions
  refreshWorkspacePlugins: () => Promise<void>
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  setSelectedNodeId: (id: string | null) => void
  setEditableMode: (enabled: boolean) => void
  setBottomTab: (tab: BottomTab) => void
  clearErrors: () => void
  setGoalText: (text: string) => void
  setLayoutMode: (mode: LayoutMode) => void
  setLayout: (patch: Partial<SawState['layout']>) => void
  toggleLeftSidebar: () => void
  toggleRightSidebar: () => void
  openConsoleFullscreen: () => void
  closeConsoleFullscreen: () => void

  addNodeFromPlugin: (pluginId: string, position: XYPosition) => string
  addNodeFromPluginAtIndex: (pluginId: string, index: number) => string
  moveNodeInPipeline: (fromIndex: number, toIndex: number) => void
  deleteNode: (nodeId: string) => void
  deleteSelectedNode: () => void
  reflowPipeline: () => void
  isValidConnection: (c: Connection) => boolean
  tryAddEdge: (c: Connection) => void
  updateNodeParam: (nodeId: string, paramId: string, value: string | number) => void
  updateNodeInput: (nodeId: string, inputId: string, value: string | number) => void
  openFullscreen: (nodeId: string) => void
  closeFullscreen: () => void

  refreshAiStatus: () => Promise<void>
  submitGoal: (goal: string) => Promise<void>

  sendChat: (text: string) => Promise<void>
  setChatProvider: (provider: 'copilot' | 'openai') => void
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

  // Execution / node UI
  setNodeViewHeight: (nodeId: string, height: number) => void
  runPluginNode: (nodeId: string) => Promise<{ ok: boolean; error?: string }>

  // Audio
  loadMp3ToNode: (nodeId: string, file: File) => Promise<void>
  recomputeLowpass: (nodeId: string) => Promise<void>
}
