import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'
import { DeveloperPanel } from './DeveloperPanel'
import { ChatPanel } from './ChatPanel'

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

export function BottomPanel() {
  const tab = useSawStore((s) => s.bottomTab)
  const setTab = useSawStore((s) => s.setBottomTab)
  const logs = useSawStore((s) => s.logs)
  const errors = useSawStore((s) => s.errors)
  const ai = useSawStore((s) => s.aiMessages)
  const openConsoleFullscreen = useSawStore((s) => s.openConsoleFullscreen)

  const content = tab === 'logs' ? logs : tab === 'errors' ? errors : ai

  return (
    <div className="px-2 pb-2">
      <Panel
        title="Console"
        right={
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
            <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>
              Chat
            </TabButton>
            <TabButton active={tab === 'dev'} onClick={() => setTab('dev')}>
              Dev
            </TabButton>
            <button
              type="button"
              onClick={openConsoleFullscreen}
              className="ml-2 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900"
              title="Fullscreen console"
            >
              Fullscreen
            </button>
          </div>
        }
        className="h-full overflow-hidden"
      >
        {tab === 'dev' ? (
          <div className="h-full p-2">
            <DeveloperPanel />
          </div>
        ) : tab === 'chat' ? (
          <ChatPanel />
        ) : (
          <div className="h-full overflow-auto p-3">
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-zinc-200">
              {content.join('\n')}
            </pre>
          </div>
        )}
      </Panel>
    </div>
  )
}


