import { describe, it, expect } from 'vitest'
import { PluginManifestSchema, buildDiceRollerManifest, buildCreatePluginToolArgsFromPython } from '../actions/createPlugin'

describe('Plugin manifest schema', () => {
  it('accepts a valid dice-roller manifest', () => {
    const m = buildDiceRollerManifest({ pluginId: 'saw.generated.dice-roller' })
    const parsed = PluginManifestSchema.parse(m)
    expect(parsed.id).toBe('saw.generated.dice-roller')
    expect(Object.keys(parsed.params)).toContain('num_dice')
    expect(Object.keys(parsed.outputs)).toContain('rolls')
  })

  it('rejects invalid side_effects.disk', () => {
    const m = buildDiceRollerManifest({ pluginId: 'bad.disk' })
    // Force an invalid value
    // @ts-expect-error test invalid value
    m.side_effects.disk = 'none'
    expect(() => PluginManifestSchema.parse(m)).toThrow()
  })

  it('requires entrypoint and environment', () => {
    const m = buildDiceRollerManifest({ pluginId: 'saw.generated.dice-roller' })
    // @ts-expect-error remove entrypoint
    delete (m as any).entrypoint
    expect(() => PluginManifestSchema.parse(m)).toThrow()
  })

  it('builds create_plugin tool args with a JSON manifest object', () => {
    const args = buildCreatePluginToolArgsFromPython({
      pluginId: 'drawing.deck.plugin',
      name: 'Drawing from Deck Plugin',
      description: 'A plugin that simulates drawing from a 52 card deck without replacement.',
      categoryPath: 'games',
      pythonCode: 'def run(file_path: str, params: dict, context) -> dict:\n    return {"ok": True}\n',
      inputId: 'file',
      inputType: 'path',
      outputId: 'result',
      outputType: 'object',
      pip: [],
      threads: 1,
    })

    // Manifest is an object (not YAML string)
    expect(typeof args.manifest).toBe('object')
    expect(args.manifest.id).toBe('drawing.deck.plugin')
    PluginManifestSchema.parse(args.manifest)

    expect(typeof args.wrapper_code).toBe('string')
    expect(args.wrapper_code).toContain('SAW Workspace Plugin (generated)')
  })
})
