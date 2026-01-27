import type { DeclarativeUiDocument, DeclarativeUiExpr } from '../declarativeUiTypes'

export type DeclarativeUiRenderContext = {
  nodeId: string
  pluginId: string

  // Bindings surface
  node: any
  computed: Record<string, any>
  uiState: Record<string, any>
  document: DeclarativeUiDocument

  // Dispatch surface
  dispatch: (args: { action: string; event?: any }) => void

  // Helpers
  eval: (expr: DeclarativeUiExpr) => any
}
