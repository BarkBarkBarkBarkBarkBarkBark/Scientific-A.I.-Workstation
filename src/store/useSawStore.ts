import { create } from 'zustand'
import type { SawState } from './storeTypes'
import { installHmrBridge } from './hmr'
import { installLocalStoragePersist } from './persist'

import { createConsoleSlice } from './slices/consoleSlice'
import { createLayoutSlice } from './slices/layoutSlice'
import { createPluginsSlice } from './slices/pluginsSlice'
import { createGraphSlice } from './slices/graphSlice'
import { createAiSlice } from './slices/aiSlice'
import { createChatSlice } from './slices/chatSlice'
import { createDevOpsSlice } from './slices/devOpsSlice'
import { createPatchReviewSlice } from './slices/patchReviewSlice'
import { createExecutionSlice } from './slices/executionSlice'
import { createAudioSlice } from './slices/audioSlice'
import { createA2uiDevSlice } from './slices/a2uiDevSlice'

const _useSawStore = create<SawState>((set, get) => ({
  ...createConsoleSlice(set),
  ...createLayoutSlice(set, get),
  ...createPluginsSlice(set, get),
  ...createGraphSlice(set, get),
  ...createAiSlice(set, get),
  ...createChatSlice(set, get),
  ...createDevOpsSlice(set, get),
  ...createA2uiDevSlice(set),
  ...createPatchReviewSlice(set, get),
  ...createExecutionSlice(set, get),
  ...createAudioSlice(set, get),
}))

export const useSawStore: typeof _useSawStore = installHmrBridge(_useSawStore as any) as any
installLocalStoragePersist(useSawStore as any)
