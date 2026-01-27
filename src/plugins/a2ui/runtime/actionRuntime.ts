import { evalExpr } from '../bindings/evalExpr'

export type A2uiActionDef = {
  id: string
  kind: string
  input?: any
  steps?: any[]
}

export type A2uiActionHost = {
  updateNodeParam: (nodeId: string, key: string, value: any) => void
  updateNodeInput: (nodeId: string, key: string, value: any) => void
  runPluginNode: (nodeId: string) => Promise<{ ok: boolean; error?: string }>
  log?: (msg: string) => void
}

export async function dispatchA2uiAction(params: {
  actionIdOrKind: string
  event?: any
  document: any
  bindings: { node: any; computed: any; uiState: any; document: any }
  host: A2uiActionHost
  onLastAction?: (info: { action: string; event?: any }) => void
}): Promise<void> {
  const actionId = String(params.actionIdOrKind ?? '').trim()
  if (!actionId) return

  params.onLastAction?.({ action: actionId, event: params.event })

  const defs: A2uiActionDef[] = Array.isArray(params.document?.actions) ? params.document.actions : []
  const def = defs.find((a) => a && typeof a === 'object' && a.id === actionId) ?? null

  // If it isn't a document-defined action, treat it as a host action kind.
  if (!def) {
    await execStep(
      {
        kind: actionId,
        input: params.event,
      },
      {
        evalWithEvent: (expr) => evalExpr(expr, { ...params.bindings, event: params.event ?? undefined }),
        host: params.host,
        nodeFallbackId: params.bindings.node?.id,
      },
    )
    return
  }

  await execStep(
    def,
    {
      evalWithEvent: (expr) => evalExpr(expr, { ...params.bindings, event: params.event ?? undefined }),
      host: params.host,
      nodeFallbackId: params.bindings.node?.id,
    },
  )
}

async function execStep(
  step: any,
  runtime: {
  evalWithEvent: (expr: any) => any
  host: A2uiActionHost
  nodeFallbackId?: string
  },
): Promise<void> {
  if (!step || typeof step !== 'object') return
  const kind = String(step.kind ?? '').trim()
  const inputExpr = step.input

  const evalWithEvent = runtime.evalWithEvent
  const host = runtime.host
  const nodeFallbackId = runtime.nodeFallbackId

  if (kind === 'sequence') {
    const steps: any[] = Array.isArray(step.steps) ? step.steps : []
    for (const s of steps) {
      await execStep(s, runtime)
    }
    return
  }

  if (kind === 'conditional') {
    // Shape: { kind: 'conditional', if: <expr>, then: [<step>...] }
    const ok = Boolean(evalWithEvent(step.if))
    if (ok) {
      const thenSteps: any[] = Array.isArray(step.then) ? step.then : []
      for (const s of thenSteps) await execStep(s, runtime)
    }
    return
  }

  if (kind === 'state.updateNodeParam' || kind === 'setParam') {
    const input = evalWithEvent(inputExpr)
    const nodeId = String(input?.nodeId ?? nodeFallbackId ?? '').trim()
    const key = String(input?.key ?? '').trim()
    const value = input?.value
    if (!nodeId || !key) return
    host.updateNodeParam(nodeId, key, value)
    return
  }

  if (kind === 'state.updateNodeInput') {
    const input = evalWithEvent(inputExpr)
    const nodeId = String(input?.nodeId ?? nodeFallbackId ?? '').trim()
    const key = String(input?.key ?? '').trim()
    const value = input?.value
    if (!nodeId || !key) return
    host.updateNodeInput(nodeId, key, value)
    return
  }

  if (kind === 'actions.runPluginNode' || kind === 'runNode') {
    const input = evalWithEvent(inputExpr)
    const nodeId = String(input?.nodeId ?? nodeFallbackId ?? '').trim()
    if (!nodeId) return
    await host.runPluginNode(nodeId)
    return
  }

  if (kind === 'ui.toast') {
    const input = evalWithEvent(inputExpr)
    const msg = String(input?.message ?? '').trim()
    if (msg) host.log?.(`[a2ui] ${msg}`)
    return
  }

  // Unknown kinds are ignored (safe-by-default).
}
