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

export function ReadOnlyFileViewer(props: { path: string }) {
  const path = String(props.path || '')
  const [content, setContent] = useState<string>('')
  const [status, setStatus] = useState<string>('')

  const language = useMemo(() => langFor(path), [path])

  useEffect(() => {
    void (async () => {
      if (!path) return
      try {
        setStatus('loading…')
        const r = await fetch(`/api/dev/file?path=${encodeURIComponent(path)}`)
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as { content: string }
        setContent(String(j.content ?? ''))
        setStatus('')
      } catch (e: any) {
        setContent('')
        setStatus(String(e?.message ?? e))
      }
    })()
  }, [path])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {status ? <div className="text-[11px] text-zinc-500">{status}</div> : null}
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
        <Editor
          height="100%"
          defaultLanguage={language}
          theme="vs-dark"
          value={content}
          options={{
            readOnly: true,
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


