import Editor from '@monaco-editor/react'
import { useEffect, useMemo, useState } from 'react'
import { useSawStore } from '../store/useSawStore'
import { Panel } from './ui/Panel'
import { ResizableDivider } from './ui/ResizableDivider'
import { SourceViewer } from './SourceViewer'
import { ReadOnlyFileViewer } from './ReadOnlyFileViewer'
import { NodeInputs } from './inspector/NodeInputs'
import { NodeParameters } from './inspector/NodeParameters'
import { NodeRunPanel } from './inspector/NodeRunPanel'
import { fetchDevTree, type DevTreeNode } from '../dev/runtimeTree'
import { SchemaPluginUi } from './plugin_ui/SchemaPluginUi'
import { BundlePluginUi } from './plugin_ui/BundlePluginUi'
import { getA2uiFeatureFlags } from '../plugins/a2ui/featureFlags'

type TreeNode =
  | { kind: 'dir'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string }

function TreeView(props: {
  nodes: TreeNode[]
  selectedPath: string
  onSelect: (path: string) => void
}) {
  return (
    <div className="space-y-0.5">
      {props.nodes.map((n) => {
        if (n.kind === 'file') {
          const active = n.path === props.selectedPath
          return (
            <div
              key={n.path}
              className={[
                'flex items-center justify-between gap-2 rounded px-1.5 py-1 transition',
                active ? 'bg-emerald-900/25' : 'hover:bg-zinc-900/60',
              ].join(' ')}
              title={n.path}
            >
              <button
                type="button"
                onClick={() => props.onSelect(n.path)}
                className={[
                  'min-w-0 flex-1 truncate text-left text-xs font-mono',
                  active ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200',
                ].join(' ')}
              >
                {n.name}
              </button>
            </div>
          )
        }

        return (
          <details key={n.path} className="select-none">
            <summary className="cursor-pointer px-1.5 py-1 text-xs font-semibold text-zinc-300 hover:text-zinc-100">
              <div className="truncate">{n.name}/</div>
            </summary>
            <div className="ml-3 border-l border-zinc-800 pl-2">
              <TreeView nodes={n.children} selectedPath={props.selectedPath} onSelect={props.onSelect} />
            </div>
          </details>
        )
      })}
    </div>
  )
}

