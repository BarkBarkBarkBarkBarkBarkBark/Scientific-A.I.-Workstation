import { useMemo, useState } from 'react'
import { useSawStore } from '../../store/useSawStore'
import { Panel } from '../ui/Panel'

type ExecuteResponse = {
  ok: boolean
  plugin_id: string
  outputs?: any
  logs?: Array<{ level: string; event: string; fields: any }>
  detail?: any
}

export function IngestDirectoryModule() {
  const [directory, setDirectory] = useState('.')
  const [query, setQuery] = useState('patch engine')
  const [topK, setTopK] = useState(8)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')
  const [error, setError] = useState<string>('')

  const plugin = useSawStore((s) => s.pluginCatalog.find((p) => p.id === 'saw.ingest.directory') ?? null)
  const hint = useMemo(() => (plugin?.description ? plugin.description : 'Index workspace files into the vector DB.'), [plugin?.description])

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="text-xs font-semibold tracking-wide text-zinc-200">Directory to ingest</div>
        <div className="mt-1 text-[11px] text-zinc-500">{hint}</div>
        <div className="mt-2 grid grid-cols-[1fr,180px] gap-2">
          <input
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder='e.g. "." or "docs" or "plugins"'
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError('')
              setResult('')
              try {
                const r = await fetch('/api/saw/plugins/execute', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    plugin_id: 'saw.ingest.directory',
                    inputs: { directory: { data: directory } },
                    params: { query, top_k: topK },
                  }),
                })
                const txt = await r.text()
                if (!r.ok) throw new Error(txt)
                const j = JSON.parse(txt) as ExecuteResponse
                setResult(JSON.stringify(j, null, 2))
              } catch (e: any) {
                setError(String(e?.message ?? e))
              } finally {
                setBusy(false)
              }
            }}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
            title="Run ingest (calls SAW API /plugins/execute)"
          >
            {busy ? 'Running…' : 'Run ingest'}
          </button>
        </div>

        <div className="mt-2 grid grid-cols-[1fr,120px] gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Optional: query for nearest neighbors after ingest"
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            disabled={busy}
          />
          <input
            type="number"
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
            min={1}
            max={50}
            step={1}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            disabled={busy}
            title="top_k"
          />
        </div>

        {error ? (
          <div className="mt-2 rounded-md border border-rose-900/40 bg-rose-950/20 p-2 text-[11px] text-rose-200">
            {error}
          </div>
        ) : null}
      </div>

      <Panel title="Last run (raw JSON)" className="overflow-hidden">
        <div className="max-h-[260px] overflow-auto p-3">
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-200">
            {result || '(none yet)'}
          </pre>
        </div>
      </Panel>
    </div>
  )
}


