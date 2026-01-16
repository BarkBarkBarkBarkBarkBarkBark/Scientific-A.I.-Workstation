import type { SawState } from '../storeTypes'
import { audioBufferFromPcm, decodeAudioFile, encodeWavFromAudioBuffer } from '../../audio/webaudio'

export function createAudioSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<SawState, 'loadMp3ToNode' | 'recomputeLowpass'> {
  return {
    loadMp3ToNode: async (nodeId: string, file: File) => {
      // Decode (real)
      try {
        const original = await decodeAudioFile(file)
        // Upload a WAV version for runtime execution
        let uploadedWavPath: string | null = null
        try {
          const wav = encodeWavFromAudioBuffer(original)
          const fd = new FormData()
          const base = file.name.replace(/\.[^.]+$/, '')
          fd.append('file', wav, `${base || 'audio'}.wav`)
          const r = await fetch('/api/saw/files/upload_audio_wav', { method: 'POST', body: fd })
          if (!r.ok) throw new Error(await r.text())
          const j = (await r.json()) as { ok: boolean; path: string }
          uploadedWavPath = String(j.path || '')
        } catch (e: any) {
          uploadedWavPath = null
          set((s) => ({ logs: [...s.logs, `[audio] upload failed: ${String(e?.message ?? e)}`] }))
        }

        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== nodeId) return n
            if (n.data.pluginId !== 'audio_lowpass') return n
            return {
              ...n,
              data: {
                ...n.data,
                runtime: {
                  ...n.data.runtime,
                  audio: {
                    ...(n.data.runtime?.audio ?? {
                      fileName: null,
                      original: null,
                      filtered: null,
                      lastError: null,
                    }),
                    fileName: file.name,
                    uploadedWavPath,
                    original,
                    lastError: null,
                  },
                },
              },
            }
          }),
          logs: [
            ...s.logs,
            `[audio] decoded "${file.name}"`,
            ...(uploadedWavPath ? [`[audio] uploaded wav: ${uploadedWavPath}`] : []),
          ],
        }))

        await get().recomputeLowpass(nodeId)
      } catch (e: any) {
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== nodeId) return n
            if (n.data.pluginId !== 'audio_lowpass') return n
            return {
              ...n,
              data: {
                ...n.data,
                runtime: {
                  ...n.data.runtime,
                  audio: {
                    ...(n.data.runtime?.audio ?? {
                      fileName: null,
                      original: null,
                      filtered: null,
                      lastError: null,
                    }),
                    lastError: String(e?.message ?? e),
                  },
                },
              },
            }
          }),
          bottomTab: 'errors',
          errors: [...s.errors, `AudioDecodeError: ${String(e?.message ?? e)}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'audio', text: `AudioDecodeError: ${String(e?.message ?? e)}` }],
        }))
      }
    },

    recomputeLowpass: async (nodeId: string) => {
      const node = get().nodes.find((n) => n.id === nodeId)
      if (!node || node.data.pluginId !== 'audio_lowpass') return
      const original = (node as any).data.runtime?.audio?.original ?? null
      if (!original) return
      const uploadedWavPath = (node as any).data.runtime?.audio?.uploadedWavPath ?? null
      if (!uploadedWavPath) return

      const cutoff = Number((node as any).data.params['cutoff_hz'] ?? 1200)
      try {
        const r = await fetch('/api/saw/plugins/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plugin_id: 'audio_lowpass',
            inputs: { wav_path: { data: uploadedWavPath, metadata: {} } },
            params: { cutoff_hz: cutoff },
          }),
        })
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as { ok: boolean; outputs: any; logs?: any[] }
        const audio = j?.outputs?.audio?.data
        const sr = Number(audio?.sample_rate_hz ?? original.sampleRate)
        const samples = (audio?.samples ?? []) as number[][]
        const filtered = audioBufferFromPcm(samples, sr)

        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== nodeId) return n
            if (n.data.pluginId !== 'audio_lowpass') return n
            return {
              ...n,
              data: {
                ...n.data,
                runtime: {
                  ...n.data.runtime,
                  audio: {
                    ...(n.data.runtime?.audio ?? {
                      fileName: null,
                      original: null,
                      filtered: null,
                      lastError: null,
                    }),
                    filtered,
                    lastError: null,
                  },
                },
              },
            }
          }),
          logs: [...s.logs, `[audio] rendered lowpass (runtime) @ ${Math.round(cutoff)} Hz`],
        }))
      } catch (e: any) {
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== nodeId) return n
            if (n.data.pluginId !== 'audio_lowpass') return n
            return {
              ...n,
              data: {
                ...n.data,
                runtime: {
                  ...n.data.runtime,
                  audio: {
                    ...(n.data.runtime?.audio ?? {
                      fileName: null,
                      original: null,
                      filtered: null,
                      lastError: null,
                    }),
                    lastError: String(e?.message ?? e),
                  },
                },
              },
            }
          }),
          bottomTab: 'errors',
          errors: [...s.errors, `AudioRuntimeError: ${String(e?.message ?? e)}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'audio', text: `AudioRuntimeError: ${String(e?.message ?? e)}` }],
        }))
      }
    },
  }
}
