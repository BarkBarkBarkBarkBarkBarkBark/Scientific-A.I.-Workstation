import type { PluginDefinition, PluginParameterDefinition, Port } from '../types/saw'

export type WorkspacePluginListItem = {
  id: string
  name: string
  version: string
  description: string
  category_path?: string
  plugin_dir_rel?: string
  inputs?: Array<{ id: string; name: string; type: string }>
  outputs?: Array<{ id: string; name: string; type: string }>
  parameters?: Array<{ id: string; label: string; kind: 'text' | 'number' | 'select'; default: any; options?: string[]; min?: number; max?: number }>
}

export async function fetchWorkspacePlugins(apiBase = 'http://127.0.0.1:5127'): Promise<PluginDefinition[]> {
  // Prefer same-origin Vite proxy to avoid CORS/origin mismatches.
  const url =
    apiBase.startsWith('/api/')
      ? `${apiBase.replace(/\/$/, '')}/plugins/list`
      : '/api/saw/plugins/list'

  const r = await fetch(url)
  if (!r.ok) throw new Error(await r.text())
  const j = (await r.json()) as { ok: boolean; plugins: WorkspacePluginListItem[] }
  const plugins = Array.isArray(j?.plugins) ? j.plugins : []

  const toPorts = (arr: WorkspacePluginListItem['inputs']): Port[] =>
    (arr ?? []).map((p) => ({ id: String(p.id), name: String(p.name ?? p.id), type: String(p.type) }))

  const toParams = (arr: WorkspacePluginListItem['parameters']): PluginParameterDefinition[] =>
    (arr ?? []).map((p) => ({
      id: String(p.id),
      label: String(p.label ?? p.id),
      kind: p.kind === 'number' || p.kind === 'select' ? p.kind : 'text',
      default: p.default ?? '',
      options: Array.isArray(p.options) ? p.options.map(String) : undefined,
      min: typeof p.min === 'number' ? p.min : undefined,
      max: typeof p.max === 'number' ? p.max : undefined,
    }))

  return plugins.map((p) => {
    const pluginDir = String(p.plugin_dir_rel ?? '').replaceAll('\\', '/')
    const sourcePaths = pluginDir
      ? [`${pluginDir}/plugin.yaml`, `${pluginDir}/wrapper.py`]
      : undefined

    return {
      id: String(p.id),
      name: String(p.name),
      version: String(p.version),
      description: String(p.description),
      categoryPath: String(p.category_path || 'workspace/runtime'),
      sourcePaths,
      inputs: toPorts(p.inputs),
      outputs: toPorts(p.outputs),
      parameters: toParams(p.parameters),
    } satisfies PluginDefinition
  })
}


