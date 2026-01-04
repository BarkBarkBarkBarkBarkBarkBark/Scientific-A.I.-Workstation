import type { ReactNode } from 'react'

export function Panel(props: {
  title?: string
  right?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={[
        'rounded-lg border border-zinc-800 bg-zinc-900/30 backdrop-blur-sm',
        props.className ?? '',
      ].join(' ')}
    >
      {(props.title || props.right) && (
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div className="text-xs font-semibold tracking-wide text-zinc-200">{props.title}</div>
          <div className="text-xs text-zinc-400">{props.right}</div>
        </div>
      )}
      <div className="min-h-0">{props.children}</div>
    </div>
  )
}


