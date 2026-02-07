import type { Node } from 'reactflow'

export type Port = {
  id: string
  name: string
  type: string
}

export type ParamKind = 'text' | 'number' | 'select'

export type PluginParameterDefinition = {
  id: string
  label: string
  kind: ParamKind
  default: string | number
  options?: string[]
  min?: number
  max?: number
}

export type PluginUiConfig = {
  mode: 'schema' | 'bundle'
  schema_file?: string
  bundle_file?: string
  sandbox?: boolean
}

export type UtilityLaunchExpect = {
  type: 'url'
  output_path: string
}

export type UtilityLaunchApp = {
  kind?: 'streamlit' | 'http'
  healthcheck?: string
}

export type UtilityLaunchSession = {
  allow_multiple?: boolean
  reuse_when_open?: boolean
}

export type UtilityLaunchSpec = {
  action?: 'run_plugin'
  open_target?: 'new_tab'
  expect?: UtilityLaunchExpect
  app?: UtilityLaunchApp
  session?: UtilityLaunchSession
}

export type UtilitySpec = {
  kind?: 'external_tab'
  label?: string
  description?: string
  menu_path?: string[]
  icon?: string
  launch?: UtilityLaunchSpec
}

export type PluginDefinition = {
  id: string
  name: string
  version: string
  description: string
  /**
   * Directory-like grouping, intended to match eventual importable package paths.
   * Example: "audio/processors" or "neural/processors"
   */
  categoryPath: string
  /**
   * Repo source files that implement this module's current frontend behavior.
   * These paths are used for in-GUI "Source" viewing.
   */
  sourcePaths?: string[]
  /**
   * Workspace/runtime metadata (provided by SAW API for discovered plugins).
   */
  locked?: boolean
  origin?: 'stock' | 'dev'
  integrity?: { expected: string; actual: string; restored: boolean } | null
  ui?: PluginUiConfig | null
  utility?: UtilitySpec | null
  meta?: Record<string, any> | null
  inputs: Port[]
  outputs: Port[]
  parameters: PluginParameterDefinition[]
}

export type NodeStatus = 'idle' | 'running' | 'error'

export type CodeIndex = {
  classes: { name: string; methods: string[]; attributes: string[] }[]
  functions: { name: string; signature: string }[]
}

export type GitPreview = {
  base: string
  current: string
  diff: string
  commitMessage: string
}

export type AudioRuntime = {
  fileName: string | null
  uploadedWavPath?: string | null
  original: AudioBuffer | null
  filtered: AudioBuffer | null
  lastError: string | null
}

export type NodeUiRuntime = {
  /**
   * Height (px) of the module view area when this node is active in Pipeline layout.
   */
  viewHeight: number
}

export type ExecRuntime = {
  last?: {
    ok: boolean
    outputs: any
    logs: any[]
    rawStdout?: string
    rawStderr?: string
    error?: string | null
    ranAt: number
  } | null
}

export type PluginNodeData = {
  pluginId: string
  title: string
  status: NodeStatus
  inputs: Record<string, string | number>
  params: Record<string, string | number>
  /**
   * handleId -> type
   * ex: "in:df" -> "DataFrame"
   */
  portTypes: Record<string, string>
  code: string
  codeIndex: CodeIndex
  git: GitPreview
  runtime?: {
    audio?: AudioRuntime
    ui?: NodeUiRuntime
    exec?: ExecRuntime
  }
}

export type PluginNode = Node<PluginNodeData, 'pluginNode'>
