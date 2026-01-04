import { useRef } from 'react'

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export function ResizableDivider(props: {
  orientation: 'vertical' | 'horizontal'
  value: number
  setValue: (v: number) => void
  min: number
  max: number
}) {
  const start = useRef<{ p: number; v: number } | null>(null)

  return (
    <div
      className={[
        'group flex items-stretch justify-stretch',
        props.orientation === 'vertical' ? 'cursor-col-resize' : 'cursor-row-resize',
      ].join(' ')}
      onPointerDown={(e) => {
        e.preventDefault()
        ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
        start.current = {
          p: props.orientation === 'vertical' ? e.clientX : e.clientY,
          v: props.value,
        }
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const pNow = props.orientation === 'vertical' ? e.clientX : e.clientY
        const delta = pNow - start.current.p
        const next = clamp(start.current.v + delta, props.min, props.max)
        props.setValue(next)
      }}
      onPointerUp={() => {
        start.current = null
      }}
    >
      <div
        className={[
          'w-full h-full',
          'bg-transparent',
          'group-hover:bg-emerald-700/20',
          'transition-colors',
        ].join(' ')}
      />
    </div>
  )
}


