import { useEffect, useState } from 'react'
import { fetchDevFile } from '../dev/runtimeTree'

const TODO_PATH = 'saw-workspace/todo.md'

export function TodoPanel() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetchDevFile(TODO_PATH)
      setContent(String(r.content ?? ''))
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="h-full overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-zinc-300">Todo</div>
          <div className="truncate text-[11px] text-zinc-500">{TODO_PATH}</div>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-60"
          title="Reload todo.md"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <div className="h-full overflow-auto p-3 text-[12px] text-red-300">{error}</div>
      ) : (
        <div className="h-full overflow-auto p-3">
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-zinc-200">
            {content || '(empty)'}
          </pre>
        </div>
      )}
    </div>
  )
}
