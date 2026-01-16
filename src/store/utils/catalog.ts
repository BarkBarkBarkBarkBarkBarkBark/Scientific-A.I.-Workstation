import type { PluginDefinition } from '../../types/saw'

export function mergeCatalog(workspace: PluginDefinition[]) {
  return [...workspace]
}

export function getPluginFromCatalog(catalog: PluginDefinition[], pluginId: string): PluginDefinition | null {
  return catalog.find((p) => p.id === pluginId) ?? null
}
