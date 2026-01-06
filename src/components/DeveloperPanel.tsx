import { useEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import { Panel } from './ui/Panel'
import { sourceFiles } from '../dev/sourceFiles'
import { useSawStore } from '../store/useSawStore'
import { fetchDevCaps, fetchDevFile, fetchDevTree, setDevCaps, type CapsManifest, type DevTreeNode } from '../dev/runtimeTree'

type TreeNode =
  | { kind: 'dir'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string }

function buildTree(paths: string[]): TreeNode[] {
  const root: { kind: 'dir'; name: string; path: string; children: TreeNode[] } = {
    kind: 'dir',
    name: '',
    path: '',
    children: [],
  }

  for (const p of paths) {
    const parts = p.split('/').filter(Boolean)
    let cur = root
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      acc = acc ? `${acc}/${part}` : part
      const isFile = i === parts.length - 1
      if (isFile) {
        cur.children.push({ kind: 'file', name: part, path: acc })
      } else {
        let next = cur.children.find(
          (c): c is Extract<TreeNode, { kind: 'dir' }> => c.kind === 'dir' && c.name === part,
        )
        if (!next) {
          next = { kind: 'dir', name: part, path: acc, children: [] }
          cur.children.push(next)
        }
        cur = next
      }
    }
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const n of nodes) if (n.kind === 'dir') sort(n.children)
  }
  sort(root.children)
  return root.children
}

