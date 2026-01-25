import { TopBar } from './components/TopBar'
import { PluginBrowser } from './components/PluginBrowser'
import { NodeCanvas } from './components/NodeCanvas'
import { Inspector } from './components/Inspector'
import { BottomPanel } from './components/BottomPanel'
import { GoalBox } from './components/GoalBox'
import { useEffect, useState } from 'react'
import { useSawStore } from './store/useSawStore'
import { ResizableDivider } from './components/ui/ResizableDivider'
import { PipelineBuilder } from './components/PipelineBuilder'
import { ModuleFullscreenModal } from './components/ModuleFullscreenModal'
import { ConsoleFullscreenModal } from './components/ConsoleFullscreenModal'
import { PatchReviewModal } from './components/PatchReviewModal'
import { Panel } from './components/ui/Panel'
import { ChatPanel } from './components/ChatPanel'

export function App() {
  const refreshAiStatus = useSawStore((s) => s.refreshAiStatus)
  const refreshWorkspacePlugins = useSawStore((s) => s.refreshWorkspacePlugins)
  const layout = useSawStore(
    (s) =>
      s.layout ?? {
        leftWidth: 280,
        leftWidthOpen: 280,
        leftCollapsed: false,
        rightWidth: 340,
        rightWidthOpen: 340,
        rightCollapsed: false,
        bottomHeight: 240,

        bottomChatWidth: 520,

        patchReviewFilesWidth: 320,
        pluginBuilderSettingsWidth: 420,
        moduleFullscreenLeftWidth: 760,
        moduleFullscreenDirTreeWidth: 280,
        todoEditorWidth: 520,
      },
  )
  const setLayout = useSawStore((s) => s.setLayout)
  const layoutMode = useSawStore((s) => s.layoutMode)
  const deleteSelectedNode = useSawStore((s) => s.deleteSelectedNode)
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight))
  const clearChat = useSawStore((s) => s.clearChat)
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1400 : window.innerWidth))

  useEffect(() => {
    void refreshAiStatus()
    void refreshWorkspacePlugins()
  }, [refreshAiStatus, refreshWorkspacePlugins])

  useEffect(() => {
    const onResize = () => setVh(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // Avoid interfering with text inputs
        const t = e.target as HTMLElement | null
        const tag = t?.tagName?.toLowerCase()
        const isTyping =
          tag === 'input' || tag === 'textarea' || (t as any)?.isContentEditable
        if (isTyping) return
        e.preventDefault()
        deleteSelectedNode()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteSelectedNode])

  return (
    <div className="h-full bg-zinc-950 font-ui text-zinc-100">
      <div className="flex h-full min-h-0">
        <div className="min-w-0 flex-1">
          {/*
            Max bottom height is basically "almost full screen".
            (Top bar + goal box + paddings leave ~160px.)
          */}
          <div className="grid h-full gap-0" style={{ gridTemplateRows: `48px auto 1fr 12px ${layout.bottomHeight}px` }}>
            <TopBar />
            <GoalBox />

            <div className="min-h-0 px-2 py-2">
              <div
                className="grid h-full min-h-0 gap-2"
                style={{
                  gridTemplateColumns: `${layout.leftWidth}px 12px 1fr 12px ${layout.rightWidth}px`,
                }}
              >
                <PluginBrowser />

                <div className="h-full">
                  <ResizableDivider
                    orientation="vertical"
                    value={layout.leftWidth}
                    setValue={(v) => setLayout({ leftWidth: v })}
                    min={layout.leftCollapsed ? 56 : 220}
                    max={layout.leftCollapsed ? 56 : 520}
                  />
                </div>

                {layoutMode === 'pipeline' ? <PipelineBuilder /> : <NodeCanvas />}

                <div className="h-full">
                  <ResizableDivider
                    orientation="vertical"
                    value={layout.rightWidth}
                    setValue={(v) => setLayout({ rightWidth: v })}
                    invert
                    min={layout.rightCollapsed ? 56 : 260}
                    max={layout.rightCollapsed ? 56 : 560}
                  />
                </div>

                <Inspector />
              </div>
            </div>

            <div className="mx-2">
              <ResizableDivider
                orientation="horizontal"
                value={layout.bottomHeight}
                setValue={(v) => setLayout({ bottomHeight: v })}
                invert
                min={160}
                max={Math.max(200, vh - 160)}
              />
            </div>

            <BottomPanel />
          </div>

          <ModuleFullscreenModal />
          <ConsoleFullscreenModal />
          <PatchReviewModal />
        </div>

        <div className="h-full w-[12px]">
          <ResizableDivider
            orientation="vertical"
            value={layout.bottomChatWidth}
            setValue={(v) => setLayout({ bottomChatWidth: v })}
            invert
            min={360}
            max={Math.max(420, vw - 720)}
          />
        </div>

        <div className="min-h-0" style={{ width: layout.bottomChatWidth }}>
          <Panel
            title="Chat"
            right={
              <button
                type="button"
                onClick={clearChat}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
                title="Clear chat messages"
              >
                Clear
              </button>
            }
            className="h-full overflow-hidden"
          >
            <div className="h-full min-h-0 overflow-hidden p-2">
              <div className="h-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/40">
                <ChatPanel />
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}


