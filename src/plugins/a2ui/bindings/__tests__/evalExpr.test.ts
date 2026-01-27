import { describe, expect, it } from 'vitest'
import { evalExpr } from '../evalExpr'

describe('evalExpr', () => {
  const ctx = {
    node: { data: { status: 'error', params: { patient: '  P1  ' } } },
    computed: { rawSessionDir: '/tmp/raw' },
    uiState: { status: { uploaded: true } },
    document: { title: 'X' },
  }

  it('resolves binding paths', () => {
    expect(evalExpr('${node.data.status}', ctx)).toBe('error')
    expect(evalExpr('${computed.rawSessionDir}', ctx)).toBe('/tmp/raw')
    expect(evalExpr('${uiState.status.uploaded}', ctx)).toBe(true)
  })

  it('supports strict convenience comparisons', () => {
    expect(evalExpr("${node.data.status == 'error'}", ctx)).toBe(true)
    expect(evalExpr("${node.data.status != 'error'}", ctx)).toBe(false)
  })

  it('supports core ops', () => {
    expect(
      evalExpr(
        {
          op: 'concat',
          args: ['raw: ', '${computed.rawSessionDir}'],
        },
        ctx,
      ),
    ).toBe('raw: /tmp/raw')

    expect(evalExpr({ op: 'trim', args: ['${node.data.params.patient}'] }, ctx)).toBe('P1')
    expect(evalExpr({ op: 'len', args: [{ op: 'trim', args: ['${node.data.params.patient}'] }] }, ctx)).toBe(2)

    expect(evalExpr({ op: 'eq', args: ['${node.data.status}', 'error'] }, ctx)).toBe(true)
    expect(evalExpr({ op: 'and', args: ['${uiState.status.uploaded}', true] }, ctx)).toBe(true)
    expect(evalExpr({ op: 'not', args: ['${uiState.status.uploaded}'] }, ctx)).toBe(false)

    expect(
      evalExpr(
        {
          op: 'if',
          args: [{ op: 'eq', args: ['${node.data.status}', 'running'] }, 'Running', 'Idle'],
        },
        ctx,
      ),
    ).toBe('Idle')
  })
})
