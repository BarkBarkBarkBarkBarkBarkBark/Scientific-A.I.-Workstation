import { useEffect, useMemo, useState } from 'react'
import { NodeInputs } from '../inspector/NodeInputs'
import { NodeParameters } from '../inspector/NodeParameters'
import { NodeRunPanel } from '../inspector/NodeRunPanel'
import type { PluginDefinition } from '../../types/saw'

type BuiltinComponent = 'node_inputs' | 'node_parameters' | 'run_panel' | 'plugin_description'

type UiSection =
  | { type: 'builtin'; component: BuiltinComponent }
  | { type: 'text'; text: string; tone?: 'normal' | 'muted' }

type UiSchema = {
  version: 1
  sections: UiSection[]
}

function normalizeSchema(raw: any): UiSchema | null {
  if (!raw || typeof raw !== 'object') return null
  if (raw.version !== 1) return null
  if (!Array.isArray(raw.sections)) return null

  const sections: UiSection[] = []
  for (const s of raw.sections) {
    if (!s || typeof s !== 'object') continue
    if (s.type === 'builtin') {
      const c = String((s as any).component || '') as BuiltinComponent
      if (c === 'node_inputs' || c === 'node_parameters' || c === 'run_panel' || c === 'plugin_description') {
        sections.push({ type: 'builtin', component: c })
      }
      continue
    }
    if (s.type === 'text') {
      const text = String((s as any).text ?? '')
      const toneRaw = String((s as any).tone ?? 'normal')
      const tone = toneRaw === 'muted' ? 'muted' : 'normal'
      if (text) sections.push({ type: 'text', text, tone })
    }
  }

  return { version: 1, sections }
}

export function SchemaPluginUi(props: { nodeId: string; plugin: PluginDefinition; fallback?: React.ReactNode }) {
  const pluginId = props.plugin.id
  const [status, setStatus] = useState<string>('')
  const [schemaRaw, setSchemaRaw] = useState<any>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setStatus('loading…')
        const r = await fetch(`/api/saw/plugins/ui/schema/${encodeURIComponent(pluginId)}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as { schema: any }
        if (cancelled) return
        setSchemaRaw(j.schema)
        setStatus('')
      } catch (e: any) {
        if (cancelled) return
        setSchemaRaw(null)
        setStatus(String(e?.message ?? e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId])

  const schema = useMemo(() => normalizeSchema(schemaRaw), [schemaRaw])

  if (!schema) {
    return props.fallback ? (
      <>{props.fallback}</>
    ) : (
      <div className="space-y-2">
        {status ? <div className="text-[11px] text-zinc-500">UI schema: {status}</div> : null}
        <div className="text-sm text-zinc-200">{props.plugin.description}</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {status ? <div className="text-[11px] text-zinc-500">UI schema: {status}</div> : null}
      {schema.sections.map((s, idx) => {
        if (s.type === 'text') {
          return (
            <div key={idx} className={s.tone === 'muted' ? 'text-xs text-zinc-500' : 'text-sm text-zinc-200'}>
              {s.text}
            </div>
          )
        }

        if (s.component === 'node_inputs') return <NodeInputs key={idx} nodeId={props.nodeId} />
        if (s.component === 'node_parameters') return <NodeParameters key={idx} nodeId={props.nodeId} />
        if (s.component === 'run_panel') return <NodeRunPanel key={idx} nodeId={props.nodeId} />
        if (s.component === 'plugin_description') {
          return (
            <div key={idx} className="space-y-2">
              <div className="text-sm text-zinc-200">{props.plugin.description}</div>
            </div>
          )
        }

        return null
      })}
    </div>
  )
}
