let sharedCtx: AudioContext | null = null

export function getAudioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext()
  return sharedCtx
}

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const ab = await file.arrayBuffer()
  const ctx = getAudioContext()
  // Copy is safer across browsers
  const buf = ab.slice(0)
  return await ctx.decodeAudioData(buf)
}

export async function renderLowpass(params: {
  input: AudioBuffer
  cutoffHz: number
}): Promise<AudioBuffer> {
  const input = params.input
  const cutoffHz = Math.max(20, Math.min(20000, params.cutoffHz))

  const offline = new OfflineAudioContext(
    input.numberOfChannels,
    input.length,
    input.sampleRate,
  )

  const src = offline.createBufferSource()
  src.buffer = input

  const filter = offline.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = cutoffHz
  filter.Q.value = 0.707

  src.connect(filter)
  filter.connect(offline.destination)
  src.start(0)

  return await offline.startRendering()
}

export function playBuffer(buffer: AudioBuffer) {
  const ctx = getAudioContext()
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start(0)
  return () => {
    try {
      src.stop()
    } catch {
      // ignore
    }
  }
}


