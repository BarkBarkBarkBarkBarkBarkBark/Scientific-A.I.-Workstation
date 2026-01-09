import Editor from '@monaco-editor/react'
import { useEffect, useMemo, useState } from 'react'
import { useSawStore } from '../store/useSawStore'
import { Panel } from './ui/Panel'
import { AudioLowpassInspector } from './inspector/AudioLowpassInspector'
import { SourceViewer } from './SourceViewer'
import { IngestDirectoryModule } from './modules/IngestDirectoryModule'
import { BouncingTextModule } from './modules/BouncingTextModule'
import { ReadOnlyFileViewer } from './ReadOnlyFileViewer'
import { NodeParameters } from './inspector/NodeParameters'

export function ModuleFullscreenModal() {
  const fullscreen = useSawStore((s) => s.fullscreen)
  const closeFullscreen = useSawStore((s) => s.closeFullscreen)
  const editableMode = useSawStore((s) => s.editableMode)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)

  const node = useSawStore((s) => s.nodes.find((n) => n.id === fullscreen.nodeId) ?? null)
  const plugin = useMemo(
    () => (node ? pluginCatalog.find((p) => p.id === node.data.pluginId) ?? null : null),
    [node, pluginCatalog],
  )
  const [codeTab, setCodeTab] = useState<'source' | 'python'>('source')
  const refreshWorkspacePlugins = useSawStore((s) => s.refreshWorkspacePlugins)
  const [forkStatus, setForkStatus] = useState<string>('')

  useEffect(() => {
    if (!fullscreen.open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen.open, closeFullscreen])

  if (!fullscreen.open || !node || !plugin) return null

  const manifestPath = (plugin.sourcePaths ?? []).find((p) => p.endsWith('/plugin.yaml') || p.endsWith('/plugin.yml')) ?? ''
  const wrapperPath = (plugin.sourcePaths ?? []).find((p) => p.endsWith('/wrapper.py')) ?? ''
  const isWorkspacePlugin = Boolean(manifestPath && wrapperPath)
  const isLockedStock = Boolean(isWorkspacePlugin && plugin.locked && plugin.origin === 'stock')

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 p-4">
      <div className="h-full w-full">
        <Panel
          title={`Fullscreen — ${plugin.name}`}
          right={
            <div className="flex items-center gap-2">
              <div className="text-[11px] text-zinc-500">
                {editableMode ? 'Editable Mode: ON' : 'Editable Mode: OFF'}
              </div>
              <button
                type="button"
                onClick={closeFullscreen}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
              >
                Close (Esc)
              </button>
            </div>
          }
          className="h-full overflow-hidden"
        >
          <div className="grid h-full grid-cols-[1.1fr,0.9fr] gap-2 p-2">
            <Panel title="Module" className="min-h-0 overflow-hidden">
              <div className="h-full overflow-auto p-3">
                <div className="space-y-3">
                  <NodeParameters nodeId={node.id} />

                  {plugin.id === 'audio_lowpass' ? (
                    <AudioLowpassInspector nodeId={node.id} />
                  ) : plugin.id === 'saw.ingest.directory' ? (
                    <IngestDirectoryModule nodeId={node.id} />
                  ) : plugin.id === 'saw.example.bouncing_text' ? (
                    <BouncingTextModule nodeId={node.id} />
                  ) : (
                    <div className="space-y-2">
                      <div className="text-sm text-zinc-200">{plugin.description}</div>
                      <div className="text-xs text-zinc-500">(TODO: module-specific UI goes here.)</div>
                    </div>
                  )}
                </div>
              </div>
            </Panel>

            <Panel title="Code" className="min-h-0 overflow-hidden">
              <div className="flex h-full min-h-0 flex-col gap-2 p-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCodeTab('source')}
                    className={[
                      'rounded-md px-3 py-1.5 text-xs font-semibold transition',
                      codeTab === 'source'
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'bg-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                    ].join(' ')}
                  >
                    {isWorkspacePlugin ? 'Manifest (YAML)' : 'Source (TS)'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCodeTab('python')}
                    className={[
                      'rounded-md px-3 py-1.5 text-xs font-semibold transition',
                      codeTab === 'python'
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'bg-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                    ].join(' ')}
                  >
                    {isWorkspacePlugin ? 'Wrapper (Python)' : 'Python (mock)'}
                  </button>
                  <div className="ml-auto text-[11px] text-zinc-500">
                    {isWorkspacePlugin ? (
                      <span className="flex items-center gap-2">
                        {isLockedStock ? (
                          <span className="rounded bg-amber-900/30 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
                            LOCKED
                          </span>
                        ) : null}
                        <span>read-only</span>
                      </span>
                    ) : codeTab === 'python' ? (
                      editableMode ? 'editable' : 'read-only'
                    ) : (
                      'read-only'
                    )}
                  </div>
                  {isLockedStock ? (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const suggested = `${plugin.id}.dev`
                          const newId = window.prompt('Fork as new plugin id:', suggested) || ''
                          const trimmed = newId.trim()
                          if (!trimmed) return
                          setForkStatus('forking…')
                          const r = await fetch('/api/saw/plugins/fork', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ from_plugin_id: plugin.id, new_plugin_id: trimmed }),
                          })
                          if (!r.ok) throw new Error(await r.text())
                          setForkStatus(`forked: ${trimmed}`)
                          await refreshWorkspacePlugins()
                        } catch (e: any) {
                          setForkStatus(`fork failed: ${String(e?.message ?? e)}`)
                        }
                      }}
                      className="rounded-md border border-amber-700/50 bg-amber-900/20 px-2 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-900/30"
                      title="Create an editable copy with a new plugin id (keeps the stock plugin locked)"
                    >
                      Fork…
                    </button>
                  ) : null}
                </div>
                {forkStatus ? <div className="text-[11px] text-zinc-500">{forkStatus}</div> : null}

                <div className="min-h-0 flex-1">
                  {isWorkspacePlugin ? (
                    codeTab === 'source' ? (
                      <ReadOnlyFileViewer path={manifestPath} />
                    ) : (
                      <ReadOnlyFileViewer path={wrapperPath} />
                    )
                  ) : codeTab === 'source' ? (
                    <SourceViewer paths={plugin.sourcePaths ?? []} />
                  ) : (
                    <div className="h-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
                      <Editor
                        height="100%"
                        defaultLanguage="python"
                        theme="vs-dark"
                        value={node.data.code}
                        onChange={(v) => {
                          // legacy placeholder; node code editing removed
                          void v
                        }}
                        options={{
                          readOnly: !editableMode,
                          fontSize: 13,
                          minimap: { enabled: false },
                          wordWrap: 'on',
                          scrollBeyondLastLine: false,
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </div>
        </Panel>
      </div>
    </div>
  )
}


