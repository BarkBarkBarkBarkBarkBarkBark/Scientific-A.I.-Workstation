import { describe, expect, it } from 'vitest'
import { dispatchDeclarativeUiAction } from '../actionRuntime'

describe('dispatchDeclarativeUiAction', () => {
  it('executes sequence + conditional runStep from doc', async () => {
    const calls: any[] = []

    const document = {
      actions: [
        {
          id: 'runStep',
          kind: 'sequence',
          steps: [
            {
              kind: 'conditional',
              if: { op: 'neq', args: ['${event.step}', 'upload'] },
              then: [
                {
                  kind: 'state.updateNodeParam',
                  input: { nodeId: '${node.id}', key: 'recording_path', value: '' },
                },
              ],
            },
            {
              kind: 'state.updateNodeParam',
              input: { nodeId: '${node.id}', key: 'step', value: '${event.step}' },
            },
            {
              kind: 'actions.runPluginNode',
              input: { nodeId: '${node.id}' },
            },
          ],
        },
      ],
    }

    const host = {
      updateNodeParam: (nodeId: string, key: string, value: any) => calls.push(['param', nodeId, key, value]),
      updateNodeInput: (nodeId: string, key: string, value: any) => calls.push(['input', nodeId, key, value]),
      runPluginNode: async (nodeId: string) => {
        calls.push(['run', nodeId])
        return { ok: true }
      },
    }

    const bindings = { node: { id: 'n1' }, computed: {}, uiState: {}, document }

    await dispatchDeclarativeUiAction({
      actionIdOrKind: 'runStep',
      event: { step: 'upload' },
      document,
      bindings,
      host,
    })

    expect(calls).toEqual([
      ['param', 'n1', 'step', 'upload'],
      ['run', 'n1'],
    ])

    calls.length = 0

    await dispatchDeclarativeUiAction({
      actionIdOrKind: 'runStep',
      event: { step: 'sort' },
      document,
      bindings,
      host,
    })

    expect(calls).toEqual([
      ['param', 'n1', 'recording_path', ''],
      ['param', 'n1', 'step', 'sort'],
      ['run', 'n1'],
    ])
  })
})
