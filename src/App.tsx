import { TopBar } from './components/TopBar'
import { PluginBrowser } from './components/PluginBrowser'
import { NodeCanvas } from './components/NodeCanvas'
import { Inspector } from './components/Inspector'
import { BottomPanel } from './components/BottomPanel'
import { GoalBox } from './components/GoalBox'
import { CodeEditorModal } from './components/CodeEditorModal'
import { useEffect, useState } from 'react'
import { useSawStore } from './store/useSawStore'
import { ResizableDivider } from './components/ui/ResizableDivider'
import { PipelineBuilder } from './components/PipelineBuilder'
import { ModuleFullscreenModal } from './components/ModuleFullscreenModal'
import { ConsoleFullscreenModal } from './components/ConsoleFullscreenModal'
import { PatchReviewModal } from './components/PatchReviewModal'

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
      },
  )
  const setLayout = useSawStore((s) => s.setLayout)
  const layoutMode = useSawStore((s) => s.layoutMode)
  const deleteSelectedNode = useSawStore((s) => s.deleteSelectedNode)
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight))

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
      {/*
        Max bottom height is basically "almost full screen".
        (Top bar + goal box + paddings leave ~160px.)
      */}
      {/**/}
      <div
        className="grid h-full gap-0"
        style={{ gridTemplateRows: `48px auto 1fr 10px ${layout.bottomHeight}px` }}
      >
        <TopBar />
        <GoalBox />

        <div className="min-h-0 px-2 py-2">
          <div
            className="grid h-full min-h-0 gap-2"
            style={{
              gridTemplateColumns: `${layout.leftWidth}px 6px 1fr 6px ${layout.rightWidth}px`,
            }}
          >
            <PluginBrowser />

            <div className="rounded-md border border-zinc-800 bg-zinc-950/40">
              <ResizableDivider
                orientation="vertical"
                value={layout.leftWidth}
                setValue={(v) => setLayout({ leftWidth: v })}
                min={layout.leftCollapsed ? 56 : 220}
                max={layout.leftCollapsed ? 56 : 520}
              />
            </div>

            {layoutMode === 'pipeline' ? <PipelineBuilder /> : <NodeCanvas />}

            <div className="rounded-md border border-zinc-800 bg-zinc-950/40">
              <ResizableDivider
                orientation="vertical"
                value={layout.rightWidth}
                setValue={(v) => setLayout({ rightWidth: v })}
                min={layout.rightCollapsed ? 56 : 260}
                max={layout.rightCollapsed ? 56 : 560}
              />
            </div>

            <Inspector />
          </div>
        </div>

        <div className="mx-2 rounded-md border border-zinc-800 bg-zinc-950/60">
          <ResizableDivider
            orientation="horizontal"
            value={layout.bottomHeight}
            setValue={(v) => setLayout({ bottomHeight: v })}
            min={160}
            max={Math.max(200, vh - 160)}
          />
        </div>

        <BottomPanel />
      </div>

      <CodeEditorModal />
      <ModuleFullscreenModal />
      <ConsoleFullscreenModal />
      <PatchReviewModal />
    </div>
  )
}


