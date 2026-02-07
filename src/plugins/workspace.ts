import type { PluginDefinition, PluginParameterDefinition, Port } from '../types/saw'

export type WorkspacePluginListItem = {
  id: string
  name: string
  version: string
  description: string
  category_path?: string
  plugin_dir_rel?: string
  locked?: boolean
  origin?: 'stock' | 'dev'
  integrity?: { expected: string; actual: string; restored: boolean } | null
  ui?: { mode?: 'schema' | 'bundle'; schema_file?: string; bundle_file?: string; sandbox?: boolean } | null
  utility?: {
    kind?: 'external_tab'
    label?: string
    description?: string
    menu_path?: string[]
    icon?: string
    launch?: {
      action?: 'run_plugin'
      open_target?: 'new_tab'
      expect?: { type?: 'url'; output_path?: string }
      app?: { kind?: 'streamlit' | 'http'; healthcheck?: string }
      session?: { allow_multiple?: boolean; reuse_when_open?: boolean }
    }
  } | null
  meta?: Record<string, any> | null
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
      locked: Boolean(p.locked),
      origin: p.origin === 'stock' ? 'stock' : 'dev',
      integrity: p.integrity ?? null,
      meta: p.meta && typeof p.meta === 'object' ? p.meta : null,
      ui:
        p.ui && (p.ui.mode === 'schema' || p.ui.mode === 'bundle')
          ? {
              mode: p.ui.mode,
              schema_file: typeof p.ui.schema_file === 'string' ? p.ui.schema_file : undefined,
              bundle_file: typeof p.ui.bundle_file === 'string' ? p.ui.bundle_file : undefined,
              sandbox: typeof p.ui.sandbox === 'boolean' ? p.ui.sandbox : undefined,
            }
          : null,
      utility:
        p.utility && typeof p.utility === 'object'
          ? {
              kind: p.utility.kind === 'external_tab' ? 'external_tab' : undefined,
              label: typeof p.utility.label === 'string' ? p.utility.label : undefined,
              description: typeof p.utility.description === 'string' ? p.utility.description : undefined,
              menu_path: Array.isArray(p.utility.menu_path) ? p.utility.menu_path.map(String) : undefined,
              icon: typeof p.utility.icon === 'string' ? p.utility.icon : undefined,
              launch:
                p.utility.launch && typeof p.utility.launch === 'object'
                  ? {
                      action: p.utility.launch.action === 'run_plugin' ? 'run_plugin' : undefined,
                      open_target: p.utility.launch.open_target === 'new_tab' ? 'new_tab' : undefined,
                      expect:
                        p.utility.launch.expect &&
                        typeof p.utility.launch.expect === 'object' &&
                        p.utility.launch.expect.type === 'url' &&
                        typeof p.utility.launch.expect.output_path === 'string'
                          ? { type: 'url', output_path: String(p.utility.launch.expect.output_path) }
                          : undefined,
                      app:
                        p.utility.launch.app && typeof p.utility.launch.app === 'object'
                          ? {
                              kind:
                                p.utility.launch.app.kind === 'streamlit' || p.utility.launch.app.kind === 'http'
                                  ? p.utility.launch.app.kind
                                  : undefined,
                              healthcheck:
                                typeof p.utility.launch.app.healthcheck === 'string'
                                  ? p.utility.launch.app.healthcheck
                                  : undefined,
                            }
                          : undefined,
                      session:
                        p.utility.launch.session && typeof p.utility.launch.session === 'object'
                          ? {
                              allow_multiple:
                                typeof p.utility.launch.session.allow_multiple === 'boolean'
                                  ? p.utility.launch.session.allow_multiple
                                  : undefined,
                              reuse_when_open:
                                typeof p.utility.launch.session.reuse_when_open === 'boolean'
                                  ? p.utility.launch.session.reuse_when_open
                                  : undefined,
                            }
                          : undefined,
                    }
                  : undefined,
            }
          : null,
      inputs: toPorts(p.inputs),
      outputs: toPorts(p.outputs),
      parameters: toParams(p.parameters),
    } satisfies PluginDefinition
  })
}

