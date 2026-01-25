import { useEffect } from 'react'
import { useSawStore } from '../store/useSawStore'
import { Panel } from './ui/Panel'
import { DeveloperPanel } from './DeveloperPanel'
import { TodoPanel } from './TodoPanel'

function TabButton(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={[
        'rounded-md px-3 py-1.5 text-xs font-semibold transition',
        props.active
          ? 'bg-zinc-800 text-zinc-100'
          : 'bg-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
      ].join(' ')}
    >
      {props.children}
    </button>
  )
}

export function ConsoleFullscreenModal() {
  const open = useSawStore((s) => s.consoleFullscreen)
  const close = useSawStore((s) => s.closeConsoleFullscreen)
  const tab = useSawStore((s) => s.bottomTab)
  const setTab = useSawStore((s) => s.setBottomTab)
  const logs = useSawStore((s) => s.logs)
  const errors = useSawStore((s) => s.errors)
  const ai = useSawStore((s) => s.aiMessages)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  if (!open) return null

  const content = tab === 'logs' ? logs : tab === 'errors' ? errors : ai

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 p-4">
      <Panel
        title="Console (Fullscreen)"
        right={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <TabButton active={tab === 'logs'} onClick={() => setTab('logs')}>
                Logs
              </TabButton>
              <TabButton active={tab === 'errors'} onClick={() => setTab('errors')}>
                Errors
              </TabButton>
              <TabButton active={tab === 'ai'} onClick={() => setTab('ai')}>
                AI Suggestions
              </TabButton>
              <TabButton active={tab === 'todo'} onClick={() => setTab('todo')}>
                Todo
              </TabButton>
              <TabButton active={tab === 'dev'} onClick={() => setTab('dev')}>
                Dev
              </TabButton>
            </div>
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
            >
              Close (Esc)
            </button>
          </div>
        }
        className="h-full overflow-hidden"
      >
        <div className="h-full min-h-0 p-2">
          {tab === 'dev' ? (
            <div className="h-full p-0">
              <DeveloperPanel />
            </div>
          ) : tab === 'todo' ? (
            <TodoPanel />
          ) : (
            <div className="h-full overflow-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
              <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-zinc-200">
                {content.join('\n')}
              </pre>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}


