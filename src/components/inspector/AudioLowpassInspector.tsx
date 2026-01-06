import { useMemo, useState } from 'react'
import { useSawStore } from '../../store/useSawStore'
import { Waveform } from '../audio/Waveform'
import { playBuffer } from '../../audio/webaudio'

export function AudioLowpassInspector(props: { nodeId: string }) {
  const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) ?? null)
  const loadMp3ToNode = useSawStore((s) => s.loadMp3ToNode)
  const updateNodeParam = useSawStore((s) => s.updateNodeParam)
  const pluginCatalog = useSawStore((s) => s.pluginCatalog)

  const [stopper, setStopper] = useState<null | (() => void)>(null)

  const plugin = useMemo(
    () => (node ? pluginCatalog.find((p) => p.id === node.data.pluginId) ?? null : null),
    [node, pluginCatalog],
  )
  if (!node || !plugin) return null

  const audio = node.data.runtime?.audio
  const cutoff = Number(node.data.params['cutoff_hz'] ?? 1200)

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="text-xs font-semibold tracking-wide text-zinc-200">MP3 File</div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <input
            type="file"
            accept="audio/mpeg"
            className="block w-full text-xs text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-zinc-100 hover:file:bg-zinc-700"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              await loadMp3ToNode(node.id, f)
              e.currentTarget.value = ''
            }}
          />
        </div>
        <div className="mt-2 text-[11px] text-zinc-500">
          loaded: <span className="font-mono text-zinc-300">{audio?.fileName ?? '—'}</span>
        </div>
        {audio?.lastError && (
          <div className="mt-2 rounded-md border border-rose-900/40 bg-rose-950/30 p-2 text-[11px] text-rose-200">
            {audio.lastError}
          </div>
        )}
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold tracking-wide text-zinc-200">Lowpass Cutoff</div>
          <div className="font-mono text-xs text-zinc-300">{Math.round(cutoff)} Hz</div>
        </div>
        <input
          type="range"
          min={40}
          max={20000}
          value={cutoff}
          onChange={(e) => updateNodeParam(node.id, 'cutoff_hz', Number(e.target.value))}
          className="mt-2 w-full accent-emerald-500"
        />
        <div className="mt-1 flex justify-between text-[11px] text-zinc-600">
          <span>40</span>
          <span>20k</span>
        </div>
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold tracking-wide text-zinc-200">Waveforms</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
              disabled={!audio?.original}
              onClick={() => {
                if (!audio?.original) return
                stopper?.()
                setStopper(() => playBuffer(audio.original!))
              }}
            >
              Play Original
            </button>
            <button
              type="button"
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
              disabled={!audio?.filtered}
              onClick={() => {
                if (!audio?.filtered) return
                stopper?.()
                setStopper(() => playBuffer(audio.filtered!))
              }}
            >
              Play Filtered
            </button>
            <button
              type="button"
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
              disabled={!stopper}
              onClick={() => {
                stopper?.()
                setStopper(null)
              }}
            >
              Stop
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-3">
          <Waveform buffer={audio?.original ?? null} color="#60a5fa" label="Original" height={160} />
          <Waveform buffer={audio?.filtered ?? null} color="#34d399" label="Filtered" height={160} />
        </div>
      </div>
    </div>
  )
}


