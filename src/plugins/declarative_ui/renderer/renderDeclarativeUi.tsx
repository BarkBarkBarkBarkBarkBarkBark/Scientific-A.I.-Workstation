import * as React from 'react'
import type { ReactNode } from 'react'
import type { DeclarativeUiViewNode } from '../declarativeUiTypes'
import { evalExpr } from '../bindings/evalExpr'
import type { DeclarativeUiRenderContext } from './types'
import type { DeclarativeUiRegistry } from '../registry/registry'
import { getRegistryComponent } from '../registry/registry'

export function makeEval(ctx: Omit<DeclarativeUiRenderContext, 'eval'>) {
  return (expr: any) =>
    evalExpr(expr, {
      node: ctx.node,
      computed: ctx.computed,
      uiState: ctx.uiState,
      document: ctx.document,
      event: undefined,
    })
}

function renderNode(node: DeclarativeUiViewNode, ctx: DeclarativeUiRenderContext, registry: DeclarativeUiRegistry): ReactNode {
  const children = (node.children ?? []).map((c, idx) => {
    const out = renderNode(c, ctx, registry)
    return <React.Fragment key={idx}>{out}</React.Fragment>
  })

  const factory = getRegistryComponent(registry, node.type)
  if (!factory) {
    return (
      <div className="rounded-md border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-[11px] text-amber-200">
        Unknown Declarative UI component: <span className="font-mono">{node.type}</span>
      </div>
    )
  }

  return factory({ node, ctx, children })
}

export function renderDeclarativeUiView(args: {
  root: DeclarativeUiViewNode
  ctx: DeclarativeUiRenderContext
  registry: DeclarativeUiRegistry
}): ReactNode {
  return renderNode(args.root, args.ctx, args.registry)
}

export function computeComputedValues(params: {
  computed?: Record<string, any>
  ctx: { node: any; uiState: any; document: any }
}): Record<string, any> {
  const computed = params.computed ?? {}
  const out: Record<string, any> = {}

  // Iteratively resolve; allows computed fields to reference earlier computed values.
  for (let pass = 0; pass < 6; pass++) {
    let changed = false
    for (const key of Object.keys(computed)) {
      const expr = computed[key]
      const next = evalExpr(expr, {
        node: params.ctx.node,
        computed: out,
        uiState: params.ctx.uiState,
        document: params.ctx.document,
        event: undefined,
      })
      if (out[key] !== next) {
        out[key] = next
        changed = true
      }
    }
    if (!changed) break
  }

  return out
}
