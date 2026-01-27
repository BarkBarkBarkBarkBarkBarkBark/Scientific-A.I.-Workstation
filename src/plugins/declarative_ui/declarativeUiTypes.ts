import { z } from 'zod'

// Declarative UI (v0.1) is a declarative UI document.
// Security boundary: the host validates + interprets this; no arbitrary code.

export type DeclarativeUiPrimitive = string | number | boolean | null
export type DeclarativeUiExprArray = DeclarativeUiExpr[]
export type DeclarativeUiExprMap = { [key: string]: DeclarativeUiExpr }
export type DeclarativeUiOpExpr = { op: string; args?: DeclarativeUiExpr[]; a?: DeclarativeUiExpr; b?: DeclarativeUiExpr }

export type DeclarativeUiExpr = DeclarativeUiPrimitive | DeclarativeUiExprArray | DeclarativeUiExprMap | DeclarativeUiOpExpr

export const DeclarativeUiExprSchema: z.ZodType<DeclarativeUiExpr> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(DeclarativeUiExprSchema),
    z
      .object({
        op: z.string().min(1),
        args: z.array(DeclarativeUiExprSchema).optional(),
        a: DeclarativeUiExprSchema.optional(),
        b: DeclarativeUiExprSchema.optional(),
      })
      .passthrough(),
    z.record(DeclarativeUiExprSchema),
  ]) as any,
)

export type DeclarativeUiViewNode = {
  type: string
  props?: Record<string, DeclarativeUiExpr>
  children?: DeclarativeUiViewNode[]
  text?: DeclarativeUiExpr
}

export const DeclarativeUiViewNodeSchema: z.ZodType<DeclarativeUiViewNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    props: z.record(DeclarativeUiExprSchema).optional(),
    children: z.array(DeclarativeUiViewNodeSchema).optional(),
    text: DeclarativeUiExprSchema.optional(),
  }) as any,
)

export const DeclarativeUiDocumentSchema = z.object({
  declarative_ui_spec_version: z.literal('0.1'),
  kind: z.string().optional(),
  pluginId: z.string().optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  context: z.unknown().optional(),
  computed: z.record(DeclarativeUiExprSchema).optional(),
  lifecycle: z.unknown().optional(),
  queries: z.unknown().optional(),
  actions: z.unknown().optional(),
  view: DeclarativeUiViewNodeSchema,
})

export type DeclarativeUiDocument = z.infer<typeof DeclarativeUiDocumentSchema>

export function isProbablyDeclarativeUiDocument(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as any).declarative_ui_spec_version === '0.1' && (raw as any).view)
}