export function ModuleFullscreenModal() {
  const fullscreen = useSawStore((s) => s.fullscreen)
  const closeFullscreen = useSawStore((s) => s.closeFullscreen)
  const editableMode = useSawStore((s) => s.editableMode)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)
  const runPluginNode = useSawStore((s) => s.runPluginNode)
  const layout = useSawStore((s) => s.layout)
  const setLayout = useSawStore((s) => s.setLayout)

  const node = useSawStore((s) => s.nodes.find((n) => n.id === fullscreen.nodeId) ?? null)
  const plugin = useMemo(
    () => (node ? pluginCatalog.find((p) => p.id === node.data.pluginId) ?? null : null),
    [node, pluginCatalog],
  )
  const [codeTab, setCodeTab] = useState<'source' | 'python' | 'dir' | 'app'>('source')
  const refreshWorkspacePlugins = useSawStore((s) => s.refreshWorkspacePlugins)
  const [forkStatus, setForkStatus] = useState<string>('')

  const [dirTree, setDirTree] = useState<DevTreeNode | null>(null)
  const [dirErr, setDirErr] = useState<string>('')
  const [dirSelectedPath, setDirSelectedPath] = useState<string>('')
  const [dirRootInUse, setDirRootInUse] = useState<string>('')
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1400 : window.innerWidth))

  useEffect(() => {
    if (!fullscreen.open) return
    setVw(typeof window === 'undefined' ? 1400 : window.innerWidth)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeFullscreen()
    }
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen.open, closeFullscreen])

  const pluginId = plugin?.id ?? ''
  const manifestPath = (plugin?.sourcePaths ?? []).find((p) => p.endsWith('/plugin.yaml') || p.endsWith('/plugin.yml')) ?? ''
  const wrapperPath = (plugin?.sourcePaths ?? []).find((p) => p.endsWith('/wrapper.py')) ?? ''
  const isWorkspacePlugin = Boolean(manifestPath && wrapperPath)
  const isLockedStock = Boolean(isWorkspacePlugin && plugin?.locked && plugin?.origin === 'stock')
  const canShowAppPane = Boolean(isWorkspacePlugin && plugin?.ui?.mode === 'bundle')
  const pluginRoot = useMemo(() => {
    if (!isWorkspacePlugin) return ''
    if (!manifestPath) return ''
    return manifestPath.replace(/\/(plugin\.ya?ml)$/i, '')
  }, [isWorkspacePlugin, manifestPath])
  const pluginArtifactsRoot = useMemo(() => {
    // Convention: per-plugin data/artifacts live here (not committed).
    // We only show Directory for workspace plugins for now.
    if (!isWorkspacePlugin) return ''
    if (!pluginId) return ''
    return `saw-workspace/artifacts/${pluginId}`
  }, [isWorkspacePlugin, pluginId])

  useEffect(() => {
    if (!fullscreen.open) return
    if (!isWorkspacePlugin) return
    if (codeTab !== 'dir') return
    if (!pluginArtifactsRoot && !pluginRoot) return

    let cancelled = false
    void (async () => {
      try {
        // Prefer the per-plugin artifacts directory. If it doesn't exist yet,
        // fall back to the plugin's code folder.
        let t: DevTreeNode | null = null
        let usedRoot = ''
        try {
          if (pluginArtifactsRoot) {
            t = await fetchDevTree({ root: pluginArtifactsRoot, depth: 6 })
            usedRoot = pluginArtifactsRoot
          }
        } catch {
          t = null
          usedRoot = ''
        }

        if (!t) {
          if (!pluginRoot) throw new Error('Missing plugin root')
          t = await fetchDevTree({ root: pluginRoot, depth: 6 })
          usedRoot = pluginRoot
        }
        if (cancelled) return
        setDirTree(t)
        setDirErr('')
        setDirRootInUse(usedRoot)

        // If we were showing a file that isn't in the current root, clear it.
        if (dirSelectedPath && usedRoot && !dirSelectedPath.startsWith(usedRoot + '/')) {
          setDirSelectedPath('')
        }
      } catch (e: any) {
        if (cancelled) return
        setDirTree(null)
        setDirErr(String(e?.message ?? e))
        setDirRootInUse('')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [fullscreen.open, isWorkspacePlugin, codeTab, pluginArtifactsRoot, pluginRoot, dirSelectedPath])

  const dirTreeNodes = useMemo(() => {
    if (!dirTree) return null
    const toTreeNode = (n: DevTreeNode): TreeNode => {
      if (n.type === 'file') return { kind: 'file', name: n.name, path: n.path }
      return { kind: 'dir', name: n.name, path: n.path, children: (n.children ?? []).map(toTreeNode) }
    }
    if (dirTree.type === 'dir') {
      return (dirTree.children ?? []).map(toTreeNode)
    }
    return [toTreeNode(dirTree)]
  }, [dirTree])

  if (!fullscreen.open || !node || !plugin) return null

  const defaultUi = (
    <>
      <NodeInputs nodeId={node.id} />
      <NodeParameters nodeId={node.id} />
      {isWorkspacePlugin ? <NodeRunPanel nodeId={node.id} /> : null}
      <div className="space-y-2">
        <div className="text-sm text-zinc-200">{plugin.description}</div>
      </div>
    </>
  )

  return (
    <div
      className="fixed left-0 top-0 z-[60] bg-black/70 p-4"
      style={{ right: layout.bottomChatWidth + 12, bottom: layout.bottomHeight + 12 }}
    >
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
          <div
            className="grid h-full min-h-0 gap-2 p-2"
            style={{ gridTemplateColumns: `${layout.moduleFullscreenLeftWidth}px 12px 1fr` }}
          >
            <Panel title="Module" className="min-h-0 overflow-hidden">
              <div className="h-full overflow-auto p-3">
                <div className="space-y-3">
                  {(() => {
                    const flags = getA2uiFeatureFlags()

                    if (plugin.ui?.mode === 'schema') {
                      if (flags.allowLegacyUi && flags.forceLegacyUi) {
                        return <BundlePluginUi nodeId={node.id} plugin={plugin} fallback={defaultUi} />
                      }
                      return <SchemaPluginUi nodeId={node.id} plugin={plugin} fallback={defaultUi} />
                    }

                    if (plugin.ui?.mode === 'bundle') {
                      return <BundlePluginUi nodeId={node.id} plugin={plugin} fallback={defaultUi} />
                    }

                    return <div className="space-y-3">{defaultUi}</div>
                  })()}
                </div>
              </div>
            </Panel>

            <div className="rounded-md border border-zinc-800 bg-zinc-950/40">
              <ResizableDivider
                orientation="vertical"
                value={layout.moduleFullscreenLeftWidth}
                setValue={(v) => setLayout({ moduleFullscreenLeftWidth: v })}
                min={360}
                max={Math.max(520, vw - layout.bottomChatWidth - 520)}
              />
            </div>

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
                    {isWorkspacePlugin ? 'Wrapper (Python)' : 'Python (fallback)'}
                  </button>
                  {canShowAppPane ? (
                    <button
                      type="button"
                      onClick={() => setCodeTab('app')}
                      className={[
                        'rounded-md px-3 py-1.5 text-xs font-semibold transition',
                        codeTab === 'app'
                          ? 'bg-zinc-800 text-zinc-100'
                          : 'bg-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                      ].join(' ')}
                      title="Render the plugin UI bundle"
                    >
                      App
                    </button>
                  ) : null}
                  {isWorkspacePlugin ? (
                    <button
                      type="button"
                      onClick={() => setCodeTab('dir')}
                      className={[
                        'rounded-md px-3 py-1.5 text-xs font-semibold transition',
                        codeTab === 'dir'
                          ? 'bg-zinc-800 text-zinc-100'
                          : 'bg-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                      ].join(' ')}
                      title="Browse plugin folder"
                    >
                      Directory
                    </button>
                  ) : null}
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
                    ) : codeTab === 'python' ? (
                      <ReadOnlyFileViewer path={wrapperPath} />
                    ) : codeTab === 'app' ? (
                      <div className="h-full overflow-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
                        <BundlePluginUi nodeId={node.id} plugin={plugin} fallback={defaultUi} />
                      </div>
                    ) : (
                      <div
                        className="grid h-full min-h-0 gap-2"
                        style={{ gridTemplateColumns: `${layout.moduleFullscreenDirTreeWidth}px 12px 1fr` }}
                      >
                        <div className="min-h-0 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
                          <div className="mb-2">
                            <div className="text-[11px] font-semibold text-zinc-300">{dirRootInUse || pluginArtifactsRoot || pluginRoot || 'Directory'}</div>
                            {pluginArtifactsRoot ? (
                              <div className="mt-1 text-[10px] text-zinc-500">
                                default: {pluginArtifactsRoot}
                                {dirRootInUse && dirRootInUse !== pluginArtifactsRoot ? ' (fallback)' : ''}
                              </div>
                            ) : null}
                          </div>
                          {dirTreeNodes ? (
                            <TreeView
                              nodes={dirTreeNodes}
                              selectedPath={dirSelectedPath}
                              onSelect={setDirSelectedPath}
                            />
                          ) : (
                            <div className="text-[11px] text-zinc-500">
                              {dirErr ? `Directory unavailable: ${dirErr}` : 'Loading…'}
                            </div>
                          )}
                        </div>

                        <div className="rounded-md border border-zinc-800 bg-zinc-950/40">
                          <ResizableDivider
                            orientation="vertical"
                            value={layout.moduleFullscreenDirTreeWidth}
                            setValue={(v) => setLayout({ moduleFullscreenDirTreeWidth: v })}
                            min={200}
                            max={Math.max(260, vw - 720)}
                          />
                        </div>
                        <div className="min-h-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
                          {dirSelectedPath ? (
                            <ReadOnlyFileViewer path={dirSelectedPath} />
                          ) : (
                            <div className="p-3 text-[11px] text-zinc-500">Select a file to preview.</div>
                          )}
                        </div>
                      </div>
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