function TreeView(props: {
  nodes: TreeNode[]
  selectedPath: string
  onSelect: (path: string) => void
  renderRight?: (path: string) => JSX.Element | null
}) {
  return (
    <div className="space-y-1">
      {props.nodes.map((n) => {
        if (n.kind === 'file') {
          const active = n.path === props.selectedPath
          return (
            <div
              key={n.path}
              className={[
                'flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 transition',
                active
                  ? 'border-emerald-700 bg-emerald-900/20'
                  : 'border-zinc-800 bg-zinc-950/40 hover:bg-zinc-900',
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
              {props.renderRight ? props.renderRight(n.path) : null}
            </div>
          )
        }

        return (
          <details key={n.path} open className="rounded-md border border-zinc-800 bg-zinc-950/20">
            <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-semibold text-zinc-300">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate">{n.name}/</div>
                {props.renderRight ? props.renderRight(n.path ? n.path + '/' : '.') : null}
              </div>
            </summary>
            <div className="px-2 pb-2">
              <TreeView
                nodes={n.children}
                selectedPath={props.selectedPath}
                onSelect={props.onSelect}
                renderRight={props.renderRight}
              />
            </div>
          </details>
        )
      })}
    </div>
  )
}

export function DeveloperPanel() {
  const [q, setQ] = useState('')
  const [selectedPath, setSelectedPath] = useState(sourceFiles[0]?.path ?? '')
  const [runtimeTree, setRuntimeTree] = useState<DevTreeNode | null>(null)
  const [runtimeErr, setRuntimeErr] = useState<string>('')
  const [fileContent, setFileContent] = useState<string>('')
  const [caps, setCaps] = useState<CapsManifest | null>(null)
  const [capsPath, setCapsPath] = useState<string>(sourceFiles[0]?.path ?? '')
  const [flags, setFlags] = useState<{ SAW_ENABLE_PATCH_ENGINE: boolean; SAW_ENABLE_DB: boolean; SAW_ENABLE_PLUGINS: boolean } | null>(null)
  const [dbHealth, setDbHealth] = useState<string>('')
  const [pluginsList, setPluginsList] = useState<string>('')

  const selected = useMemo(() => {
    return sourceFiles.find((f) => f.path === selectedPath) ?? sourceFiles[0]
  }, [selectedPath])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return sourceFiles
    return sourceFiles.filter((f) => f.path.toLowerCase().includes(s))
  }, [q])

  const tree = useMemo(() => buildTree(filtered.map((f) => f.path)), [filtered])

  const aiStatus = useSawStore((s) => s.aiStatus)
  const refreshAiStatus = useSawStore((s) => s.refreshAiStatus)
  const attached = useSawStore((s) => s.dev.attachedPaths)
  const devAttachPath = useSawStore((s) => s.devAttachPath)
  const devDetachPath = useSawStore((s) => s.devDetachPath)

  useEffect(() => {
    void (async () => {
      try {
        const t = await fetchDevTree({ root: '.', depth: 6 })
        setRuntimeTree(t)
        setRuntimeErr('')
      } catch (e: any) {
        setRuntimeTree(null)
        setRuntimeErr(String(e?.message ?? e))
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const c = await fetchDevCaps()
        setCaps(c)
      } catch {
        setCaps(null)
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/dev/flags')
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as any
        setFlags({
          SAW_ENABLE_PATCH_ENGINE: Boolean(j?.SAW_ENABLE_PATCH_ENGINE),
          SAW_ENABLE_DB: Boolean(j?.SAW_ENABLE_DB),
          SAW_ENABLE_PLUGINS: Boolean(j?.SAW_ENABLE_PLUGINS),
        })
      } catch {
        setFlags(null)
      }
    })()
  }, [])

  useEffect(() => {
    if (!flags?.SAW_ENABLE_DB) return
    void (async () => {
      try {
        const r = await fetch('http://127.0.0.1:5127/health')
        if (!r.ok) throw new Error(await r.text())
        setDbHealth(JSON.stringify(await r.json(), null, 2))
      } catch (e: any) {
        setDbHealth(String(e?.message ?? e))
      }
    })()
  }, [flags?.SAW_ENABLE_DB])

  useEffect(() => {
    if (!flags?.SAW_ENABLE_PLUGINS) return
    void (async () => {
      try {
        const r = await fetch('http://127.0.0.1:5127/plugins/list')
        if (!r.ok) throw new Error(await r.text())
        setPluginsList(JSON.stringify(await r.json(), null, 2))
      } catch (e: any) {
        setPluginsList(String(e?.message ?? e))
      }
    })()
  }, [flags?.SAW_ENABLE_PLUGINS])

  useEffect(() => {
    void (async () => {
      try {
        const j = await fetchDevFile(selectedPath)
        setFileContent(j.content)
      } catch {
        // fallback to bundled index if dev FS unavailable
        setFileContent(selected?.content ?? '')
      }
    })()
    setCapsPath(selectedPath)
  }, [selectedPath, selected?.content])

  const runtimeTreeNodes = useMemo(() => {
    if (!runtimeTree) return null
    const toTreeNode = (n: DevTreeNode): TreeNode => {
      if (n.type === 'file') return { kind: 'file', name: n.name, path: n.path }
      return {
        kind: 'dir',
        name: n.name,
        path: n.path,
        children: (n.children ?? []).map(toTreeNode),
      }
    }
    return [toTreeNode(runtimeTree)]
  }, [runtimeTree])

  const capsByPath = useMemo(() => {
    const m = new Map<string, { r: boolean; w: boolean; d: boolean }>()
    for (const rule of caps?.rules ?? []) {
      m.set(rule.path, { r: rule.r, w: rule.w, d: rule.d })
    }
    return m
  }, [caps?.rules])

  const defaultCaps = useMemo(() => ({ r: true, w: false, d: false }), [])

  const renderCapsInline = (path: string) => {
    const current = capsByPath.get(path) ?? defaultCaps
    return (
      <div className="flex items-center gap-1 text-[10px] text-zinc-500">
        {(['r', 'w', 'd'] as const).map((k) => (
          <label key={k} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={current[k]}
              onChange={async (e) => {
                const next = { ...(capsByPath.get(path) ?? defaultCaps), [k]: e.target.checked }
                try {
                  const updated = await setDevCaps(path, next)
                  setCaps(updated)
                } catch {
                  // ignore
                }
              }}
              title={`${k.toUpperCase()} for ${path}`}
            />
          </label>
        ))}
      </div>
    )
  }

  return (
    <div className="grid h-full grid-cols-[280px,1fr] gap-2">
      <Panel title="Files" className="h-full overflow-hidden">
        <div className="flex h-full flex-col p-2">
          <div className="flex items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter…"
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="mt-2 min-h-0 flex-1 overflow-auto">
            {runtimeTreeNodes ? (
              <TreeView
                nodes={runtimeTreeNodes}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                renderRight={renderCapsInline}
              />
            ) : (
              <>
                <div className="mb-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-[11px] text-zinc-500">
                  Dev tree unavailable; using bundled index.
                  {runtimeErr ? <div className="mt-1 text-zinc-600">{runtimeErr}</div> : null}
                </div>
                <TreeView nodes={tree} selectedPath={selectedPath} onSelect={setSelectedPath} />
              </>
            )}
          </div>

          <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-[11px] text-zinc-400">
            <div className="font-semibold text-zinc-300">Capabilities (per-file)</div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="font-mono text-zinc-300">{capsPath}</div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={capsPath}
                onChange={(e) => setCapsPath(e.target.value)}
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                placeholder='e.g. "src/components/" or "." or "test.md"'
              />
              <button
                type="button"
                onClick={async () => {
                  const current = capsByPath.get(capsPath) ?? defaultCaps
                  try {
                    const updated = await setDevCaps(capsPath, current)
                    setCaps(updated)
                  } catch {
                    // ignore
                  }
                }}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
                title="Ensure a caps rule exists for this path"
              >
                Use
              </button>
            </div>
            <div className="mt-2 flex items-center gap-3">
              {(['r', 'w', 'd'] as const).map((k) => {
                const current = capsByPath.get(capsPath) ?? defaultCaps
                const checked = current[k]
                return (
                  <label key={k} className="flex items-center gap-1 text-[11px] text-zinc-300">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={async (e) => {
                        const next = { ...(capsByPath.get(capsPath) ?? defaultCaps), [k]: e.target.checked }
                        try {
                          const updated = await setDevCaps(capsPath, next)
                          setCaps(updated)
                        } catch {
                          // ignore
                        }
                      }}
                    />
                    {k.toUpperCase()}
                  </label>
                )
              })}
            </div>
            <div className="mt-1 text-zinc-500">R=read, W=write, D=delete</div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => devAttachPath(capsPath)}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
              >
                Attach to Chat
              </button>
              <div className="text-[11px] text-zinc-500">{attached.length} attached</div>
            </div>
            {attached.length > 0 && (
              <div className="mt-2 space-y-1">
                {attached.slice(0, 6).map((p) => (
                  <div key={p} className="flex items-center justify-between gap-2">
                    <div className="truncate font-mono text-[11px] text-zinc-500">{p}</div>
                    <button
                      type="button"
                      onClick={() => devDetachPath(p)}
                      className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                      title="Detach"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-[11px] text-zinc-400">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-zinc-300">OpenAI (dev proxy)</div>
              <button
                type="button"
                onClick={() => void refreshAiStatus()}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-900"
              >
                Refresh
              </button>
            </div>
            <div className="mt-1">
              status:{' '}
              <span className={aiStatus?.enabled ? 'text-emerald-400' : 'text-zinc-500'}>
                {aiStatus?.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            <div className="text-zinc-500">model: {aiStatus?.model ?? 'unknown'}</div>
            <div className="mt-1 text-zinc-500">
              set <span className="font-mono text-zinc-300">OPENAI_API_KEY</span> then restart dev
            </div>
          </div>

          <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-[11px] text-zinc-400">
            <div className="font-semibold text-zinc-300">Local services</div>
            <div className="mt-1 text-zinc-500">
              flags:{' '}
              <span className="font-mono text-zinc-300">
                {flags ? JSON.stringify(flags) : '(unavailable)'}
              </span>
            </div>
            {flags?.SAW_ENABLE_DB ? (
              <details className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
                <summary className="cursor-pointer select-none text-[11px] font-semibold text-zinc-300">
                  DB health (127.0.0.1:5127)
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-zinc-200">
                  {dbHealth || '(loading)'}
                </pre>
              </details>
            ) : (
              <div className="mt-2 text-zinc-500">
                DB: disabled (set <span className="font-mono text-zinc-300">SAW_ENABLE_DB=1</span> before <span className="font-mono text-zinc-300">npm run dev</span>)
              </div>
            )}
            {flags?.SAW_ENABLE_PLUGINS ? (
              <details className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
                <summary className="cursor-pointer select-none text-[11px] font-semibold text-zinc-300">
                  Plugins list
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-zinc-200">
                  {pluginsList || '(loading)'}
                </pre>
              </details>
            ) : (
              <div className="mt-1 text-zinc-500">
                Plugins: disabled (set <span className="font-mono text-zinc-300">SAW_ENABLE_PLUGINS=1</span> before <span className="font-mono text-zinc-300">npm run dev</span>)
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Panel title={selected?.path ?? 'Source'} className="h-full overflow-hidden">
        <div className="h-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
          <Editor
            height="100%"
            defaultLanguage={selected?.path.endsWith('.md') ? 'markdown' : 'typescript'}
            theme="vs-dark"
            value={fileContent}
            options={{
              readOnly: true,
              fontSize: 12,
              minimap: { enabled: false },
              wordWrap: 'on',
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      </Panel>
    </div>
  )
}


