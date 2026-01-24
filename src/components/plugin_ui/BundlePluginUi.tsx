import { useEffect, useMemo, useState } from 'react'
import * as React from 'react'
import type { PluginDefinition } from '../../types/saw'
import { NodeInputs } from '../inspector/NodeInputs'
import { NodeParameters } from '../inspector/NodeParameters'
import { NodeRunPanel } from '../inspector/NodeRunPanel'
import { useSawStore } from '../../store/useSawStore'
import { fetchDevFile, fetchDevTree } from '../../dev/runtimeTree'

type BundleExports = {
  render?: (props: { nodeId: string; plugin: PluginDefinition; api: any; components: any }) => React.ReactNode
  default?: (props: { nodeId: string; plugin: PluginDefinition; api: any; components: any }) => React.ReactNode
}

function evalBundle(code: string): BundleExports {
  const module = { exports: {} as any }
  const exports = module.exports

  // Provide a very small, explicit surface area.
  const components = {
    NodeInputs,
    NodeParameters,
    NodeRunPanel,
  }

  const api = {
    React,
    h: React.createElement,
    Fragment: React.Fragment,
    useState,
    useEffect,
    useMemo,
    useSawStore,
    fetchDevTree,
    fetchDevFile,
    fetch,
    console,
  }

  // NOTE: This intentionally executes arbitrary JS from the plugin folder.
  // We gate this server-side (and in the UI) to workspace/sandbox plugins only.
  // eslint-disable-next-line no-new-func
  const fn = new Function('api', 'components', 'module', 'exports', `${code}\n;return module.exports;`)
  const out = fn(api, components, module, exports)
  return (out ?? module.exports) as BundleExports
}

export function BundlePluginUi(props: {
  nodeId: string
  plugin: PluginDefinition
  fallback?: React.ReactNode
}) {
  const pluginId = props.plugin.id
  const [status, setStatus] = useState<string>('')
  const [code, setCode] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setStatus('loading…')
        const r = await fetch(`/api/saw/plugins/ui/bundle/${encodeURIComponent(pluginId)}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(await r.text())
        const js = await r.text()
        if (cancelled) return
        setCode(js)
        setStatus('')
      } catch (e: any) {
        if (cancelled) return
        setCode('')
        setStatus(String(e?.message ?? e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId])

  const rendered = useMemo(() => {
    if (!code) return null
    try {
      const m = evalBundle(code)
      const components = { NodeInputs, NodeParameters, NodeRunPanel }
      const api = {
        React,
        h: React.createElement,
        Fragment: React.Fragment,
        useState,
        useEffect,
        useMemo,
        useSawStore,
        fetchDevTree,
        fetchDevFile,
        fetch,
        console,
      }
      const renderFn = typeof m.render === 'function' ? m.render : typeof m.default === 'function' ? m.default : null
      if (!renderFn) throw new Error('bundle_missing_export: expected module.exports.render(props)')
      return renderFn({ nodeId: props.nodeId, plugin: props.plugin, api, components })
    } catch (e: any) {
      return (
        <div className="space-y-2">
          <div className="text-[11px] text-red-300">Bundle UI error: {String(e?.message ?? e)}</div>
          {props.fallback ? <>{props.fallback}</> : null}
        </div>
      )
    }
  }, [code, props.nodeId, props.plugin, props.fallback])

  if (status) {
    return <div className="text-[11px] text-zinc-500">Bundle UI: {status}</div>
  }

  return <div className="space-y-3">{rendered ?? props.fallback ?? null}</div>
}
