import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import type { ErrorObject, ValidateFunction } from 'ajv'

import schema from '../../saw-workspace/machine-context/introspection/IntrospectionPacket_v1_1.schema.json'

let _validate: ValidateFunction | null = null
let _initError: string | null = null

export type ValidationResult =
  | { ok: true; value: any }
  | { ok: false; error: string; errors?: unknown }

export function validateIntrospectionPacket(value: unknown): ValidationResult {
  if (!_validate && !_initError) {
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false })
      addFormats(ajv)
      _validate = ajv.compile(schema as any) as any
    } catch (e: any) {
      _initError = String(e?.message ?? e)
    }
  }

  if (_initError) {
    return { ok: false, error: `Validator init failed: ${_initError}` }
  }

  const validate = _validate!
  const ok = validate(value)
  if (ok) return { ok: true, value }

  const errs: ErrorObject[] = (validate.errors ?? []) as ErrorObject[]
  const brief = errs
    .slice(0, 6)
    .map((e: ErrorObject) => `${e.instancePath || '(root)'} ${e.message || ''}`.trim())
    .join('\n')

  return {
    ok: false,
    error: brief || 'Schema validation failed',
    errors: errs,
  }
}
