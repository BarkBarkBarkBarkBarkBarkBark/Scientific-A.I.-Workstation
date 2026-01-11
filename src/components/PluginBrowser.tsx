import { useMemo, useState } from 'react'
import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'

export function PluginBrowser() {
  const [q, setQ] = useState('')
  const layout = useSawStore((s) => s.layout)
  const toggleLeftSidebar = useSawStore((s) => s.toggleLeftSidebar)
  const catalog = useSawStore((s) => s.pluginCatalog)
  const workspacePlugins = useSawStore((s) => s.workspacePlugins)
  const refreshWorkspacePlugins = useSawStore((s) => s.refreshWorkspacePlugins)

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return catalog
    return catalog.filter((p) => {
      return (
        p.name.toLowerCase().includes(s) ||
        p.description.toLowerCase().includes(s) ||
        p.id.toLowerCase().includes(s)
      )
    })
  }, [q, catalog])

  type CatNode =
    | { kind: 'dir'; name: string; path: string; children: CatNode[] }
    | { kind: 'leaf'; name: string; path: string; pluginIds: string[] }

  const tree = useMemo(() => {
    const root: { kind: 'dir'; name: string; path: string; children: CatNode[] } = {
      kind: 'dir',
      name: '',
      path: '',
      children: [],
    }

    const byId = new Map(filtered.map((p) => [p.id, p]))

    for (const p of filtered) {
      const parts = (p.categoryPath || 'misc').split('/').filter(Boolean)
      let cur = root
      let acc = ''
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!
        acc = acc ? `${acc}/${part}` : part
        const isLeaf = i === parts.length - 1
        if (isLeaf) {
          let leaf = cur.children.find(
            (c): c is Extract<CatNode, { kind: 'leaf' }> => c.kind === 'leaf' && c.name === part,
          )
          if (!leaf) {
            leaf = { kind: 'leaf', name: part, path: acc, pluginIds: [] }
            cur.children.push(leaf)
          }
          leaf.pluginIds.push(p.id)
        } else {
          let next = cur.children.find(
            (c): c is Extract<CatNode, { kind: 'dir' }> => c.kind === 'dir' && c.name === part,
          )
          if (!next) {
            next = { kind: 'dir', name: part, path: acc, children: [] }
            cur.children.push(next)
          }
          cur = next
        }
      }
    }

    const sort = (nodes: CatNode[]) => {
      nodes.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (const n of nodes) if (n.kind === 'dir') sort(n.children)
      for (const n of nodes) if (n.kind === 'leaf') n.pluginIds.sort()
    }
    sort(root.children)

    const countPlugins = (n: CatNode): number => {
      if (n.kind === 'leaf') return n.pluginIds.length
      return n.children.reduce((acc, c) => acc + countPlugins(c), 0)
    }

    const renderPluginRow = (pluginId: string) => {
      const p = byId.get(pluginId)
      if (!p) return null
      const disabled = layout.leftCollapsed
      return (
        <div
          key={p.id}
          draggable={!disabled}
          onDragStart={(e) => {
            if (disabled) return
            e.dataTransfer.setData('application/saw-plugin', p.id)
            e.dataTransfer.setData('text/plain', p.id)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          className={[
            'group flex items-center gap-2 rounded px-1.5 py-1 text-xs',
            disabled ? 'opacity-60' : 'cursor-grab active:cursor-grabbing hover:bg-zinc-900/60',
          ].join(' ')}
          title={
            disabled
              ? 'Expand sidebar to drag'
              : `${p.name}\n\n${p.id}\n\n${p.description}`
          }
        >
          <div className="min-w-0 flex-1 truncate text-zinc-200">{p.name}</div>
          {p.locked ? (
            <div className="text-[10px] font-semibold tracking-wide text-amber-200">LOCKED</div>
          ) : p.origin === 'dev' ? (
            <div className="text-[10px] text-zinc-500">dev</div>
          ) : null}
        </div>
      )
    }

    const render = (n: CatNode): JSX.Element => {
      if (n.kind === 'leaf') {
        return (
          <details key={n.path} className="select-none">
            <summary className="cursor-pointer px-1.5 py-1 text-xs font-semibold text-zinc-300 hover:text-zinc-100">
              {n.name}/ <span className="text-zinc-600">({n.pluginIds.length})</span>
            </summary>
            <div className="ml-3 border-l border-zinc-800 pl-2">
              {n.pluginIds.map((id) => renderPluginRow(id))}
            </div>
          </details>
        )
      }

      return (
        <details key={n.path} className="select-none">
          <summary className="cursor-pointer px-1.5 py-1 text-xs font-semibold text-zinc-200 hover:text-zinc-100">
            {n.name}/ <span className="text-zinc-700">({countPlugins(n)})</span>
          </summary>
          <div className="ml-3 border-l border-zinc-800 pl-2">
            {n.children.map((c) => render(c))}
          </div>
        </details>
      )
    }

    return root.children.map((n) => render(n))
  }, [filtered, layout.leftCollapsed])

  return (
    <Panel
      title="Plugin Browser"
      right={
        <div className="flex items-center gap-2">
          <div className="text-[11px] text-zinc-500">
            ws:{' '}
            <span className="font-mono text-zinc-300">
              {workspacePlugins.length}
            </span>{' '}
            total:{' '}
            <span className="font-mono text-zinc-300">
              {catalog.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void refreshWorkspacePlugins()}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Re-fetch workspace plugins from SAW API (/plugins/list)"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={toggleLeftSidebar}
            className={[
              'rounded-md border border-zinc-700 bg-zinc-950 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900',
              layout.leftCollapsed ? 'px-2 py-1' : 'px-2 py-1',
            ].join(' ')}
            aria-label={layout.leftCollapsed ? 'Expand plugin browser' : 'Collapse plugin browser'}
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
            <div className="text-[11px] text-zinc-400">Plugins</div>
          </button>
        ) : (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search plugins…"
            className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
        )}

        {!layout.leftCollapsed && (
          <div className="saw-scroll min-h-0 flex-1 overflow-y-scroll pr-1">
            {q.trim() ? (
              <div className="space-y-0.5">
                {filtered.map((p) => (
                  <div
                    key={p.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/saw-plugin', p.id)
                      e.dataTransfer.setData('text/plain', p.id)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    className="cursor-grab rounded px-1.5 py-1 text-xs text-zinc-200 hover:bg-zinc-900/60 active:cursor-grabbing"
                    title={`${p.name}\n\n${p.id}\n\n${p.description}`}
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 truncate">{p.name}</div>
                      {p.locked ? (
                        <div className="text-[10px] font-semibold tracking-wide text-amber-200">LOCKED</div>
                      ) : p.origin === 'dev' ? (
                        <div className="text-[10px] text-zinc-500">dev</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
          ) : (
              <div className="space-y-0.5">{tree}</div>
          )}
          </div>
        )}

        {!layout.leftCollapsed && (
          <div className="text-[11px] text-zinc-500">
            Tip: drag a plugin into Pipeline drop zones or Graph canvas.
          </div>
        )}
      </div>
    </Panel>
  )
}


