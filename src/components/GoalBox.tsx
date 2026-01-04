import { useState } from 'react'
import { Panel } from './ui/Panel'
import { useSawStore } from '../store/useSawStore'

export function GoalBox() {
  const [text, setText] = useState('')
  const submitGoal = useSawStore((s) => s.submitGoal)
  const aiBusy = useSawStore((s) => s.aiBusy)

  return (
    <div className="px-2 pt-2">
      <Panel title="Describe Analysis Goal" className="overflow-hidden">
        <form
          className="flex items-center gap-2 p-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!text.trim()) return
            await submitGoal(text.trim())
            setText('')
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='e.g. "Load CSV, normalize, run PCA, plot embedding"'
            disabled={aiBusy}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
          <button
            type="submit"
            disabled={aiBusy}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-zinc-50 hover:bg-emerald-600"
          >
            {aiBusy ? 'Generating…' : 'Generate'}
          </button>
        </form>
      </Panel>
    </div>
  )
}


