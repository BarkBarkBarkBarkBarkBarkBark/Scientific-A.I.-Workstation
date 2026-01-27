import { useEffect, useMemo, useState } from 'react'
import { NodeInputs } from '../inspector/NodeInputs'
import { NodeParameters } from '../inspector/NodeParameters'
import { NodeRunPanel } from '../inspector/NodeRunPanel'
import type { PluginDefinition } from '../../types/saw'
import { A2uiDocumentSchema, isProbablyA2uiDocument } from '../../plugins/a2ui/a2uiTypes'
import { A2uiModule } from '../../plugins/a2ui/renderer/A2uiModule'

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
  const [schemaMeta, setSchemaMeta] = useState<{ schema_file?: string; schema_kind?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setStatus('loading…')
        const r = await fetch(`/api/saw/plugins/ui/schema/${encodeURIComponent(pluginId)}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as { schema: any; schema_file?: string; schema_kind?: string }
        if (cancelled) return
        setSchemaRaw(j.schema)
        setSchemaMeta({ schema_file: j.schema_file, schema_kind: j.schema_kind })
        setStatus('')
      } catch (e: any) {
        if (cancelled) return
        setSchemaRaw(null)
        setSchemaMeta(null)
        setStatus(String(e?.message ?? e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId])

  const a2ui = useMemo(() => {
    if (!isProbablyA2uiDocument(schemaRaw)) return null
    const parsed = A2uiDocumentSchema.safeParse(schemaRaw)
    return parsed.success ? parsed.data : { __error: parsed.error.message }
  }, [schemaRaw])

  const schema = useMemo(() => normalizeSchema(schemaRaw), [schemaRaw])

  if (a2ui) {
    const err = (a2ui as any).__error as string | undefined
    if (!err) {
      return (
        <div className="space-y-2">
          <div className="text-[11px] text-sky-300">
            A2UI active • kind: <span className="font-mono">{schemaMeta?.schema_kind ?? 'unknown'}</span> • file:{' '}
            <span className="font-mono">{schemaMeta?.schema_file ?? 'unknown'}</span>
          </div>
          <A2uiModule nodeId={props.nodeId} pluginId={props.plugin.id} document={a2ui as any} />
        </div>
      )
    }
    return (
      <div className="space-y-2">
        {status ? <div className="text-[11px] text-zinc-500">UI schema: {status}</div> : null}
        {schemaMeta ? (
          <div className="text-[11px] text-zinc-500">
            schema kind: <span className="font-mono text-zinc-300">{schemaMeta.schema_kind ?? 'unknown'}</span> • file:{' '}
            <span className="font-mono text-zinc-300">{schemaMeta.schema_file ?? 'unknown'}</span>
          </div>
        ) : null}
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs font-semibold text-zinc-200">A2UI detected</div>
          <div className="mt-1 text-[11px] text-zinc-500">
            Renderer is being implemented incrementally. This module will switch to the new declarative renderer soon.
          </div>
          {err ? <div className="mt-2 text-[11px] text-red-300">A2UI validation error: {err}</div> : null}
        </div>
        {props.fallback ? <>{props.fallback}</> : <div className="text-sm text-zinc-200">{props.plugin.description}</div>}
      </div>
    )
  }

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
