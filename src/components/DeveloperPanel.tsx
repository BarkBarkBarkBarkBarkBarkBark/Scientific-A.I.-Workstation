import { useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import { Panel } from './ui/Panel'
import { sourceFiles } from '../dev/sourceFiles'
import { useSawStore } from '../store/useSawStore'

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
}) {
  return (
    <div className="space-y-1">
      {props.nodes.map((n) => {
        if (n.kind === 'file') {
          const active = n.path === props.selectedPath
          return (
            <button
              key={n.path}
              type="button"
              onClick={() => props.onSelect(n.path)}
              className={[
                'w-full rounded-md border px-2 py-1.5 text-left text-xs font-mono transition',
                active
                  ? 'border-emerald-700 bg-emerald-900/20 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
              ].join(' ')}
              title={n.path}
            >
              {n.name}
            </button>
          )
        }

        return (
          <details key={n.path} open className="rounded-md border border-zinc-800 bg-zinc-950/20">
            <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-semibold text-zinc-300">
              {n.name}/
            </summary>
            <div className="px-2 pb-2">
              <TreeView
                nodes={n.children}
                selectedPath={props.selectedPath}
                onSelect={props.onSelect}
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
            <TreeView nodes={tree} selectedPath={selectedPath} onSelect={setSelectedPath} />
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
        </div>
      </Panel>

      <Panel title={selected?.path ?? 'Source'} className="h-full overflow-hidden">
        <div className="h-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
          <Editor
            height="100%"
            defaultLanguage={selected?.path.endsWith('.md') ? 'markdown' : 'typescript'}
            theme="vs-dark"
            value={selected?.content ?? ''}
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


