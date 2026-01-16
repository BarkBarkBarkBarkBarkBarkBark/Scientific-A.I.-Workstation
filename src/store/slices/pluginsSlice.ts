import type { SawState } from '../storeTypes'
import { fetchWorkspacePlugins } from '../../plugins/workspace'
import { mergeCatalog } from '../utils/catalog'

export function createPluginsSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<SawState, 'workspacePlugins' | 'pluginCatalog' | 'refreshWorkspacePlugins'> {
  return {
    workspacePlugins: [],
    pluginCatalog: mergeCatalog([]),

    refreshWorkspacePlugins: async () => {
      try {
        const ws = await fetchWorkspacePlugins()
        set({ workspacePlugins: ws, pluginCatalog: mergeCatalog(ws) })
        set((s) => ({ logs: [...s.logs, `[plugins] loaded workspace plugins (${ws.length})`] }))
      } catch (e: any) {
        const msg = String(e?.message ?? e)
        set((s) => ({ logs: [...s.logs, `[plugins] workspace fetch failed: ${msg}`] }))
      }
    },
  }
}
