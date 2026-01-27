import type { A2uiDocument, A2uiExpr } from '../a2uiTypes'

export type A2uiRenderContext = {
  nodeId: string
  pluginId: string

  // Bindings surface
  node: any
  computed: Record<string, any>
  uiState: Record<string, any>
  document: A2uiDocument

  // Dispatch surface
  dispatch: (args: { action: string; event?: any }) => void

  // Helpers
  eval: (expr: A2uiExpr) => any
}
