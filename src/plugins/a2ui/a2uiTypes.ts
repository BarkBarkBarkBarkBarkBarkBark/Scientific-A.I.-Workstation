import { z } from 'zod'

// A2UI (v0.1) is a declarative UI document.
// Security boundary: the host validates + interprets this; no arbitrary code.

export type A2uiPrimitive = string | number | boolean | null
export type A2uiExprArray = A2uiExpr[]
export type A2uiExprMap = { [key: string]: A2uiExpr }
export type A2uiOpExpr = { op: string; args?: A2uiExpr[]; a?: A2uiExpr; b?: A2uiExpr }

export type A2uiExpr = A2uiPrimitive | A2uiExprArray | A2uiExprMap | A2uiOpExpr

export const A2uiExprSchema: z.ZodType<A2uiExpr> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(A2uiExprSchema),
    z
      .object({
        op: z.string().min(1),
        args: z.array(A2uiExprSchema).optional(),
        a: A2uiExprSchema.optional(),
        b: A2uiExprSchema.optional(),
      })
      .passthrough(),
    z.record(A2uiExprSchema),
  ]) as any,
)

export type A2uiViewNode = {
  type: string
  props?: Record<string, A2uiExpr>
  children?: A2uiViewNode[]
  text?: A2uiExpr
}

export const A2uiViewNodeSchema: z.ZodType<A2uiViewNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    props: z.record(A2uiExprSchema).optional(),
    children: z.array(A2uiViewNodeSchema).optional(),
    text: A2uiExprSchema.optional(),
  }) as any,
)

export const A2uiDocumentSchema = z.object({
  a2ui_spec_version: z.literal('0.1'),
  kind: z.string().optional(),
  pluginId: z.string().optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  context: z.unknown().optional(),
  computed: z.record(A2uiExprSchema).optional(),
  lifecycle: z.unknown().optional(),
  queries: z.unknown().optional(),
  actions: z.unknown().optional(),
  view: A2uiViewNodeSchema,
})

export type A2uiDocument = z.infer<typeof A2uiDocumentSchema>

export function isProbablyA2uiDocument(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as any).a2ui_spec_version === '0.1' && (raw as any).view)
}
