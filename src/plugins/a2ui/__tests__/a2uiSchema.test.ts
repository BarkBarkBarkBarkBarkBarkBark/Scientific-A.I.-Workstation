import { describe, expect, it } from 'vitest'
import { A2uiDocumentSchema } from '../a2uiTypes'

describe('A2UI document schema', () => {
  it('accepts a minimal A2UI document', () => {
    const raw = {
      a2ui_spec_version: '0.1',
      view: { type: 'Stack', props: { gap: 'md' }, children: [] },
    }

    const parsed = A2uiDocumentSchema.parse(raw)
    expect(parsed.a2ui_spec_version).toBe('0.1')
    expect(parsed.view.type).toBe('Stack')
  })

  it('rejects unknown versions', () => {
    const raw = { a2ui_spec_version: '0.2', view: { type: 'Stack' } }
    expect(() => A2uiDocumentSchema.parse(raw)).toThrow()
  })
})
