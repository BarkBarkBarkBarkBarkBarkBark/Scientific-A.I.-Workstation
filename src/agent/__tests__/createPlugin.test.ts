import { describe, it, expect } from 'vitest'
import { PluginManifestSchema, buildDiceRollerManifest } from '../actions/createPlugin'

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
})
