import Editor from '@monaco-editor/react'
import { useEffect, useMemo, useState } from 'react'

function langFor(path: string) {
  const p = (path || '').toLowerCase()
  if (p.endsWith('.py')) return 'python'
  if (p.endsWith('.yaml') || p.endsWith('.yml')) return 'yaml'
  if (p.endsWith('.json')) return 'json'
  if (p.endsWith('.md')) return 'markdown'
  return 'text'
}

export function ReadOnlyFileViewer(props: { path: string; canEdit?: boolean }) {
  const path = String(props.path || '')
  const [content, setContent] = useState<string>('')
  const [draft, setDraft] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [locked, setLocked] = useState<boolean>(true)

  const language = useMemo(() => langFor(path), [path])

  const canEdit = Boolean(props.canEdit)

  useEffect(() => {
    if (!canEdit) setLocked(true)
  }, [canEdit])

  useEffect(() => {
    void (async () => {
      if (!path) return
      try {
        setStatus('loading…')
        const r = await fetch(`/api/dev/file?path=${encodeURIComponent(path)}`)
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as { content: string }
        const next = String(j.content ?? '')
        setContent(next)
        setDraft(next)
        setStatus('')
      } catch (e: any) {
        setContent('')
        setDraft('')
        setStatus(String(e?.message ?? e))
      }
    })()
  }, [path])

  async function saveToDisk() {
    try {
      if (!path) return
      setStatus('saving…')
      const r = await fetch('/api/dev/safe/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: draft }),
      })
      if (!r.ok) throw new Error(await r.text())
      setContent(draft)
      setStatus('saved')
    } catch (e: any) {
      setStatus(`save failed: ${String(e?.message ?? e)}`)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        {status ? <div className="text-[11px] text-zinc-500">{status}</div> : <div />}
        <div className="flex items-center gap-2">
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={() => setLocked((v) => !v)}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
                title={locked ? 'Unlock editor for editing' : 'Lock editor (read-only)'}
              >
                {locked ? 'Unlock' : 'Lock'}
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => void saveToDisk()}
                className="rounded-md bg-emerald-700 px-2 py-1.5 text-xs font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
                title="Save file to disk"
              >
                Save
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
        <Editor
          height="100%"
          defaultLanguage={language}
          theme="vs-dark"
          value={locked ? content : draft}
          onChange={(v) => {
            if (locked) return
            setDraft(v ?? '')
          }}
          options={{
            readOnly: locked || !canEdit,
            fontSize: 12,
            minimap: { enabled: false },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  )
}


