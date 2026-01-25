import { z } from 'zod'

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

// NOTE: We intentionally use `unknown` here instead of a fully-recursive JSON-value schema.
// It keeps validation robust (no runtime recursion edge-cases) while still enforcing that
// these fields are objects/records when required.
const JsonValueSchema = z.unknown()

const GeneratedFromSchema = z
  .object({
    saw_api: z.string().min(1),
    patch_engine: z.string().min(1),
    vite_dev_server: z.string().min(1),
  })
  .strict()

const ServiceDefaultSchema = z
  .object({
    default_port: z.number().int().positive().optional(),
    default_url: z.string().min(1).optional(),
    env: z.string().min(1).optional(),
  })
  .strict()

const ServiceDefaultsSchema = z
  .object({
    frontend_vite: ServiceDefaultSchema,
    saw_api: ServiceDefaultSchema,
    patch_engine: ServiceDefaultSchema,
    copilot_cli: ServiceDefaultSchema,
  })
  .strict()

const ViteProxySchema = z
  .object({
    prefix: z.string().min(1),
    target_env: z.string().min(1),
    default_target: z.string().min(1),
    rewrite: z.string().min(1),
  })
  .strict()

const AgentChatQuerySchema = z
  .object({
    stream: z
      .object({
        type: z.literal('boolean'),
        default: z.boolean(),
      })
      .strict(),
    provider: z
      .object({
        type: z.literal('string'),
        enum: z.tuple([z.literal('copilot'), z.literal('openai')]),
        optional: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const AgentApproveBodySchema = z
  .object({
    conversation_id: z.string().min(1),
    tool_call_id: z.string().min(1),
    approved: z.boolean(),
  })
  .strict()

const DbInitMigrateSchema = z.object({}).passthrough()

const IngestIndexBodySchema = z
  .object({
    uri: z.string().min(1),
    doc_type: z.string().min(1),
    content_text: z.string(),
    metadata_json: z.record(JsonValueSchema),
  })
  .strict()

const EmbedUpsertBodySchema = z
  .object({
    uri: z.string().min(1),
    doc_type: z.string().min(1),
    content_text: z.string(),
    metadata_json: z.record(JsonValueSchema),
    model: z.string().min(1).nullable().optional(),
    chunk_max_chars: z.number().int().positive(),
    chunk_overlap_chars: z.number().int().nonnegative(),
  })
  .strict()

const SearchVectorBodySchema = z
  .object({
    query: z.string(),
    top_k: z.number().int().positive(),
    model: z.string().min(1).nullable().optional(),
  })
  .strict()

const AuditEventBodySchema = z
  .object({
    actor: z.string().min(1),
    event_type: z.string().min(1),
    details_json: z.record(JsonValueSchema),
  })
  .strict()

const PatchStoreProposalBodySchema = z
  .object({
    author: z.string().min(1),
    diff_unified: z.string().min(1),
    target_paths: z.array(z.string().min(1)),
    validation_status: z.enum(['pending', 'passed', 'failed']),
    validation_log: z.string(),
  })
  .strict()

const PatchMarkAppliedBodySchema = z
  .object({
    proposal_id: z.string().min(1),
    applied_commit: z.string().min(1),
    validation_status: z.enum(['pending', 'passed', 'failed']),
    validation_log: z.string(),
  })
  .strict()

const PluginsForkBodySchema = z
  .object({
    from_plugin_id: z.string().min(1),
    new_plugin_id: z.string().min(1),
    new_name: z.string().min(1).optional(),
  })
  .strict()

const PluginsCreateFromPythonBodySchema = z
  .object({
    plugin_id: z.string().min(1),
    name: z.string().min(1),
    python_code: z.string().min(1),
  })
  .strict()

const PluginsExecuteBodySchema = z
  .object({
    plugin_id: z.string().min(1),
    inputs: z.record(JsonValueSchema),
    params: z.record(JsonValueSchema),
  })
  .strict()

const QueryParamSchema = z
  .object({
    type: z.string().min(1),
    default: z.any().optional(),
    enum: z.array(z.any()).optional(),
    optional: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()

const EndpointSchema = z
  .object({
    method: HttpMethodSchema,
    path: z.string().min(1),
    browser_path: z.string().min(1).optional(),
    description: z.string().min(1),
    notes: z.array(z.string()).optional(),
    query: z.record(QueryParamSchema).optional(),
    body: z.record(JsonValueSchema).optional(),
  })
  .strict()

const ServiceSchema = z
  .object({
    id: z.string().min(1),
    base_url_env: z.string().min(1).optional(),
    default_base_url: z.string().min(1).optional(),
    base_url: z.string().min(1).optional(),
    browser_base: z.string().min(1).optional(),
    notes: z.array(z.string()).optional(),
    endpoints: z.array(EndpointSchema),
  })
  .strict()

const HealthPanelCheckSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal('http'),
    method: HttpMethodSchema,
    preferred_url: z.string().min(1),
    success_fields: z.array(z.string().min(1)).optional(),
    body_template: z.record(JsonValueSchema).optional(),
    notes: z.array(z.string()).optional(),
  })
  .strict()

export const ApiEndpointsDocSchema = z
  .object({
    version: z.literal(1),
    generated_from: GeneratedFromSchema,
    service_defaults: ServiceDefaultsSchema,
    vite_proxies: z.array(ViteProxySchema),
    services: z.array(ServiceSchema),
    health_panel_checks: z.array(HealthPanelCheckSchema),
  })
  .strict()

export type ApiEndpointsDoc = z.infer<typeof ApiEndpointsDocSchema>

export function validateApiEndpointsDoc(doc: unknown): {
  ok: true
  value: ApiEndpointsDoc
} | {
  ok: false
  error: z.ZodError
} {
  const parsed = ApiEndpointsDocSchema.safeParse(doc)
  if (!parsed.success) return { ok: false, error: parsed.error }
  return { ok: true, value: parsed.data }
}
