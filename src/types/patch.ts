export type PatchRisk = 'low' | 'medium' | 'high'

export type PatchScopeDomain = 'workspace' | 'shell_app'

export type PatchScope = {
  domain: PatchScopeDomain
  editable_mode_required: boolean
  allowlist_paths?: string[]
}

export type PatchFile = {
  path: string
  diff: string
  base_hash?: string
}

export type PatchProposal = {
  id: string
  summary: string
  rationale: string
  scope: PatchScope
  files: PatchFile[]
  validation_steps: string[]
  risk: PatchRisk
}


