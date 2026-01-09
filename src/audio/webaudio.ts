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

function _writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i) & 0xff)
}

/**
 * Encode an AudioBuffer to a PCM16 WAV Blob.
 * NOTE: intended for runtime upload to backend plugins.
 */
export function encodeWavFromAudioBuffer(input: AudioBuffer): Blob {
  const numChannels = input.numberOfChannels
  const sampleRate = input.sampleRate
  const length = input.length

  const interleaved = new Float32Array(length * numChannels)
  for (let ch = 0; ch < numChannels; ch++) {
    const data = input.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      interleaved[i * numChannels + ch] = data[i] ?? 0
    }
  }

  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = interleaved.length * bytesPerSample

  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)

  _writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  _writeAscii(view, 8, 'WAVE')
  _writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits per sample
  _writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let o = 44
  for (let i = 0; i < interleaved.length; i++) {
    const x = Math.max(-1, Math.min(1, interleaved[i] ?? 0))
    const s = x < 0 ? x * 0x8000 : x * 0x7fff
    view.setInt16(o, s, true)
    o += 2
  }

  return new Blob([buf], { type: 'audio/wav' })
}

export function audioBufferFromPcm(samples: number[][], sampleRate: number): AudioBuffer {
  const ctx = getAudioContext()
  const channels = Math.max(1, samples.length)
  const len = samples[0]?.length ?? 0
  const buf = ctx.createBuffer(channels, len, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    const arr = samples[ch] ?? []
    const fa = new Float32Array(len)
    for (let i = 0; i < len; i++) fa[i] = Number(arr[i] ?? 0)
    buf.copyToChannel(fa, ch)
  }
  return buf
}


