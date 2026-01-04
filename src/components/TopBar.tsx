import { useSawStore } from '../store/useSawStore'

export function TopBar() {
  const editableMode = useSawStore((s) => s.editableMode)
  const setEditableMode = useSawStore((s) => s.setEditableMode)
  const layoutMode = useSawStore((s) => s.layoutMode)
  const setLayoutMode = useSawStore((s) => s.setLayoutMode)
  const reflowPipeline = useSawStore((s) => s.reflowPipeline)

  return (
    <div className="flex h-12 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4">
      <div className="flex items-baseline gap-3">
        <div className="text-sm font-semibold tracking-wide text-zinc-100">
          Scientific AI Workstation
        </div>
        <div className="text-xs text-zinc-500">Frontend MVP (mock execution)</div>
      </div>

      <div className="flex items-center gap-4">
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
            onClick={() => setEditableMode(!editableMode)}
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


