import { useSawStore } from '../../store/useSawStore'

export function NodeRunPanel(props: { nodeId: string }) {
  const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) ?? null)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)
  const runPluginNode = useSawStore((s) => s.runPluginNode)

  if (!node) return null
  const plugin = pluginCatalog.find((p) => p.id === node.data.pluginId) ?? null
  if (!plugin) return null

  const running = node.data.status === 'running'
  const lastRun = node.data.runtime?.exec?.last ?? null

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold tracking-wide text-zinc-200">Run</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={running}
            onClick={() => void runPluginNode(node.id)}
            className="rounded-md bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
            title="Execute this plugin via SAW API"
          >
            {running ? 'Running…' : 'Run'}
          </button>
          <button
            type="button"
            disabled={!lastRun}
            onClick={() => {
              if (!lastRun) return
              const blob = new Blob([JSON.stringify(lastRun.outputs ?? {}, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `${plugin.id.replace(/[^a-zA-Z0-9._-]/g, '_')}_outputs.json`
              a.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            }}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
            title="Download last outputs JSON"
          >
            Download outputs
          </button>
        </div>
      </div>

      {lastRun ? (
        <div className="mt-2 space-y-2">
          <div className="text-[11px] text-zinc-500">
            last: {new Date(lastRun.ranAt).toLocaleString()} •{' '}
            <span className={lastRun.ok ? 'text-emerald-300' : 'text-red-300'}>{lastRun.ok ? 'ok' : 'error'}</span>
          </div>
          {lastRun.error ? <div className="text-[11px] text-red-300">{String(lastRun.error)}</div> : null}
          <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-zinc-200">
            {JSON.stringify(lastRun.outputs ?? {}, null, 2)}
          </pre>
          {lastRun.rawStdout || lastRun.rawStderr ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-zinc-400">Raw Python output</div>
              {lastRun.rawStdout ? (
                <div>
                  <div className="text-[11px] text-zinc-500">stdout</div>
                  <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-zinc-200">
                    {lastRun.rawStdout}
                  </pre>
                </div>
              ) : null}
              {lastRun.rawStderr ? (
                <div>
                  <div className="text-[11px] text-zinc-500">stderr</div>
                  <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-red-200">
                    {lastRun.rawStderr}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-zinc-500">No runs yet.</div>
      )}
    </div>
  )
}
