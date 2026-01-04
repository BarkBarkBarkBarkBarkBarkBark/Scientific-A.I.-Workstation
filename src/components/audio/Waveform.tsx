import { useEffect, useMemo, useRef, useState } from 'react'

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  color: string,
  view: { zoom: number; offset: number },
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1))
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = Math.max(1, Math.floor(w * dpr))
  canvas.height = Math.max(1, Math.floor(h * dpr))
  ctx.scale(dpr, dpr)

  ctx.clearRect(0, 0, w, h)

  ctx.fillStyle = '#09090b'
  ctx.fillRect(0, 0, w, h)

  const data = buffer.getChannelData(0)
  const zoom = clamp(view.zoom, 1, 40)
  const windowSamples = Math.max(1, Math.floor(data.length / zoom))
  const maxOffset = Math.max(0, 1 - windowSamples / data.length)
  const offset = clamp(view.offset, 0, maxOffset)
  const startSample = Math.floor(offset * data.length)
  const endSample = Math.min(data.length, startSample + windowSamples)
  const segment = data.subarray(startSample, endSample)

  const samplesPerPixel = Math.max(1, Math.floor(segment.length / w))

  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()

  const mid = h / 2
  for (let x = 0; x < w; x++) {
    const start = x * samplesPerPixel
    const end = Math.min(segment.length, start + samplesPerPixel)
    let min = 1
    let max = -1
    for (let i = start; i < end; i++) {
      const v = segment[i] ?? 0
      if (v < min) min = v
      if (v > max) max = v
    }
    const y1 = mid + min * mid
    const y2 = mid + max * mid
    ctx.moveTo(x + 0.5, y1)
    ctx.lineTo(x + 0.5, y2)
  }

  ctx.stroke()

  // border
  ctx.strokeStyle = '#27272a'
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
}

export function Waveform(props: {
  buffer: AudioBuffer | null
  color?: string
  label?: string
  height?: number
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const color = props.color ?? '#34d399'
  const height = props.height ?? 160
  const [zoom, setZoom] = useState(1)
  const drag = useRef<{ x: number; offset: number } | null>(null)

  const key = useMemo(() => {
    if (!props.buffer) return 'empty'
    return `${props.buffer.length}:${props.buffer.sampleRate}:${props.buffer.numberOfChannels}`
  }, [props.buffer])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    if (!props.buffer) {
      const ctx = canvas.getContext('2d')
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (ctx) {
        ctx.clearRect(0, 0, w, h)
        ctx.fillStyle = '#09090b'
        ctx.fillRect(0, 0, w, h)
      }
      return
    }

    const view = { zoom, offset: Number(canvas.dataset.offset ?? '0') }
    drawWaveform(canvas, props.buffer, color, view)
    const onResize = () => drawWaveform(canvas, props.buffer!, color, view)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [key, props.buffer, color, zoom])

  return (
    <div className="space-y-1">
      {props.label && (
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold text-zinc-400">{props.label}</div>
          <div className="text-[11px] text-zinc-500">zoom: {zoom.toFixed(1)}×</div>
        </div>
      )}
      <canvas
        ref={ref}
        className="w-full rounded-md"
        style={{ height }}
        data-offset="0"
        onWheel={(e) => {
          if (!props.buffer) return
          e.preventDefault()
          const next = clamp(zoom + (e.deltaY > 0 ? -0.5 : 0.5), 1, 40)
          setZoom(next)
        }}
        onPointerDown={(e) => {
          if (!props.buffer) return
          const canvas = e.currentTarget
          canvas.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, offset: Number(canvas.dataset.offset ?? '0') }
        }}
        onPointerMove={(e) => {
          if (!props.buffer) return
          if (!drag.current) return
          const canvas = e.currentTarget
          const d = e.clientX - drag.current.x
          const w = Math.max(1, canvas.clientWidth)
          const frac = d / w
          const bufLen = props.buffer.length
          const windowSamples = Math.max(1, Math.floor(bufLen / clamp(zoom, 1, 40)))
          const maxOffset = Math.max(0, 1 - windowSamples / bufLen)
          const next = clamp(drag.current.offset - frac / clamp(zoom, 1, 40), 0, maxOffset)
          canvas.dataset.offset = String(next)
          drawWaveform(canvas, props.buffer, color, { zoom, offset: next })
        }}
        onPointerUp={() => {
          drag.current = null
        }}
      />
    </div>
  )
}


