export type A2uiFeatureFlags = {
  forceLegacyUi: boolean
  allowLegacyUi: boolean
}

// Minimal feature flags for the A2UI migration.
// In dev, these can be toggled via localStorage:
//   localStorage.setItem('SAW_FORCE_LEGACY_UI', '1')
//   localStorage.setItem('SAW_ALLOW_LEGACY_UI', '1')
export function getA2uiFeatureFlags(): A2uiFeatureFlags {
  if (typeof window === 'undefined') return { forceLegacyUi: false, allowLegacyUi: true }

  const allowLegacyUi = (window.localStorage.getItem('SAW_ALLOW_LEGACY_UI') ?? '1') === '1'
  const forceLegacyUi = (window.localStorage.getItem('SAW_FORCE_LEGACY_UI') ?? '0') === '1'
  return { allowLegacyUi, forceLegacyUi }
}
