import Editor from '@monaco-editor/react'
import { useEffect, useMemo, useState } from 'react'
import { fetchDevFile } from '../dev/runtimeTree'
import { parseTodoRenderLines, toggleCheckboxAtLine } from '../markdown/todo'

const DOCS = [
  { id: 'todo', title: 'Todo', path: 'saw-workspace/todo.md' },
  { id: 'agent', title: 'Agent workspace', path: 'saw-workspace/agent/agent_workspace.md' },
] as const
type DocId = (typeof DOCS)[number]['id']
import { useSawStore } from '../store/useSawStore'
import { ResizableDivider } from './ui/ResizableDivider'

export function TodoPanel() {
  const layout = useSawStore((s) => s.layout)
  const setLayout = useSawStore((s) => s.setLayout)

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeDoc, setActiveDoc] = useState<DocId>('todo')
  const [content, setContent] = useState<string>('') // last loaded
  const [draft, setDraft] = useState<string>('') // editable
  const dirty = draft !== content
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth))

  const doc = useMemo(() => DOCS.find((d) => d.id === activeDoc) ?? DOCS[0], [activeDoc])
  const lines = useMemo(() => parseTodoRenderLines(draft), [draft])

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetchDevFile(doc.path)
      const next = String(r.content ?? '')
      setContent(next)
      setDraft(next)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const r = await fetch('/api/dev/safe/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: doc.path, content: draft }),
      })
      if (!r.ok) throw new Error(await r.text())
      setContent(draft)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path])

  useEffect(() => {
    setVw(typeof window === 'undefined' ? 1200 : window.innerWidth)
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div className="h-full overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-zinc-300">{doc.title}</div>
          <div className="truncate text-[11px] text-zinc-500">{doc.path}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
            {DOCS.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setActiveDoc(d.id)}
                className={[
                  'px-2 py-1 text-[11px] font-semibold',
                  activeDoc === d.id
                    ? 'bg-emerald-900/30 text-emerald-200'
                    : 'text-zinc-300 hover:bg-zinc-900',
                ].join(' ')}
              >
                {d.id === 'todo' ? 'Todo' : 'Agent'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={save}
            disabled={loading || saving || !dirty}
            className="rounded-md bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
            title="Save"
          >
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading || saving}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-60"
            title="Reload"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="h-full overflow-auto p-3 text-[12px] text-red-300">{error}</div>
      ) : (
        <div className="h-full min-h-0 overflow-hidden p-3">
          <div
            className="grid h-full min-h-0 gap-3"
            style={{ gridTemplateColumns: `${layout.todoEditorWidth}px 12px 1fr` }}
          >
            <div className="min-h-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
              <Editor
                height="100%"
                defaultLanguage="markdown"
                theme="vs-dark"
                value={draft}
                onChange={(v) => setDraft(String(v ?? ''))}
                options={{
                  fontSize: 12,
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                }}
              />
            </div>

            <div className="rounded-md border border-zinc-800 bg-zinc-950/40">
              <ResizableDivider
                orientation="vertical"
                value={layout.todoEditorWidth}
                setValue={(v) => setLayout({ todoEditorWidth: v })}
                min={320}
                max={Math.max(420, vw - 520)}
              />
            </div>

            <div className="min-h-0 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[12px] leading-relaxed text-zinc-200">
              {lines.length === 0 ? (
                <div className="text-zinc-500">(empty)</div>
              ) : (
                <div className="space-y-1">
                  {lines.map((l) => {
                    if (l.kind === 'checkbox') {
                      return (
                        <label key={l.lineIndex} className="flex cursor-pointer items-start gap-2">
                          <input
                            type="checkbox"
                            checked={l.checked}
                            onChange={() => setDraft((prev) => toggleCheckboxAtLine(prev, l.lineIndex))}
                            className="mt-[3px] h-3 w-3 accent-emerald-600"
                          />
                          <span className={l.checked ? 'text-zinc-500 line-through' : ''}>
                            {l.text || <span className="text-zinc-600">(blank)</span>}
                          </span>
                        </label>
                      )
                    }
                    // Keep text lines readable; preserve empty lines.
                    return (
                      <div key={l.lineIndex} className="whitespace-pre-wrap font-mono text-[12px] text-zinc-300">
                        {l.text || '\u00A0'}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
