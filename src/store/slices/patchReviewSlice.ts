import type { SawState } from '../storeTypes'
import { parsePatchProposalFromAssistant } from '../../patching/parsePatchProposal'

export function createPatchReviewSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<SawState, 'patchReview' | 'openPatchReviewFromMessage' | 'closePatchReview' | 'applyPatchProposal'> {
  return {
    patchReview: { open: false, busy: false, proposal: null, lastError: '' },

    openPatchReviewFromMessage: (assistantText: string) => {
      const parsed = parsePatchProposalFromAssistant(String(assistantText ?? ''))
      if (!parsed.ok) {
        set((s) => ({ patchReview: { ...s.patchReview, lastError: `PatchProposal parse failed: ${parsed.error}` } }))
        return
      }
      set({ patchReview: { open: true, busy: false, proposal: parsed.proposal, lastError: '' }, bottomTab: 'logs' })
    },

    closePatchReview: () => set({ patchReview: { open: false, busy: false, proposal: null, lastError: '' } }),

    applyPatchProposal: async (opts?: { commit?: boolean; commitMessage?: string }) => {
      const pr = get().patchReview
      const proposal = pr.proposal
      if (!proposal) return { ok: false, error: 'missing_proposal' }

      const patch = proposal.files
        .map((f) => String((f as any).diff ?? '').trim())
        .filter(Boolean)
        .map((d) => (d.endsWith('\n') ? d : d + '\n'))
        .join('\n')

      set((s) => ({ patchReview: { ...s.patchReview, busy: true, lastError: '' } }))
      const r = await get().applyPatch(patch)
      if (!r.ok) {
        set((s) => ({ patchReview: { ...s.patchReview, busy: false, lastError: r.error ?? 'apply_failed' } }))
        return r
      }

      if (opts?.commit) {
        const msg = String(opts?.commitMessage ?? `SAW: ${(proposal as any).summary || 'apply patch'}`).trim() || 'SAW: apply patch'
        const cr = await get().commitAll(msg)
        if (!cr.ok) {
          set((s) => ({ patchReview: { ...s.patchReview, busy: false, lastError: cr.error ?? 'commit_failed' } }))
          return cr
        }
      }

      set((s) => ({ patchReview: { ...s.patchReview, busy: false, open: false, proposal: null, lastError: '' } }))
      return { ok: true }
    },
  }
}
