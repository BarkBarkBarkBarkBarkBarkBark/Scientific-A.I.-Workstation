import Editor from '@monaco-editor/react'
import { useMemo, useState } from 'react'
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
  const [draft, setDraft] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [commitMsg, setCommitMsg] = useState<string>('WIP: update module source (via SAW)')
  const [gitStatus, setGitStatus] = useState<string>('')
  const [gitDiff, setGitDiff] = useState<string>('')

  const content = useMemo(() => (selected && contentByPath.get(selected)) || '', [selected])
  const value = draft ?? content

  if (paths.length === 0) {
    return <div className="p-3 text-sm text-zinc-500">No source mapping for this plugin.</div>
  }

  async function refreshFromDisk() {
    try {
      setStatus('loading…')
      const r = await fetch(`/api/dev/file?path=${encodeURIComponent(selected)}`)
      if (!r.ok) throw new Error(await r.text())
      const j = (await r.json()) as { content: string }
      setDraft(j.content)
      setStatus('loaded')
    } catch {
      setStatus('using bundled copy (dev fs unavailable)')
    }
  }

  async function saveToDisk() {
    try {
      setStatus('saving…')
      const r = await fetch('/api/dev/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selected, content: value }),
      })
      if (!r.ok) throw new Error(await r.text())
      setStatus('saved (vite reload)')
    } catch (e: any) {
      setStatus(`save failed: ${String(e?.message ?? e)}`)
    }
  }

  async function refreshGit() {
    try {
      const r = await fetch('/api/dev/git/status')
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="text-xs text-zinc-500">file</div>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
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
            onClick={refreshGit}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
          >
            Git status/diff
          </button>
        </div>
      </div>

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


