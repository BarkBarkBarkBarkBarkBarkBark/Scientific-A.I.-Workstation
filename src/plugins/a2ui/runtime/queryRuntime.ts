import { fetchDevFile, fetchDevTree } from '../../../dev/runtimeTree'
import { evalExpr } from '../bindings/evalExpr'
import { getIntoPath, setByPath } from './uiState'

export type A2uiQueryDef = {
  id: string
  kind: 'fsTreeSearch' | 'fsDirNonEmpty' | 'fsFileExists'
  input: any
  output: { into: string }
}

export async function runQueries(params: {
  queryDefs: A2uiQueryDef[]
  ids: string[]
  bindings: { node: any; computed: any; uiState: any; document: any }
  setUiState: (next: any) => void
  onRan?: (info: { ids: string[] }) => void
}): Promise<void> {
  const byId = new Map(params.queryDefs.map((q) => [q.id, q] as const))

  let nextUiState = params.bindings.uiState

  for (const id of params.ids) {
    const q = byId.get(id)
    if (!q) continue

    const input = evalExpr(q.input, {
      node: params.bindings.node,
      computed: params.bindings.computed,
      uiState: nextUiState,
      document: params.bindings.document,
      event: undefined,
    })

    let result = false

    try {
      if (q.kind === 'fsFileExists') {
        const path = String(input?.path ?? '').trim()
        if (!path) result = false
        else {
          await fetchDevFile(path)
          result = true
        }
      } else if (q.kind === 'fsDirNonEmpty') {
        const root = String(input?.root ?? '').trim()
        const depth = Number(input?.depth ?? 1)
        if (!root) result = false
        else {
          const tree = await fetchDevTree({ root, depth: Number.isFinite(depth) ? depth : 1 })
          result = tree.type === 'dir' && Array.isArray(tree.children) && tree.children.length > 0
        }
      } else if (q.kind === 'fsTreeSearch') {
        const root = String(input?.root ?? '').trim()
        const depth = Number(input?.depth ?? 3)
        const match = input?.match ?? {}
        const nameEndsWith = String(match?.nameEndsWith ?? '')

        if (!root) result = false
        else {
          const tree = await fetchDevTree({ root, depth: Number.isFinite(depth) ? depth : 3 })
          const found = findInTree(tree, (n) => {
            if (!n || typeof n !== 'object') return false
            if (match?.type === 'file' && (n as any).type !== 'file') return false
            if (nameEndsWith && typeof (n as any).name === 'string') return (n as any).name.endsWith(nameEndsWith)
            return false
          })
          result = found
        }
      }
    } catch {
      result = false
    }

    const intoPath = getIntoPath(q.output?.into ?? '')
    if (intoPath.length > 0) {
      nextUiState = setByPath(nextUiState ?? {}, intoPath, result)
    }
  }

  params.setUiState(nextUiState)
  params.onRan?.({ ids: params.ids })
}

function findInTree(node: any, pred: (n: any) => boolean): boolean {
  if (!node) return false
  if (pred(node)) return true
  if (node.type === 'dir' && Array.isArray(node.children)) {
    for (const c of node.children) if (findInTree(c, pred)) return true
  }
  return false
}
