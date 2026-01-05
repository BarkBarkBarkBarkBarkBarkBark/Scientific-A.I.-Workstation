import Editor, { DiffEditor, type Monaco } from '@monaco-editor/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { sourceFiles } from '../dev/sourceFiles'

const contentByPath = new Map(sourceFiles.map((f) => [f.path, f.content]))

function langFor(path: string) {
  if (path.endsWith('.tsx') || path.endsWith('.ts')) return 'typescript'
  if (path.endsWith('.css')) return 'css'
  if (path.endsWith('.md')) return 'markdown'
  if (path.endsWith('.json')) return 'json'
  return 'text'
}

export function SourceViewer(props: { paths: string[] }) {
  const paths = props.paths.filter(Boolean)
  const [selected, setSelected] = useState(paths[0] ?? '')
  const [diskContent, setDiskContent] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [saveError, setSaveError] = useState<string>('')
  const [commitMsg, setCommitMsg] = useState<string>('WIP: update module source (via SAW)')
  const [gitStatus, setGitStatus] = useState<string>('')
  const [gitDiff, setGitDiff] = useState<string>('')
  const [diffHistory, setDiffHistory] = useState<Array<{ ts: number; path: string; diff: string }>>([])
  const [gitOpen, setGitOpen] = useState(false)
  const monacoRef = useRef<Monaco | null>(null)
  const editorRef = useRef<any>(null)

  const content = useMemo(() => (selected && contentByPath.get(selected)) || '', [selected])
  const base = diskContent ?? content
  const value = draft ?? base

  if (paths.length === 0) {
    return <div className="p-3 text-sm text-zinc-500">No source mapping for this plugin.</div>
  }

  async function refreshFromDisk() {
    try {
      setStatus('loading…')
      const r = await fetch(`/api/dev/file?path=${encodeURIComponent(selected)}`)
      if (!r.ok) throw new Error(await r.text())
      const j = (await r.json()) as { content: string }
      setDiskContent(j.content)
      setDraft(j.content)
      setStatus('loaded')
    } catch {
      setDiskContent(null)
      setDraft(null)
      setStatus('using bundled copy (dev fs unavailable)')
    }
  }

  async function saveToDisk() {
    try {
      setStatus('saving…')
      setSaveError('')
      const r = await fetch('/api/dev/safe/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selected, content: value }),
      })
      if (!r.ok) {
        const t = await r.text()
        setSaveError(t)
        throw new Error(t)
      }
      setDiskContent(value)
      setDraft(value)
      setStatus('saved (validated + hmr)')
      await refreshGit()
      setDiffHistory((h) => [{ ts: Date.now(), path: selected, diff: gitDiff }, ...h].slice(0, 12))
    } catch (e: any) {
      setStatus(`save failed: ${String(e?.message ?? e)}`)
    }
  }

  async function refreshGit() {
    try {
      const r = await fetch(`/api/dev/git/status?path=${encodeURIComponent(selected)}`)
      if (!r.ok) throw new Error(await r.text())
      const j = (await r.json()) as { status: string; diff: string }
      setGitStatus(j.status)
      setGitDiff(j.diff)
    } catch {
      setGitStatus('git unavailable')
      setGitDiff('')
    }
  }

  async function commit() {
    try {
      setStatus('committing…')
      const r = await fetch('/api/dev/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg }),
      })
      if (!r.ok) throw new Error(await r.text())
      setStatus('committed')
      await refreshGit()
    } catch (e: any) {
      setStatus(`commit failed: ${String(e?.message ?? e)}`)
    }
  }

  useEffect(() => {
    void refreshFromDisk()
    void refreshGit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="text-xs text-zinc-500">file</div>
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value)
            setStatus('')
          }}
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-700"
        >
          {paths.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={refreshFromDisk}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
          title="Load current file from disk via Vite dev server"
        >
          Load
        </button>
        <button
          type="button"
          onClick={() => setDraft(base)}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
          title="Revert to last loaded/saved"
        >
          Revert
        </button>
        <button
          type="button"
          onClick={() => editorRef.current?.trigger?.('saw', 'undo', null)}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
          title="Undo"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => editorRef.current?.trigger?.('saw', 'redo', null)}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
          title="Redo"
        >
          Redo
        </button>
        <button
          type="button"
          onClick={saveToDisk}
          className="rounded-md bg-emerald-700 px-2 py-1.5 text-xs font-semibold text-zinc-50 hover:bg-emerald-600"
          title="Write file to disk via Vite dev server"
        >
          Save
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
        <Editor
          height="100%"
          defaultLanguage={langFor(selected)}
          theme="vs-dark"
          value={value || `// (not indexed) ${selected}`}
          onChange={(v) => setDraft(v ?? '')}
          onMount={(editor, monaco) => {
            editorRef.current = editor
            monacoRef.current = monaco
          }}
          options={{
            readOnly: false,
            fontSize: 12,
            minimap: { enabled: false },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-zinc-500">{status}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setGitOpen((v) => !v)}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
            title="Toggle git diff panel"
          >
            {gitOpen ? 'Hide Git' : 'Show Git'}
          </button>
          <button
            type="button"
            onClick={refreshGit}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
          >
            Git status/diff
          </button>
        </div>
      </div>

      {saveError && (
        <details className="rounded-md border border-rose-900/40 bg-rose-950/20 p-2">
          <summary className="cursor-pointer select-none text-[11px] font-semibold text-rose-200">
            Save error (click to expand)
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-rose-100">
            {saveError}
          </pre>
        </details>
      )}

      {gitOpen && (
        <div className="grid min-h-0 grid-cols-2 gap-2">
          <div className="min-h-0 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
            <div className="mb-1 text-[11px] font-semibold text-zinc-400">git status</div>
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-zinc-200">{gitStatus}</pre>
          </div>
          <div className="min-h-0 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
            <div className="mb-1 text-[11px] font-semibold text-zinc-400">git diff</div>
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-zinc-200">{gitDiff}</pre>
          </div>
        </div>
      )}

      <details className="rounded-md border border-zinc-800 bg-zinc-950/20 p-2">
        <summary className="cursor-pointer select-none text-[11px] font-semibold text-zinc-300">
          Unsaved diff (base vs draft)
        </summary>
        <div className="mt-2 h-40 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
          <DiffEditor
            height="100%"
            original={base}
            modified={value}
            theme="vs-dark"
            language={langFor(selected)}
            options={{ readOnly: true, minimap: { enabled: false }, renderSideBySide: true }}
          />
        </div>
      </details>

      <details className="rounded-md border border-zinc-800 bg-zinc-950/20 p-2">
        <summary className="cursor-pointer select-none text-[11px] font-semibold text-zinc-300">
          Recent saved diffs
        </summary>
        <div className="mt-2 space-y-2">
          {diffHistory.length === 0 ? (
            <div className="text-[11px] text-zinc-500">No history yet. Save to capture diffs.</div>
          ) : (
            diffHistory.map((h) => (
              <details key={`${h.ts}`} className="rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
                <summary className="cursor-pointer select-none text-[11px] text-zinc-400">
                  {new Date(h.ts).toLocaleTimeString()} • {h.path}
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-zinc-200">
                  {h.diff || '(no diff)'}
                </pre>
              </details>
            ))
          )}
        </div>
      </details>

      <div className="flex items-center gap-2">
        <input
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          placeholder="Commit message"
        />
        <button
          type="button"
          onClick={commit}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-zinc-50 hover:bg-emerald-600"
        >
          Commit
        </button>
      </div>
    </div>
  )
}


