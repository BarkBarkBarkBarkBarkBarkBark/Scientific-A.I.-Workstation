import type { SawState } from '../storeTypes'

export function createLayoutSlice(set: any, get: any): Pick<
  SawState,
  | 'bottomTab'
  | 'layoutMode'
  | 'leftSidebarTab'
  | 'layout'
  | 'consoleFullscreen'
  | 'setBottomTab'
  | 'setLeftSidebarTab'
  | 'setLayoutMode'
  | 'setLayout'
  | 'toggleLeftSidebar'
  | 'toggleRightSidebar'
  | 'openConsoleFullscreen'
  | 'closeConsoleFullscreen'
> {
  return {
    bottomTab: 'logs',
    layoutMode: 'pipeline',
    leftSidebarTab: 'plugins',
    layout: {
      leftWidth: 280,
      leftWidthOpen: 280,
      leftCollapsed: false,
      rightWidth: 340,
      rightWidthOpen: 340,
      rightCollapsed: false,
      bottomHeight: 240,

      bottomChatWidth: 520,

      patchReviewFilesWidth: 320,
      pluginBuilderSettingsWidth: 420,
      moduleFullscreenLeftWidth: 760,
      moduleFullscreenDirTreeWidth: 280,
      todoEditorWidth: 520,
    },
    consoleFullscreen: false,

    setBottomTab: (bottomTab) => set({ bottomTab }),
    setLeftSidebarTab: (leftSidebarTab) => set({ leftSidebarTab }),
    setLayoutMode: (layoutMode) => set({ layoutMode }),
    setLayout: (patch) => set((s: SawState) => ({ layout: { ...s.layout, ...patch } })),

    toggleLeftSidebar: () => {
      set((s: SawState) => {
        if (s.layout.leftCollapsed) {
          return {
            layout: {
              ...s.layout,
              leftCollapsed: false,
              leftWidth: s.layout.leftWidthOpen || 280,
            },
          }
        }
        return {
          layout: {
            ...s.layout,
            leftCollapsed: true,
            leftWidthOpen: s.layout.leftWidth,
            leftWidth: 56,
          },
        }
      })
    },

    toggleRightSidebar: () => {
      set((s: SawState) => {
        if (s.layout.rightCollapsed) {
          return {
            layout: {
              ...s.layout,
              rightCollapsed: false,
              rightWidth: s.layout.rightWidthOpen || 340,
            },
          }
        }
        return {
          layout: {
            ...s.layout,
            rightCollapsed: true,
            rightWidthOpen: s.layout.rightWidth,
            rightWidth: 56,
          },
        }
      })
    },

    openConsoleFullscreen: () => set({ consoleFullscreen: true }),
    closeConsoleFullscreen: () => set({ consoleFullscreen: false }),
  }
}
