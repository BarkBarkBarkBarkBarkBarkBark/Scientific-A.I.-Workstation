# IDE: Left Sidebar (Plugins ↔ Files)

## What shipped
- The left sidebar now supports two modes: **Plugins** and **Files**.
- Use the **Files** button in the Plugin Browser header to switch to a repo file explorer.
- Use the **Plugins** button in the Files header to switch back.
- The Files panel reads via Patch Engine runtime endpoints (`/api/dev/tree`, `/api/dev/file`) and shows a small read-only preview.

## Safety / scope
- This browser is **read-only** and uses the Patch Engine safe path resolution.
- Default root is the repo root (`root='.'`). It does **not** attempt to browse arbitrary OS paths by default.

## State
- The selected left sidebar mode is persisted in localStorage as `leftSidebarTab`.

## Key files
- Frontend:
  - `src/components/LeftSidebar.tsx`
  - `src/components/FileBrowser.tsx`
  - `src/components/PluginBrowser.tsx` (adds mode switch button)
- Store:
  - `src/store/storeTypes.ts` (`LeftSidebarTab`)
  - `src/store/slices/layoutSlice.ts` (state + setter)
  - `src/store/persist.ts` (persist `leftSidebarTab`)
