import { useEffect, useMemo, useState } from 'react'
import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'
import { fetchDevFile, fetchDevTree, type DevTreeNode } from '../dev/runtimeTree'

type TreeNode =
  | { kind: 'dir'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string }

function toTreeNodes(runtimeTree: DevTreeNode): TreeNode[] {
  const isHidden = (name: string) => name.startsWith('.')

  const toTreeNode = (n: DevTreeNode): TreeNode => {
    if (n.type === 'file') return { kind: 'file', name: n.name, path: n.path }
    return {
      kind: 'dir',
      name: n.name,
      path: n.path,
      children: (n.children ?? []).filter((c) => !isHidden(c.name)).map(toTreeNode),
    }
  }

  if (runtimeTree.type === 'dir') {
    return (runtimeTree.children ?? []).filter((c) => !isHidden(c.name)).map(toTreeNode)
  }
  return [toTreeNode(runtimeTree)]
}

function flattenFiles(runtimeTree: DevTreeNode | null): string[] {
  if (!runtimeTree) return []
  const out: string[] = []
  const walk = (n: DevTreeNode) => {
    if (n.type === 'file') {
      if (!n.name.startsWith('.')) out.push(n.path)
      return
    }
    for (const c of (n.children ?? []).filter((c) => !c.name.startsWith('.'))) walk(c)
  }
  walk(runtimeTree)
  return out
}

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

export function FileBrowser() {
  const layout = useSawStore((s) => s.layout)
  const toggleLeftSidebar = useSawStore((s) => s.toggleLeftSidebar)
  const setLeftSidebarTab = useSawStore((s) => s.setLeftSidebarTab)

  const [q, setQ] = useState('')
  const [runtimeTree, setRuntimeTree] = useState<DevTreeNode | null>(null)
  const [runtimeErr, setRuntimeErr] = useState<string>('')
  const [selectedPath, setSelectedPath] = useState<string>('')
  const [filePreview, setFilePreview] = useState<string>('')
  const [previewErr, setPreviewErr] = useState<string>('')

  const flatFiles = useMemo(() => flattenFiles(runtimeTree), [runtimeTree])

  const filteredFlatFiles = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return flatFiles.filter((p) => p.toLowerCase().includes(s)).slice(0, 500)
  }, [q, flatFiles])

  const runtimeTreeNodes = useMemo(() => {
    if (!runtimeTree) return null
    return toTreeNodes(runtimeTree)
  }, [runtimeTree])

  const refreshTree = async () => {
    try {
      const t = await fetchDevTree({ root: '.', depth: 8 })
      setRuntimeTree(t)
      setRuntimeErr('')
      if (!selectedPath) {
        const first = flattenFiles(t)[0]
        if (first) setSelectedPath(first)
      }
    } catch (e: any) {
      setRuntimeTree(null)
      setRuntimeErr(String(e?.message ?? e))
    }
  }

  useEffect(() => {
    void refreshTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedPath) return
    void (async () => {
      try {
        const j = await fetchDevFile(selectedPath)
        setFilePreview(j.content)
        setPreviewErr('')
      } catch (e: any) {
        setFilePreview('')
        setPreviewErr(String(e?.message ?? e))
      }
    })()
  }, [selectedPath])

  const previewText = useMemo(() => {
    if (previewErr) return previewErr
    const content = filePreview ?? ''
    const maxChars = 20_000
    if (content.length <= maxChars) return content
    return content.slice(0, maxChars) + `\n\n… (truncated to ${maxChars.toLocaleString()} chars)`
  }, [filePreview, previewErr])

  const onSelect = (path: string) => {
    setSelectedPath(path)
  }

  return (
    <Panel
      title="Files"
      right={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLeftSidebarTab('plugins')}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Switch to Plugins"
          >
            Plugins
          </button>
          <button
            type="button"
            onClick={() => void refreshTree()}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Refresh filesystem tree"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={toggleLeftSidebar}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
            aria-label={layout.leftCollapsed ? 'Expand file browser' : 'Collapse file browser'}
          >
            {layout.leftCollapsed ? '⟩' : 'Collapse'}
          </button>
        </div>
      }
      className="min-h-0 overflow-hidden"
    >
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        {layout.leftCollapsed ? (
          <button
            type="button"
            onClick={toggleLeftSidebar}
            className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/30 p-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Expand"
          >
            <div className="text-lg">⟩</div>
            <div className="text-[11px] text-zinc-400">Files</div>
          </button>
        ) : (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files…"
            className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
        )}

        {!layout.leftCollapsed && (
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="saw-scroll h-full min-h-0 overflow-y-auto pr-1">
              {runtimeErr ? (
                <div className="rounded-md border border-rose-900/60 bg-rose-950/20 p-2 text-xs text-rose-200">
                  {runtimeErr}
                </div>
              ) : q.trim() ? (
                <div className="space-y-0.5">
                  {filteredFlatFiles.length === 0 ? (
                    <div className="px-1.5 py-1 text-xs text-zinc-500">No matches.</div>
                  ) : (
                    filteredFlatFiles.map((p) => {
                      const active = p === selectedPath
                      const name = p.split('/').pop() ?? p
                      return (
                        <div
                          key={p}
                          className={[
                            'flex items-center gap-2 rounded px-1.5 py-1 transition',
                            active ? 'bg-emerald-900/25' : 'hover:bg-zinc-900/60',
                          ].join(' ')}
                          title={p}
                        >
                          <button
                            type="button"
                            onClick={() => onSelect(p)}
                            className={[
                              'min-w-0 flex-1 truncate text-left text-xs font-mono',
                              active ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200',
                            ].join(' ')}
                          >
                            {name}
                            <span className="ml-2 text-[10px] text-zinc-600">{p}</span>
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>
              ) : runtimeTreeNodes ? (
                <TreeView nodes={runtimeTreeNodes} selectedPath={selectedPath} onSelect={onSelect} />
              ) : (
                <div className="px-1.5 py-1 text-xs text-zinc-500">Loading…</div>
              )}
            </div>
          </div>
        )}

        {!layout.leftCollapsed && (
          <div className="min-h-[140px] rounded-md border border-zinc-800 bg-zinc-950/40">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-2 py-1">
              <div className="min-w-0 truncate text-[11px] font-mono text-zinc-400" title={selectedPath}>
                {selectedPath || '—'}
              </div>
              <div className="text-[10px] text-zinc-600">preview</div>
            </div>
            <pre className="saw-scroll h-[140px] overflow-auto p-2 text-[11px] leading-[1.45] text-zinc-200">
              {previewText || (selectedPath ? 'Loading…' : 'Select a file to preview.')}
            </pre>
          </div>
        )}
      </div>
    </Panel>
  )
}
