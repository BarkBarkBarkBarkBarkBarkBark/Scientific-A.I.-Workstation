import { z } from 'zod'

// Align with backend schema (services/saw_api/app/plugins_runtime.py)
export const SideEffectNetwork = z.enum(['none', 'restricted', 'allowed'])
export const SideEffectDisk = z.enum(['read_only', 'read_write'])
export const SideEffectSubprocess = z.enum(['forbidden', 'allowed'])
export const GpuPolicy = z.enum(['forbidden', 'optional', 'required'])

export const EntrypointSchema = z.object({
  file: z.string().min(1),
  callable: z.string().min(1),
})

export const EnvironmentSpecSchema = z.object({
  python: z.string().min(1),
  pip: z.array(z.string()).default([]),
  lockfile: z.string().optional().nullable(),
  requirements: z.string().optional().nullable(),
})

export const IoSpecSchema = z.object({
  type: z.string().min(1),
  dtype: z.string().optional().nullable(),
  shape: z.array(z.string()).optional().nullable(),
  ui: z.record(z.any()).optional().nullable(),
  default: z.any().optional().nullable(),
})

export const ExecutionSpecSchema = z.object({
  deterministic: z.boolean().default(true),
  cacheable: z.boolean().default(true),
})

export const SideEffectsSpecSchema = z.object({
  network: SideEffectNetwork,
  disk: SideEffectDisk,
  subprocess: SideEffectSubprocess,
})

export const ResourcesSpecSchema = z.object({
  gpu: GpuPolicy,
  threads: z.number().int().positive().optional(),
})

export const PluginUiSpecSchema = z.object({
  mode: z.enum(['schema', 'bundle']).default('schema'),
  schema_file: z.string().default('ui/a2ui.yaml'),
  bundle_file: z.string().default('ui/ui.bundle.js'),
  sandbox: z.boolean().default(true),
})

export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  category_path: z.string().optional().nullable(),
  locked: z.boolean().optional().nullable(),
  entrypoint: EntrypointSchema,
  environment: EnvironmentSpecSchema,
  inputs: z.record(IoSpecSchema),
  params: z.record(IoSpecSchema),
  outputs: z.record(IoSpecSchema),
  execution: ExecutionSpecSchema,
  side_effects: SideEffectsSpecSchema,
  resources: ResourcesSpecSchema,
  ui: PluginUiSpecSchema.optional().nullable(),
})

export type PluginManifest = z.infer<typeof PluginManifestSchema>

export type CreatePluginToolArgs = {
  manifest: PluginManifest
  wrapper_code: string
  readme: string
}

export type CreateDiceRollerParams = {
  pluginId: string
  name?: string
  description?: string
  categoryPath?: string
  numDiceDefault?: number
  numSidesDefault?: number
}

export function buildDiceRollerManifest(p: CreateDiceRollerParams): PluginManifest {
  const id = p.pluginId
  const name = p.name ?? 'Dice Roller'
  const version = '0.1.0'
  const description = p.description ?? 'A plugin to simulate rolling dice.'
  const category_path = p.categoryPath ?? 'games'

  const manifest: PluginManifest = {
    id,
    name,
    version,
    description,
    category_path,
    entrypoint: { file: 'wrapper.py', callable: 'main' },
    environment: { python: '>=3.11,<3.13', pip: [] },
    inputs: {},
    params: {
      num_dice: { type: 'number', default: p.numDiceDefault ?? 1, ui: { label: 'Number of dice to roll' } },
      num_sides: { type: 'number', default: p.numSidesDefault ?? 6, ui: { label: 'Number of sides on the dice' } },
    },
    outputs: { rolls: { type: 'array' } },
    execution: { deterministic: true, cacheable: true },
    side_effects: { network: 'none', disk: 'read_only', subprocess: 'forbidden' },
    resources: { gpu: 'forbidden', threads: 1 },
    ui: { mode: 'schema', schema_file: 'ui/a2ui.yaml', bundle_file: 'ui/ui.bundle.js', sandbox: true },
  }

  // Runtime validation; throws if invalid
  PluginManifestSchema.parse(manifest)
  return manifest
}

export function buildDiceRollerWrapper(): string {
  return (
    'from __future__ import annotations\n' +
    'import random\n\n' +
    'def main(inputs: dict, params: dict, context) -> dict:\n' +
    "    try:\n        num_dice = int((params or {}).get('num_dice', 1))\n    except Exception:\n        num_dice = 1\n" +
    "    try:\n        num_sides = int((params or {}).get('num_sides', 6))\n    except Exception:\n        num_sides = 6\n" +
    '    num_dice = max(1, num_dice)\n' +
    '    num_sides = max(2, num_sides)\n' +
    '    rolls = [random.randint(1, num_sides) for _ in range(num_dice)]\n' +
    '    context.log("info", "dice_roller:rolls", rolls=rolls, num_dice=num_dice, num_sides=num_sides)\n' +
    '    return {"rolls": {"data": rolls, "metadata": {"count": len(rolls)}}}\n'
  )
}

