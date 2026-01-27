import { describe, expect, it } from 'vitest'
import { DeclarativeUiDocumentSchema } from '../declarativeUiTypes'

describe('Declarative UI document schema', () => {
  it('accepts a minimal Declarative UI document', () => {
    const raw = {
      declarative_ui_spec_version: '0.1',
      view: { type: 'Stack', props: { gap: 'md' }, children: [] },
    }

    const parsed = DeclarativeUiDocumentSchema.parse(raw)
    expect(parsed.declarative_ui_spec_version).toBe('0.1')
    expect(parsed.view.type).toBe('Stack')
  })

  it('rejects unknown versions', () => {
    const raw = { declarative_ui_spec_version: '0.2', view: { type: 'Stack' } }
    expect(() => DeclarativeUiDocumentSchema.parse(raw)).toThrow()
  })
})
