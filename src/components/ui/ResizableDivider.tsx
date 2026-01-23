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
  invert?: boolean
}) {
  const start = useRef<{ p: number; v: number } | null>(null)

  const isVertical = props.orientation === 'vertical'

  const begin = (p: number) => {
    start.current = { p, v: props.value }
  }

  const move = (pNow: number) => {
    if (!start.current) return
    const delta = pNow - start.current.p
    const signedDelta = props.invert ? -delta : delta
    const next = clamp(start.current.v + signedDelta, props.min, props.max)
    props.setValue(next)
  }

  const end = () => {
    start.current = null
  }

  return (
    <div
      className={[
        'group relative select-none touch-none',
        isVertical ? 'cursor-col-resize' : 'cursor-row-resize',
        'w-full h-full',
      ].join(' ')}
      onPointerDown={(e) => {
        e.preventDefault()
        ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
        begin(isVertical ? e.clientX : e.clientY)
      }}
      onPointerMove={(e) => {
        move(isVertical ? e.clientX : e.clientY)
      }}
      onPointerUp={() => {
        end()
      }}
      onPointerCancel={() => {
        end()
      }}
      // Mouse fallback (helps on some Safari builds where PointerEvents can be inconsistent)
      onMouseDown={(e) => {
        // If PointerEvents is working, onPointerDown will already have run.
        if (start.current) return
        e.preventDefault()
        begin(isVertical ? e.clientX : e.clientY)

        const onMove = (ev: MouseEvent) => move(isVertical ? ev.clientX : ev.clientY)
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          end()
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }}
    >
      {/* Large hit area with a centered 1px line (VS Code-ish) */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={[
            'transition-colors',
            'bg-zinc-800/60',
            'group-hover:bg-emerald-700/35',
            isVertical ? 'h-full w-px' : 'h-px w-full',
          ].join(' ')}
        />
      </div>
    </div>
  )
}


