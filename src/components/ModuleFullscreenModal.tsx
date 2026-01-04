import Editor from '@monaco-editor/react'
import { useEffect, useMemo } from 'react'
import { getPlugin } from '../mock/plugins'
import { useSawStore } from '../store/useSawStore'
import { Panel } from './ui/Panel'
import { AudioLowpassInspector } from './inspector/AudioLowpassInspector'

export function ModuleFullscreenModal() {
  const fullscreen = useSawStore((s) => s.fullscreen)
  const closeFullscreen = useSawStore((s) => s.closeFullscreen)
  const editableMode = useSawStore((s) => s.editableMode)
  const updateNodeCode = useSawStore((s) => s.updateNodeCode)

  const node = useSawStore((s) => s.nodes.find((n) => n.id === fullscreen.nodeId) ?? null)
  const plugin = useMemo(() => (node ? getPlugin(node.data.pluginId) : null), [node])

  useEffect(() => {
    if (!fullscreen.open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen.open, closeFullscreen])

  if (!fullscreen.open || !node || !plugin) return null

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 p-4">
      <div className="h-full w-full">
        <Panel
          title={`Fullscreen — ${plugin.name}`}
          right={
            <div className="flex items-center gap-2">
              <div className="text-[11px] text-zinc-500">
                {editableMode ? 'Editable Mode: ON' : 'Editable Mode: OFF'}
              </div>
              <button
                type="button"
                onClick={closeFullscreen}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
              >
                Close (Esc)
              </button>
            </div>
          }
          className="h-full overflow-hidden"
        >
          <div className="grid h-full grid-cols-[1.1fr,0.9fr] gap-2 p-2">
            <Panel title="Module" className="min-h-0 overflow-hidden">
              <div className="h-full overflow-auto p-3">
                {plugin.id === 'audio_lowpass' ? (
                  <AudioLowpassInspector nodeId={node.id} />
                ) : (
                  <div className="space-y-2">
                    <div className="text-sm text-zinc-200">{plugin.description}</div>
                    <div className="text-xs text-zinc-500">(TODO: module-specific UI goes here.)</div>
                  </div>
                )}
              </div>
            </Panel>

            <Panel title="Code" className="min-h-0 overflow-hidden">
              <div className="h-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
                <Editor
                  height="100%"
                  defaultLanguage="python"
                  theme="vs-dark"
                  value={node.data.code}
                  onChange={(v) => {
                    if (!editableMode) return
                    updateNodeCode(node.id, v ?? '')
                  }}
                  options={{
                    readOnly: !editableMode,
                    fontSize: 13,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                  }}
                />
              </div>
            </Panel>
          </div>
        </Panel>
      </div>
    </div>
  )
}


