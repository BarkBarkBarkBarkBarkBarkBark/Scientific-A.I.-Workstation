import * as React from 'react'
import type { DeclarativeUiRegistry } from './registry'
import {
  DeclarativeUiBadge,
  DeclarativeUiButton,
  DeclarativeUiCodeBlock,
  DeclarativeUiGrid,
  DeclarativeUiInlineError,
  DeclarativeUiList,
  DeclarativeUiPanel,
  DeclarativeUiProgressSteps,
  DeclarativeUiRow,
  DeclarativeUiStack,
  DeclarativeUiText,
  DeclarativeUiTextField,
  DeclarativeUiToolbar,
} from '../../../components/declarative_ui/DeclarativeUiPrimitives'
import { NodeInputs } from '../../../components/inspector/NodeInputs'
import { NodeParameters } from '../../../components/inspector/NodeParameters'
import { NodeRunPanel } from '../../../components/inspector/NodeRunPanel'

function asString(v: any): string {
  if (v == null) return ''
  return String(v)
}

function asBool(v: any): boolean {
  return Boolean(v)
}

function asNum(v: any, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function createDefaultDeclarativeUiRegistry(): DeclarativeUiRegistry {
  return {
    Stack: ({ node, children, ctx }) => (
      <DeclarativeUiStack gap={node.props?.gap ? (asString(ctx.eval(node.props.gap as any)) as any) : undefined}>
        {children}
      </DeclarativeUiStack>
    ),

    Row: ({ node, children, ctx }) => (
      <DeclarativeUiRow
        justify={node.props?.justify ? (asString(ctx.eval(node.props.justify as any)) as any) : undefined}
        align={node.props?.align ? (asString(ctx.eval(node.props.align as any)) as any) : undefined}
      >
        {children}
      </DeclarativeUiRow>
    ),

    Grid: ({ node, children, ctx }) => (
      <DeclarativeUiGrid columns={asNum(ctx.eval(node.props?.columns as any), 1)} gap={asString(node.props?.gap) as any}>
        {children}
      </DeclarativeUiGrid>
    ),

    Panel: ({ node, children, ctx }) => (
      <DeclarativeUiPanel
        title={node.props?.title ? asString(ctx.eval(node.props.title as any)) : undefined}
        variant={node.props?.variant ? (asString(ctx.eval(node.props.variant as any)) as any) : undefined}
        collapsible={node.props?.collapsible ? asBool(ctx.eval(node.props.collapsible as any)) : undefined}
        defaultOpen={node.props?.defaultOpen ? asBool(ctx.eval(node.props.defaultOpen as any)) : undefined}
      >
        {children}
      </DeclarativeUiPanel>
    ),

    Toolbar: ({ node, children, ctx }) => (
      <DeclarativeUiToolbar
        columns={asNum(node.props?.columns ? ctx.eval(node.props.columns as any) : 2, 2)}
        gap={asString(node.props?.gap ? ctx.eval(node.props.gap as any) : 'sm') as any}
      >
        {children}
      </DeclarativeUiToolbar>
    ),

    Text: ({ node, ctx }) => {
      const text = node.text != null ? asString(ctx.eval(node.text as any)) : ''
      const variant = node.props?.variant ? (asString(ctx.eval(node.props.variant as any)) as any) : undefined
      return <DeclarativeUiText variant={variant}>{text}</DeclarativeUiText>
    },

    Badge: ({ node, ctx }) => {
      const kind = node.props?.kind ? (asString(ctx.eval(node.props.kind as any)) as any) : undefined
      const text = node.text != null ? asString(ctx.eval(node.text as any)) : ''
      return <DeclarativeUiBadge kind={kind}>{text}</DeclarativeUiBadge>
    },

    Button: ({ node, ctx }) => {
      const label = asString(ctx.eval(node.props?.label as any))
      const variant = node.props?.variant ? (asString(ctx.eval(node.props.variant as any)) as any) : undefined
      const disabled = node.props?.disabled ? asBool(ctx.eval(node.props.disabled as any)) : false
      const onClick = node.props?.onClick ? (ctx.eval(node.props.onClick as any) as any) : null

      return (
        <DeclarativeUiButton
          label={label}
          variant={variant}
          disabled={disabled}
          onClick={() => {
            if (!onClick || typeof onClick !== 'object') return
            const action = asString(onClick.action ?? '')
            if (!action) return
            ctx.dispatch({ action, event: onClick.event })
          }}
        />
      )
    },

    TextField: ({ node, ctx }) => {
      const label = asString(ctx.eval(node.props?.label as any))
      const placeholder = node.props?.placeholder ? asString(ctx.eval(node.props.placeholder as any)) : undefined
      const value = asString(ctx.eval(node.props?.value as any))
      const onChange = node.props?.onChange ? (ctx.eval(node.props.onChange as any) as any) : null

      return (
        <DeclarativeUiTextField
          label={label}
          placeholder={placeholder}
          value={value}
          onChange={(v) => {
            if (!onChange || typeof onChange !== 'object') return
            const action = asString(onChange.action ?? '')
            if (!action) return
            ctx.dispatch({ action, event: { ...(onChange.event ?? {}), value: v } })
          }}
        />
      )
    },

    PathField: ({ node, ctx }) => {
      const label = asString(ctx.eval(node.props?.label as any))
      const placeholder = node.props?.placeholder ? asString(ctx.eval(node.props.placeholder as any)) : undefined
      const value = asString(ctx.eval(node.props?.value as any))
      const onChange = node.props?.onChange ? (ctx.eval(node.props.onChange as any) as any) : null

      return (
        <DeclarativeUiTextField
          label={label}
          placeholder={placeholder}
          value={value}
          monospace
          onChange={(v) => {
            if (!onChange || typeof onChange !== 'object') return
            const action = asString(onChange.action ?? '')
            if (!action) return
            ctx.dispatch({ action, event: { ...(onChange.event ?? {}), value: v } })
          }}
        />
      )
    },

    ProgressSteps: ({ node, ctx }) => {
      const stepsRaw = node.props?.steps ? (ctx.eval(node.props.steps as any) as any) : []
      const steps = Array.isArray(stepsRaw)
        ? stepsRaw
            .map((s) => {
              if (!s || typeof s !== 'object') return null
              return { label: asString(s.label ?? ''), done: Boolean(s.done) }
            })
            .filter(Boolean)
        : []

      return <DeclarativeUiProgressSteps steps={steps as any} />
    },

    InlineError: ({ node, ctx }) => (
      <DeclarativeUiInlineError
        visible={node.props?.visible ? asBool(ctx.eval(node.props.visible as any)) : false}
        message={node.props?.message ? asString(ctx.eval(node.props.message as any)) : ''}
      />
    ),

    CodeBlock: ({ node, ctx }) => {
      const value = asString(ctx.eval(node.props?.value as any))
      return (
        <DeclarativeUiCodeBlock
          language={node.props?.language ? asString(ctx.eval(node.props.language as any)) : undefined}
          value={value}
        />
      )
    },

    List: ({ node, ctx }) => {
      const raw = node.props?.items ? (ctx.eval(node.props.items as any) as any) : []
      const items = Array.isArray(raw) ? raw.map((x) => asString(x)).filter((s) => s.trim()) : []
      return <DeclarativeUiList items={items} />
    },

    // Builtins (temporary bridge)
    NodeInputs: ({ ctx }) => <NodeInputs nodeId={ctx.nodeId} />,
    NodeParameters: ({ ctx }) => <NodeParameters nodeId={ctx.nodeId} />,
    NodeRunPanel: ({ ctx }) => <NodeRunPanel nodeId={ctx.nodeId} />,
  }
}
