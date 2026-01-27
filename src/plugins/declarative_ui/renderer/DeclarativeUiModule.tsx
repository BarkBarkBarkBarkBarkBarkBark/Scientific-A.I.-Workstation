import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeclarativeUiDocument } from '../declarativeUiTypes'
import { evalExpr } from '../bindings/evalExpr'
import { computeComputedValues, renderDeclarativeUiView } from './renderDeclarativeUi'
import { createDefaultDeclarativeUiRegistry } from '../registry/defaultRegistry'
import { useSawStore } from '../../../store/useSawStore'
import { dispatchDeclarativeUiAction } from '../runtime/actionRuntime'
import { runQueries as runQueriesRuntime, type DeclarativeUiQueryDef } from '../runtime/queryRuntime'

type UiState = Record<string, any>

// Declarative UI module host. Renders the document view and wires actions/queries to host capabilities.
export function DeclarativeUiModule(props: { nodeId: string; pluginId: string; document: DeclarativeUiDocument }) {
  const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) ?? null)
  const updateNodeParam = useSawStore((s) => s.updateNodeParam)
  const updateNodeInput = useSawStore((s) => s.updateNodeInput)
  const runPluginNode = useSawStore((s) => s.runPluginNode)
  const declarativeUiDevEnabled = useSawStore((s) => s.declarativeUiDev.enabled)
  const setDeclarativeUiDevSnapshot = useSawStore((s) => s.setDeclarativeUiDevSnapshot)

  const [uiState, setUiState] = useState<UiState>({})
  const [lastActionErr, setLastActionErr] = useState<string>('')
  const [lastQueryErr, setLastQueryErr] = useState<string>('')
  const lastActionRef = useRef<{ action: string; event?: any } | null>(null)
  const lastQueriesRef = useRef<{ ids: string[]; ts: number } | null>(null)
  const uiStateRef = useRef<UiState>({})

  useEffect(() => {
    // Initialize uiState from document defaults when available.
    const defaults = (((props.document as any).context ?? {}) as any).defaults
    const defaultUiState = (defaults?.uiState ?? null) as any

    setUiState(
      defaultUiState && typeof defaultUiState === 'object'
        ? defaultUiState
        : {
            status: {
              uploaded: false,
              sorted: false,
              analyzed: false,
              curation: false,
            },
          },
    )
  }, [props.nodeId, props.document])

  useEffect(() => {
    uiStateRef.current = uiState
  }, [uiState])

  const computed = useMemo(() => {
    return computeComputedValues({
      computed: (props.document as any).computed ?? {},
      ctx: { node, uiState, document: props.document },
    })
  }, [props.document, node, uiState])

  const registry = useMemo(() => createDefaultDeclarativeUiRegistry(), [])

  const queryDefs = useMemo(() => {
    const raw = (props.document as any).queries
    const qs: any[] = Array.isArray(raw) ? raw : []
    return qs
      .map((q) => {
        if (!q || typeof q !== 'object') return null
        const id = String((q as any).id ?? '').trim()
        const kind = String((q as any).kind ?? '').trim()
        if (!id) return null
        if (kind !== 'fsTreeSearch' && kind !== 'fsDirNonEmpty' && kind !== 'fsFileExists') return null
        return {
          id,
          kind,
          input: (q as any).input ?? {},
          output: (q as any).output ?? {},
        } as DeclarativeUiQueryDef
      })
      .filter(Boolean) as DeclarativeUiQueryDef[]
  }, [props.document])

  const runQueriesById = async (ids: string[]) => {
    setLastQueryErr('')
    try {
      await runQueriesRuntime({
        queryDefs,
        ids,
        bindings: { node, computed, uiState: uiStateRef.current, document: props.document },
        setUiState: (next) => setUiState(next),
        onRan: ({ ids }) => {
          lastQueriesRef.current = { ids, ts: Date.now() }
        },
      })
    } catch (e: any) {
      setLastQueryErr(String(e?.message ?? e))
    }
  }

  const ctx = useMemo(() => {
    const dispatch = (args: { action: string; event?: any }) => {
      void (async () => {
        try {
          setLastActionErr('')
          const action = (args.action || '').trim()
          const event = args.event ?? {}
          if (!action) return

          const log = (msg: string) => {
            try {
              ;(useSawStore as any).setState((s: any) => ({ logs: [...(s.logs ?? []), msg] }))
            } catch {
              // ignore
            }
          }

          await dispatchDeclarativeUiAction({
            actionIdOrKind: action,
            event,
            document: props.document,
            bindings: { node, computed, uiState, document: props.document },
            host: {
              updateNodeParam: (nodeId, key, value) => {
                updateNodeParam(nodeId, key, typeof value === 'number' ? value : String(value ?? ''))
              },
              updateNodeInput: (nodeId, key, value) => {
                updateNodeInput(nodeId, key, typeof value === 'number' ? value : String(value ?? ''))
              },
              runPluginNode: async (nodeId) => runPluginNode(nodeId),
              log,
            },
            onLastAction: (info) => {
              lastActionRef.current = { action: info.action, event: info.event }
            },
          })
        } catch (e: any) {
          setLastActionErr(String(e?.message ?? e))
        }
      })()
    }

    const evalFn = (expr: any, event?: any) =>
      evalExpr(expr, {
        node,
        computed,
        uiState,
        document: props.document,
        event: event ?? undefined,
      })

    return {
      nodeId: props.nodeId,
      pluginId: props.pluginId,
      node,
      computed,
      uiState,
      document: props.document,
      dispatch,
      eval: (expr: any) => evalFn(expr),
    }
  }, [
    props.nodeId,
    props.pluginId,
    props.document,
    node,
    computed,
    uiState,
    updateNodeParam,
    updateNodeInput,
    runPluginNode,
  ])

  // Lifecycle: onMount
  useEffect(() => {
    const lifecycle = (props.document as any).lifecycle
    const onMount = lifecycle?.onMount
    if (!Array.isArray(onMount)) return
    void (async () => {
      for (const step of onMount) {
        if (!step || typeof step !== 'object') continue
        if (step.kind !== 'runQueries') continue
        const ids = Array.isArray((step as any).queries) ? (step as any).queries.map((x: any) => String(x)) : []
        if (!ids.length) continue
        await runQueriesById(ids)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nodeId])

  // Lifecycle: onBindingChange (limited)
  const bindingDeps = useMemo(() => {
    const lifecycle = (props.document as any).lifecycle
    const onBC = lifecycle?.onBindingChange
    if (!onBC || typeof onBC !== 'object') return [] as any[]
    const bindings = Array.isArray((onBC as any).bindings) ? (onBC as any).bindings : []
    const depVals: any[] = []
    for (const b of bindings) {
      const s = String(b ?? '')
      if (s.startsWith('computed.')) depVals.push(computed[s.slice('computed.'.length)])
      else if (s.startsWith('uiState.')) depVals.push((uiState as any)[s.slice('uiState.'.length)])
      else depVals.push(s)
    }
    return depVals
  }, [props.document, computed, uiState])

  useEffect(() => {
    const lifecycle = (props.document as any).lifecycle
    const onBC = lifecycle?.onBindingChange
    if (!onBC || typeof onBC !== 'object') return
    const doSteps = (onBC as any).do
    if (!Array.isArray(doSteps)) return
    void (async () => {
      for (const step of doSteps) {
        if (!step || typeof step !== 'object') continue
        if (step.kind !== 'runQueries') continue
        const ids = Array.isArray((step as any).queries) ? (step as any).queries.map((x: any) => String(x)) : []
        if (!ids.length) continue
        await runQueriesById(ids)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, bindingDeps)

  if (!node) {
    return <div className="text-xs text-zinc-500">Declarative UI: node not found</div>
  }

  const rendered = renderDeclarativeUiView({ root: props.document.view, ctx, registry })

  useEffect(() => {
    if (!declarativeUiDevEnabled) return
    setDeclarativeUiDevSnapshot({
      ts: Date.now(),
      nodeId: props.nodeId,
      pluginId: props.pluginId,
      computed,
      uiState,
      lastAction: lastActionRef.current,
      lastQueries: lastQueriesRef.current,
    })
  }, [declarativeUiDevEnabled, setDeclarativeUiDevSnapshot, props.nodeId, props.pluginId, computed, uiState])

  return (
    <div className="space-y-3 rounded-md border border-sky-400/70 bg-sky-950/10 p-3">
      {lastActionErr ? <div className="text-[11px] text-red-300">Declarative UI action error: {lastActionErr}</div> : null}
      {lastQueryErr ? <div className="text-[11px] text-red-300">Declarative UI query error: {lastQueryErr}</div> : null}
      {rendered}
    </div>
  )
}
