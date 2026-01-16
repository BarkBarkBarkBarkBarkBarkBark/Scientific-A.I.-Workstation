import type { PluginNodeData, PluginDefinition } from '../../types/saw'
import { getPluginFromCatalog } from './catalog'

export function makeNodeData(catalog: PluginDefinition[], pluginId: string): PluginNodeData {
  const p = getPluginFromCatalog(catalog, pluginId)
  if (!p) {
    // Fallback stub so UI doesn't crash; node will show unknown plugin id.
    return {
      pluginId,
      title: pluginId,
      status: 'error',
      inputs: {},
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
  const inputs: Record<string, string | number> = {}
  for (const input of p.inputs) inputs[input.id] = ''

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
    inputs,
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
