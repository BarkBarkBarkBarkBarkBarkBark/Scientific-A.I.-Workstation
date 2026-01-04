import Editor from '@monaco-editor/react'
import { useMemo } from 'react'
import { useSawStore } from '../store/useSawStore'
import { Panel } from './ui/Panel'

export function CodeEditorModal() {
  const editor = useSawStore((s) => s.editor)
  const closeEditor = useSawStore((s) => s.closeEditor)
  const node = useSawStore((s) => s.nodes.find((n) => n.id === editor.nodeId) ?? null)
  const updateNodeCode = useSawStore((s) => s.updateNodeCode)

  const title = useMemo(() => {
    if (!node) return 'Code Editor'
    return `Code Editor — ${node.data.title}`
  }, [node])

  if (!editor.open || !node) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="h-[80vh] w-[90vw] max-w-[1400px]">
        <Panel
          title={title}
          right={
            <button
              type="button"
              onClick={closeEditor}
              className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
            >
              Close
            </button>
          }
          className="h-full overflow-hidden"
        >
          <div className="grid h-full grid-cols-[1.25fr,0.75fr] gap-2 p-2">
            <div className="min-h-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
              <Editor
                height="100%"
                defaultLanguage="python"
                theme="vs-dark"
                value={node.data.code}
                onChange={(v) => updateNodeCode(node.id, v ?? '')}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                }}
              />
            </div>

            <div className="min-h-0 space-y-2">
              <Panel title="Mock Git Diff" className="h-[55%] overflow-hidden">
                <div className="h-full overflow-auto p-3">
                  <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-zinc-200">
                    {node.data.git.diff}
                  </pre>
                </div>
              </Panel>

              <Panel title="Commit Preview" className="h-[45%] overflow-hidden">
                <div className="h-full overflow-auto p-3">
                  <div className="text-xs text-zinc-500">Message</div>
                  <div className="mt-1 rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[12px] text-zinc-200">
                    {node.data.git.commitMessage}
                  </div>
                  <div className="mt-3 text-xs text-zinc-500">
                    (TODO: wire real git status/diff/commit when backend exists.)
                  </div>
                </div>
              </Panel>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}


