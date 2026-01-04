import { useMemo, useState } from 'react'
import { useSawStore } from '../store/useSawStore'

export function ChatPanel() {
  const [text, setText] = useState('')
  const messages = useSawStore((s) => s.chat.messages)
  const busy = useSawStore((s) => s.chatBusy)
  const sendChat = useSawStore((s) => s.sendChat)

  const view = useMemo(() => {
    return messages.filter((m) => m.role !== 'system')
  }, [messages])

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="space-y-2">
          {view.map((m, i) => (
            <div
              key={i}
              className={[
                'rounded-md border p-2 text-sm',
                m.role === 'user'
                  ? 'border-zinc-800 bg-zinc-950/40 text-zinc-100'
                  : 'border-emerald-900/40 bg-emerald-950/20 text-zinc-100',
              ].join(' ')}
            >
              <div className="mb-1 text-[11px] font-semibold text-zinc-500">
                {m.role === 'user' ? 'You' : 'SAW'}
              </div>
              <div className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</div>
            </div>
          ))}
          {busy && (
            <div className="text-xs text-zinc-500">Thinking…</div>
          )}
        </div>
      </div>

      <form
        className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/40 p-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const msg = text.trim()
          if (!msg) return
          setText('')
          await sendChat(msg)
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask SAW… (e.g. ‘How do I connect audio_lowpass to plot?’)"
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  )
}


