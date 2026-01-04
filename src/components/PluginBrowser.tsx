import { useMemo, useState } from 'react'
import { plugins } from '../mock/plugins'
import { Panel } from './ui/Panel'

export function PluginBrowser() {
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return plugins
    return plugins.filter((p) => {
      return (
        p.name.toLowerCase().includes(s) ||
        p.description.toLowerCase().includes(s) ||
        p.id.toLowerCase().includes(s)
      )
    })
  }, [q])

  return (
    <Panel title="Plugin Browser" className="min-h-0 overflow-hidden">
      <div className="flex flex-col gap-2 p-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search plugins…"
          className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
        />
        <div className="min-h-0 overflow-auto pr-1">
          <div className="flex flex-col gap-2">
            {filtered.map((p) => (
              <div
                key={p.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/saw-plugin', p.id)
                  // Safari/compat: always set a plain-text payload too.
                  e.dataTransfer.setData('text/plain', p.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                className="cursor-grab rounded-md border border-zinc-800 bg-zinc-950/40 p-3 active:cursor-grabbing"
                title="Drag to canvas"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-zinc-100">{p.name}</div>
                  <div className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400">
                    v{p.version}
                  </div>
                </div>
                <div className="mt-1 text-xs leading-snug text-zinc-400">{p.description}</div>
                <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-zinc-500">
                  {p.outputs.map((o) => (
                    <span key={o.id} className="rounded bg-zinc-900 px-2 py-0.5">
                      out:{o.type}
                    </span>
                  ))}
                  {p.inputs.map((i) => (
                    <span key={i.id} className="rounded bg-zinc-900 px-2 py-0.5">
                      in:{i.type}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="text-[11px] text-zinc-500">
          Tip: drag a plugin onto the canvas to create a node.
        </div>
      </div>
    </Panel>
  )
}


