import type { A2uiExpr } from '../a2uiTypes'

export type A2uiEvalContext = {
  node?: any
  computed?: Record<string, any>
  uiState?: Record<string, any>
  document?: Record<string, any>
  event?: Record<string, any>
}

const MAX_DEPTH = 64

function isObjectLike(v: unknown): v is Record<string, any> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

function toStringSafe(v: any): string {
  if (v == null) return ''
  return String(v)
}

function resolvePath(path: string, ctx: A2uiEvalContext): any {
  const trimmed = path.trim()
  if (!trimmed) return undefined

  const parts = trimmed.split('.').filter(Boolean)
  if (parts.length === 0) return undefined

  const rootKey = parts[0]!
  let cur: any
  if (rootKey === 'node') cur = ctx.node
  else if (rootKey === 'computed') cur = ctx.computed
  else if (rootKey === 'uiState') cur = ctx.uiState
  else if (rootKey === 'document') cur = ctx.document
  else if (rootKey === 'event') cur = ctx.event
  else return undefined

  for (let i = 1; i < parts.length; i++) {
    const key = parts[i]!
    if (cur == null) return undefined
    cur = cur[key]
  }
  return cur
}

function parseBindingString(s: string):
  | { kind: 'none' }
  | { kind: 'path'; path: string }
  | { kind: 'cmp'; op: 'eq' | 'neq'; leftPath: string; right: any } {
  const m = s.match(/^\$\{([\s\S]+)\}$/)
  if (!m) return { kind: 'none' }
  const inner = m[1]!.trim()

  // Supported convenience comparisons:
  //   ${node.data.status == 'error'}
  //   ${node.data.status != "error"}
  // Strict grammar to avoid “eval”.
  const cmp = inner.match(/^([a-zA-Z_][a-zA-Z0-9_\.]*)\s*(==|!=)\s*([\s\S]+)$/)
  if (cmp) {
    const leftPath = cmp[1]!
    const opSym = cmp[2]!
    const rhsRaw = cmp[3]!.trim()

    let right: any
    const qs = rhsRaw.match(/^'(.*)'$/) ?? rhsRaw.match(/^"(.*)"$/)
    if (qs) right = qs[1]!
    else if (rhsRaw === 'true') right = true
    else if (rhsRaw === 'false') right = false
    else if (rhsRaw === 'null') right = null
    else if (/^-?\d+(?:\.\d+)?$/.test(rhsRaw)) right = Number(rhsRaw)
    else {
      // Disallow arbitrary RHS expressions.
      right = undefined
    }

    return { kind: 'cmp', op: opSym === '==' ? 'eq' : 'neq', leftPath, right }
  }

  return { kind: 'path', path: inner }
}

function bool(v: any): boolean {
  return Boolean(v)
}

function num(v: any): number {
  if (typeof v === 'number') return v
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

export function evalExpr(expr: A2uiExpr, ctx: A2uiEvalContext, depth = 0): any {
  if (depth > MAX_DEPTH) throw new Error('a2ui_eval_max_depth')

  if (expr == null) return null
  if (typeof expr === 'number' || typeof expr === 'boolean') return expr

  if (Array.isArray(expr)) {
    return expr.map((v) => evalExpr(v as any, ctx, depth + 1))
  }

  if (typeof expr === 'string') {
    const b = parseBindingString(expr)
    if (b.kind === 'none') return expr
    if (b.kind === 'path') return resolvePath(b.path, ctx)
    if (b.kind === 'cmp') {
      const left = resolvePath(b.leftPath, ctx)
      return b.op === 'eq' ? left === b.right : left !== b.right
    }
    return undefined
  }

  if (!isObjectLike(expr)) return undefined

  // Literal objects are allowed (e.g. event payloads, complex props).
  // Only objects with an explicit "op" key are treated as executable expressions.
  if (typeof (expr as any).op !== 'string') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(expr)) out[k] = evalExpr(v as any, ctx, depth + 1)
    return out
  }

  const op = (expr as any).op as string
  const args = Array.isArray((expr as any).args) ? ((expr as any).args as any[]) : undefined

  switch (op) {
    case 'concat': {
      const parts = (args ?? []).map((a) => toStringSafe(evalExpr(a, ctx, depth + 1)))
      return parts.join('')
    }
    case 'trim': {
      const v = args?.[0] ? evalExpr(args[0], ctx, depth + 1) : ''
      return toStringSafe(v).trim()
    }
    case 'lower': {
      const v = args?.[0] ? evalExpr(args[0], ctx, depth + 1) : ''
      return toStringSafe(v).toLowerCase()
    }
    case 'upper': {
      const v = args?.[0] ? evalExpr(args[0], ctx, depth + 1) : ''
      return toStringSafe(v).toUpperCase()
    }
    case 'len': {
      const v = args?.[0] ? evalExpr(args[0], ctx, depth + 1) : ''
      if (Array.isArray(v)) return v.length
      return toStringSafe(v).length
    }

    case 'eq': {
      const a = args?.[0] ? evalExpr(args[0], ctx, depth + 1) : undefined
      const b = args?.[1] ? evalExpr(args[1], ctx, depth + 1) : undefined
      return a === b
    }
    case 'neq': {
      const a = args?.[0] ? evalExpr(args[0], ctx, depth + 1) : undefined
      const b = args?.[1] ? evalExpr(args[1], ctx, depth + 1) : undefined
      return a !== b
    }

    case 'gt': {
      const a = args?.[0] ? num(evalExpr(args[0], ctx, depth + 1)) : NaN
      const b = args?.[1] ? num(evalExpr(args[1], ctx, depth + 1)) : NaN
      return a > b
    }
    case 'gte': {
      const a = args?.[0] ? num(evalExpr(args[0], ctx, depth + 1)) : NaN
      const b = args?.[1] ? num(evalExpr(args[1], ctx, depth + 1)) : NaN
      return a >= b
    }
    case 'lt': {
      const a = args?.[0] ? num(evalExpr(args[0], ctx, depth + 1)) : NaN
      const b = args?.[1] ? num(evalExpr(args[1], ctx, depth + 1)) : NaN
      return a < b
    }
    case 'lte': {
      const a = args?.[0] ? num(evalExpr(args[0], ctx, depth + 1)) : NaN
      const b = args?.[1] ? num(evalExpr(args[1], ctx, depth + 1)) : NaN
      return a <= b
    }

    case 'and': {
      for (const a of args ?? []) {
        if (!bool(evalExpr(a, ctx, depth + 1))) return false
      }
      return true
    }
    case 'or': {
      for (const a of args ?? []) {
        if (bool(evalExpr(a, ctx, depth + 1))) return true
      }
      return false
    }
    case 'not': {
      const a = args?.[0] ? evalExpr(args[0], ctx, depth + 1) : false
      return !bool(a)
    }

    case 'if': {
      const cond = args?.[0] ? evalExpr(args[0], ctx, depth + 1) : false
      const thenV = args?.[1] ? evalExpr(args[1], ctx, depth + 1) : undefined
      const elseV = args?.[2] ? evalExpr(args[2], ctx, depth + 1) : undefined
      return bool(cond) ? thenV : elseV
    }

    default:
      throw new Error(`a2ui_unknown_op:${op}`)
  }
}
