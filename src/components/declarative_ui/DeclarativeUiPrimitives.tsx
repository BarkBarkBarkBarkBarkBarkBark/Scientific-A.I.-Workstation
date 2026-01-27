import type { ReactNode } from 'react'
import { Panel as BasePanel } from '../ui/Panel'

type Gap = 'xs' | 'sm' | 'md' | 'lg'

function gapClass(gap: Gap | undefined): string {
  switch (gap) {
    case 'xs':
      return 'space-y-1'
    case 'sm':
      return 'space-y-2'
    case 'lg':
      return 'space-y-5'
    case 'md':
    default:
      return 'space-y-3'
  }
}

export function DeclarativeUiStack(props: { gap?: Gap; children?: ReactNode }) {
  return <div className={gapClass(props.gap)}>{props.children}</div>
}

export function DeclarativeUiRow(props: {
  justify?: 'start' | 'spaceBetween' | 'end'
  align?: 'start' | 'center' | 'end'
  children?: ReactNode
}) {
  const justify = props.justify === 'spaceBetween' ? 'justify-between' : props.justify === 'end' ? 'justify-end' : 'justify-start'
  const align = props.align === 'center' ? 'items-center' : props.align === 'end' ? 'items-end' : 'items-start'
  return <div className={['flex gap-2', justify, align].join(' ')}>{props.children}</div>
}

export function DeclarativeUiGrid(props: { columns?: number; gap?: Gap; children?: ReactNode }) {
  const cols = Math.max(1, Math.min(6, Math.round(props.columns ?? 1)))
  const gap = props.gap ?? 'sm'
  const gapCls = gap === 'xs' ? 'gap-1.5' : gap === 'sm' ? 'gap-2' : gap === 'lg' ? 'gap-5' : 'gap-3'
  const colsCls =
    cols === 1
      ? 'grid-cols-1'
      : cols === 2
        ? 'grid-cols-2'
        : cols === 3
          ? 'grid-cols-3'
          : cols === 4
            ? 'grid-cols-4'
            : cols === 5
              ? 'grid-cols-5'
              : 'grid-cols-6'
  return <div className={['grid', colsCls, gapCls].join(' ')}>{props.children}</div>
}

export function DeclarativeUiText(props: { variant?: 'body' | 'muted' | 'title' | 'subtitle'; children?: ReactNode }) {
  const cls =
    props.variant === 'title'
      ? 'text-base font-semibold text-zinc-100'
      : props.variant === 'subtitle'
        ? 'text-xs text-zinc-400'
        : props.variant === 'muted'
          ? 'text-xs text-zinc-500'
          : 'text-sm text-zinc-200'
  return <div className={cls}>{props.children}</div>
}

export function DeclarativeUiPanel(props: {
  title?: string
  variant?: 'default' | 'moduleHeader'
  collapsible?: boolean
  defaultOpen?: boolean
  children?: ReactNode
}) {
  const content = (
    <BasePanel
      title={props.variant === 'moduleHeader' ? undefined : props.title}
      className={props.variant === 'moduleHeader' ? 'border-zinc-800 bg-zinc-950/40' : undefined}
    >
      <div className="p-3">{props.children}</div>
    </BasePanel>
  )

  if (!props.collapsible) return content

  return (
    <details className="group" open={props.defaultOpen ?? false}>
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
          <div className="text-xs font-semibold tracking-wide text-zinc-200">{props.title ?? 'Details'}</div>
          <div className="text-[11px] text-zinc-500 group-open:hidden">show</div>
          <div className="text-[11px] text-zinc-500 hidden group-open:block">hide</div>
        </div>
      </summary>
      <div className="mt-2">{content}</div>
    </details>
  )
}

export function DeclarativeUiBadge(props: { kind?: 'neutral' | 'warn' | 'good' | 'bad'; children?: ReactNode }) {
  const cls =
    props.kind === 'warn'
      ? 'border-amber-700/50 bg-amber-900/20 text-amber-200'
      : props.kind === 'good'
        ? 'border-emerald-700/50 bg-emerald-900/20 text-emerald-200'
        : props.kind === 'bad'
          ? 'border-red-700/50 bg-red-900/20 text-red-200'
          : 'border-zinc-700 bg-zinc-950/40 text-zinc-200'
  return <span className={['inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold', cls].join(' ')}>{props.children}</span>
}

export function DeclarativeUiButton(props: { label: string; variant?: 'primary' | 'secondary'; disabled?: boolean; onClick?: () => void }) {
  const base = 'rounded-md px-3 py-2 text-xs font-semibold transition'
  const cls =
    props.variant === 'primary'
      ? 'border border-emerald-700/60 bg-emerald-900/20 text-emerald-100 hover:bg-emerald-900/30'
      : 'border border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-900'

  return (
    <button
      type="button"
      disabled={Boolean(props.disabled)}
      onClick={props.disabled ? undefined : props.onClick}
      className={[base, cls, props.disabled ? 'opacity-50 cursor-not-allowed' : ''].join(' ')}
    >
      {props.label}
    </button>
  )
}

export function DeclarativeUiTextField(props: {
  label: string
  placeholder?: string
  value: string
  onChange?: (v: string) => void
  monospace?: boolean
}) {
  return (
    <label className="block space-y-1">
      <div className="text-[11px] font-semibold text-zinc-300">{props.label}</div>
      <input
        className={[
          'w-full rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600',
          props.monospace ? 'font-mono text-xs' : '',
        ].join(' ')}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    </label>
  )
}

export function DeclarativeUiToolbar(props: { columns?: number; gap?: Gap; children?: ReactNode }) {
  return (
    <DeclarativeUiGrid columns={props.columns ?? 2} gap={props.gap ?? 'sm'}>
      {props.children}
    </DeclarativeUiGrid>
  )
}

export function DeclarativeUiProgressSteps(props: { steps: { label: string; done: boolean }[] }) {
  return (
    <div className="space-y-1">
      {props.steps.map((s, idx) => (
        <div key={idx} className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/30 px-2 py-1">
          <div className="text-xs text-zinc-200">{s.label}</div>
          <div className={['text-[11px] font-semibold', s.done ? 'text-emerald-200' : 'text-zinc-500'].join(' ')}>
            {s.done ? 'done' : '—'}
          </div>
        </div>
      ))}
    </div>
  )
}

export function DeclarativeUiInlineError(props: { visible?: boolean; message?: string }) {
  if (!props.visible) return null
  const msg = (props.message ?? '').trim()
  if (!msg) return null
  return <div className="rounded-md border border-red-700/40 bg-red-900/15 px-3 py-2 text-[11px] text-red-200">{msg}</div>
}

export function DeclarativeUiCodeBlock(props: { language?: string; value: string }) {
  return (
    <pre className="overflow-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-200">
      <code>{props.value}</code>
    </pre>
  )
}

export function DeclarativeUiList(props: { items: string[] }) {
  const items = Array.isArray(props.items) ? props.items.filter((s) => String(s ?? '').trim()) : []
  if (items.length === 0) {
    return <div className="text-xs text-zinc-500">—</div>
  }

  return (
    <ul className="space-y-1">
      {items.map((it, idx) => (
        <li
          key={idx}
          className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/30 px-2 py-1"
        >
          <div className="mt-[6px] h-1.5 w-1.5 flex-none rounded-full bg-zinc-500" />
          <div className="min-w-0 text-sm text-zinc-200">{it}</div>
        </li>
      ))}
    </ul>
  )
}