function buildGeneratedWrapperFromUserCode(args: {
  pythonCode: string
  inputId: string
  outputId: string
}): string {
  const userCode = (args.pythonCode ?? '').replace(/\s+$/, '') + '\n'
  return (
    '"""SAW Workspace Plugin (generated)\n\n' +
    'Edit this file to integrate your lab code.\n\n' +
    'You can provide either:\n' +
    '  - def main(inputs: dict, params: dict, context) -> dict\n' +
    'or\n' +
    '  - def run(file_path: str, params: dict, context) -> dict\n\n' +
    `Default input key: "${args.inputId}" (expects inputs["${args.inputId}"]["data"])\n` +
    `Default output key: "${args.outputId}"\n` +
    '"""\n\n' +
    'from __future__ import annotations\n\n' +
    'from typing import Any\n\n' +
    '# --- user code (start) ---\n' +
    userCode +
    '# --- user code (end) ---\n\n' +
    "_USER_MAIN = globals().get('main')\n" +
    "_USER_RUN = globals().get('run')\n\n" +
    'def main(inputs: dict, params: dict, context) -> dict:\n' +
    '    # Prefer user-defined main() if present.\n' +
    '    if callable(_USER_MAIN):\n' +
    '        return _USER_MAIN(inputs, params, context)\n' +
    '    # Fallback: call user-defined run(file_path, params, context)\n' +
    '    if callable(_USER_RUN):\n' +
    `        x = (inputs or {}).get('${args.inputId}') or {}\n` +
    '        file_path = x.get(' + "'data'" + ')\n' +
    `        return {'${args.outputId}': {'data': _USER_RUN(file_path, params or {}, context), 'metadata': {}}}\n` +
    "    raise RuntimeError('missing_entrypoint: define main(inputs, params, context) or run(file_path, params, context)')\n"
  )
}

/**
 * Build arguments for the backend agent tool `create_plugin`.
 *
 * Key point: returns a JSON manifest object (not YAML text), which avoids
 * accidental stringification in tool calls.
 */
export function buildCreatePluginToolArgsFromPython(args: {
  pluginId: string
  name?: string
  description?: string
  categoryPath?: string | null
  pythonCode: string
  inputId?: string
  inputType?: string
  outputId?: string
  outputType?: string
  pip?: string[]
  sideEffects?: { network?: 'none' | 'restricted' | 'allowed'; disk?: 'read_only' | 'read_write'; subprocess?: 'forbidden' | 'allowed' }
  threads?: number
}): CreatePluginToolArgs {
  const inputId = args.inputId ?? 'file'
  const outputId = args.outputId ?? 'result'

  const manifest: PluginManifest = {
    id: args.pluginId,
    name: args.name ?? args.pluginId,
    version: '0.1.0',
    description: args.description ?? '',
    category_path: args.categoryPath ?? null,
    entrypoint: { file: 'wrapper.py', callable: 'main' },
    environment: { python: '>=3.11,<3.13', pip: args.pip ?? [] },
    inputs: { [inputId]: { type: args.inputType ?? 'path' } },
    params: {},
    outputs: { [outputId]: { type: args.outputType ?? 'object' } },
    execution: { deterministic: false, cacheable: false },
    side_effects: {
      network: args.sideEffects?.network ?? 'none',
      disk: args.sideEffects?.disk ?? 'read_only',
      subprocess: args.sideEffects?.subprocess ?? 'forbidden',
    },
    resources: { gpu: 'forbidden', threads: args.threads ?? 1 },
    ui: { mode: 'schema', schema_file: 'ui/a2ui.yaml', bundle_file: 'ui/ui.bundle.js', sandbox: true },
  }

  PluginManifestSchema.parse(manifest)

  const wrapper_code = buildGeneratedWrapperFromUserCode({
    pythonCode: args.pythonCode,
    inputId,
    outputId,
  })

  const readme = `# ${manifest.name}\n\n${manifest.description || ''}\n`

  return { manifest, wrapper_code, readme }
}

export async function createPluginFromPython(apiBase: string, args: {
  pluginId: string
  name?: string
  description?: string
  categoryPath?: string | null
  pythonCode: string
  inputId?: string
  inputType?: string
  outputId?: string
  outputType?: string
  pip?: string[]
  sideEffects?: { network?: 'none' | 'restricted' | 'allowed'; disk?: 'read_only' | 'read_write'; subprocess?: 'forbidden' | 'allowed' }
  threads?: number
  probe?: boolean
  probeEnsureEnv?: boolean
}): Promise<Response> {
  const url = apiBase.startsWith('/api/') ? `${apiBase.replace(/\/$/, '')}/plugins/create_from_python` : '/api/saw/plugins/create_from_python'
  const body = {
    plugin_id: args.pluginId,
    name: args.name ?? args.pluginId,
    description: args.description ?? '',
    category_path: args.categoryPath ?? null,
    version: '0.1.0',
    python_code: args.pythonCode,
    input_id: args.inputId ?? 'file',
    input_type: args.inputType ?? 'path',
    output_id: args.outputId ?? 'result',
    output_type: args.outputType ?? 'object',
    pip: args.pip ?? [],
    side_effects_network: args.sideEffects?.network ?? 'none',
    side_effects_disk: args.sideEffects?.disk ?? 'read_only',
    side_effects_subprocess: args.sideEffects?.subprocess ?? 'forbidden',
    threads: args.threads ?? 1,
    probe: args.probe ?? true,
    probe_ensure_env: args.probeEnsureEnv ?? true,
  }
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export async function createDiceRollerPlugin(apiBase = '/api/saw'): Promise<Response> {
  const m = buildDiceRollerManifest({ pluginId: 'saw.generated.dice-roller' })
  const wrapper = buildDiceRollerWrapper()
  // Leverage server helper to write files correctly
  return createPluginFromPython(apiBase, {
    pluginId: m.id,
    name: m.name,
    description: m.description,
    categoryPath: m.category_path ?? undefined,
    pythonCode: wrapper,
    inputId: 'file',
    inputType: 'path',
    outputId: 'result',
    outputType: 'object',
    pip: m.environment.pip,
    sideEffects: m.side_effects,
    threads: m.resources.threads ?? 1,
    probe: true,
    probeEnsureEnv: true,
  })
}
