import { useEffect, useMemo, useState } from 'react'
import { useSawStore } from '../store/useSawStore'

export function TopBar() {
  const editableMode = useSawStore((s) => s.editableMode)
  const setEditableMode = useSawStore((s) => s.setEditableMode)
  const setDangerousPluginHotEditEnabled = useSawStore((s) => s.setDangerousPluginHotEditEnabled)
  const layoutMode = useSawStore((s) => s.layoutMode)
  const setLayoutMode = useSawStore((s) => s.setLayoutMode)
  const reflowPipeline = useSawStore((s) => s.reflowPipeline)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)
  const [utilitiesOpen, setUtilitiesOpen] = useState(false)

  useEffect(() => {
    if (!utilitiesOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUtilitiesOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [utilitiesOpen])

  const utilities = useMemo(() => {
    return pluginCatalog
      .filter((p) => p.utility?.kind === 'external_tab')
      .map((p) => ({
        id: p.id,
        label: p.utility?.label || p.name,
        description: p.utility?.description || p.description,
        menuPath: (p.utility?.menu_path ?? []).filter(Boolean),
        launch: p.utility?.launch,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [pluginCatalog])

  const groupedUtilities = useMemo(() => {
    const groups = new Map<string, typeof utilities>()
    for (const item of utilities) {
      const group = item.menuPath[1] || item.menuPath[0] || 'Utilities'
      const list = groups.get(group) ?? []
      list.push(item)
      groups.set(group, list)
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [utilities])

  const logUtilityError = (message: string) => {
    useSawStore.setState((s) => ({
      bottomTab: 'errors',
      errors: [...s.errors, message],
      logs: [...s.logs, `[utilities] ${message}`],
    }))
  }

  const logUtilityInfo = (message: string) => {
    useSawStore.setState((s) => ({
      logs: [...s.logs, `[utilities] ${message}`],
    }))
  }

  const getOutputPath = (obj: any, path: string | undefined) => {
    if (!path) return undefined
    return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj)
  }

  const normalizeLoopbackUrl = (url: string) => {
    try {
      const u = new URL(url)
      if (u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') u.hostname = 'localhost'
      return u.toString()
    } catch {
      return String(url || '')
    }
  }

  const launchUtility = async (
    pluginId: string,
    outputPath?: string,
    tab?: Window | null,
    opts?: { logUrlIfNoPopup?: boolean; popupBlocked?: boolean },
  ) => {
    try {
      const r = await fetch('/api/saw/plugins/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_id: pluginId, inputs: {}, params: {} }),
      })
      if (!r.ok) {
        const t = await r.text()
        throw new Error(t)
      }
      const j = (await r.json()) as { ok: boolean; outputs?: any; error?: string }
      if (!j.ok) {
        throw new Error(j.error || 'Utility failed to launch')
      }
      const url = getOutputPath(j.outputs ?? {}, outputPath || 'result.data.url')
      if (typeof url !== 'string' || !url.startsWith('http')) {
        throw new Error('Utility did not return a valid URL')
      }
      const href = normalizeLoopbackUrl(url)
      if (tab && !tab.closed) {
        try {
          tab.location.assign(href)
        } catch {
          window.open(href, '_blank')
        }
      } else {
        // If we don't have a popup/tab handle (often due to popup blockers),
        // still make the URL available for manual open.
        if (opts?.logUrlIfNoPopup) {
          try {
            // eslint-disable-next-line no-console
            console.log('[utilities] Open manually:', href)
          } catch {
            // ignore
          }
          if (opts?.popupBlocked) {
            logUtilityError(`UtilityLaunchError: ${pluginId}: popup blocked (open manually): ${href}`)
          } else {
            logUtilityInfo(`Open manually: ${href}`)
          }
        } else {
          window.open(href, '_blank')
        }
      }
    } catch (e: any) {
      if (tab && !tab.closed) {
        try {
          tab.close()
        } catch {
          // ignore
        }
      }
      logUtilityError(`UtilityLaunchError: ${pluginId}: ${String(e?.message ?? e)}`)
    }
  }

  return (
    <div className="flex h-12 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4">
      <div className="flex items-baseline gap-3">
        <div className="text-sm font-semibold tracking-wide text-zinc-100">
          Scientific AI Workstation
        </div>
        <div className="text-xs text-zinc-500">Frontend MVP (local execution)</div>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative z-50">
          <button
            type="button"
            onClick={() => setUtilitiesOpen((v) => !v)}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 hover:border-zinc-600"
            aria-haspopup="menu"
            aria-expanded={utilitiesOpen}
          >
            Utilities
          </button>
          {utilitiesOpen && (
            <>
              {/* Click-away backdrop so the menu doesn't get "stuck" open. */}
              <button
                type="button"
                aria-label="Close utilities menu"
                className="fixed inset-0 z-40 cursor-default bg-transparent"
                onClick={() => setUtilitiesOpen(false)}
              />
              <div
                className="absolute right-0 z-50 mt-2 w-72 max-h-[70vh] overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-200 shadow-lg"
                role="menu"
              >
                {groupedUtilities.length === 0 ? (
                  <div className="px-2 py-2 text-zinc-500">No utilities discovered yet.</div>
                ) : (
                  groupedUtilities.map(([group, items]) => (
                    <div key={group} className="mb-2 last:mb-0">
                      <div className="px-2 py-1 text-[11px] font-semibold uppercase text-zinc-500">{group}</div>
                      <div className="space-y-1">
                        {items.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="flex w-full flex-col rounded-md px-2 py-1 text-left hover:bg-zinc-900"
                            onClick={() => {
                              setUtilitiesOpen(false)
                              // Open the tab synchronously to avoid popup blockers.
                              // We intentionally do not use noopener here because we need a window handle
                              // to navigate after the async plugin launch completes.
                              const tab = window.open('about:blank', '_blank')
                              if (!tab) {
                                // Popup blocked. Still launch the utility so we can surface the URL.
                                // Still run it so we can print/log the resulting URL.
                                launchUtility(item.id, item.launch?.expect?.output_path, null, {
                                  logUrlIfNoPopup: true,
                                  popupBlocked: true,
                                })
                                return
                              }
                              launchUtility(item.id, item.launch?.expect?.output_path, tab)
                            }}
                          >
                            <span className="font-semibold text-zinc-100">{item.label}</span>
                            <span className="text-[11px] text-zinc-500">{item.description}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <span className="text-zinc-400">Layout</span>
          <select
            value={layoutMode}
            onChange={(e) => {
              const m = e.target.value === 'graph' ? 'graph' : 'pipeline'
              setLayoutMode(m)
              if (m === 'pipeline') reflowPipeline()
            }}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          >
            <option value="pipeline">Pipeline</option>
            <option value="graph">Graph</option>
          </select>
        </label>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
          <span className="text-zinc-400">Editable Mode</span>
          <button
            type="button"
            onClick={() => {
              const next = !editableMode
              setEditableMode(next)
              // In dev, treat the top-level Editable Mode toggle as the master
              // switch for human hot-editing of workspace plugin sources.
              if (import.meta.env.DEV) setDangerousPluginHotEditEnabled(next)
            }}
            className={[
              'relative h-6 w-11 rounded-full border border-zinc-700 transition',
              editableMode ? 'bg-emerald-600/60' : 'bg-zinc-800',
            ].join(' ')}
            aria-pressed={editableMode}
            aria-label="Toggle editable mode"
          >
            <span
              className={[
                'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-zinc-100 transition',
                editableMode ? 'left-6' : 'left-1',
              ].join(' ')}
            />
          </button>
        </label>
      </div>
    </div>
  )
}

