import { useSawStore } from '../store/useSawStore'
import { FileBrowser } from './FileBrowser'
import { PluginBrowser } from './PluginBrowser'

export function LeftSidebar() {
  const leftSidebarTab = useSawStore((s) => s.leftSidebarTab)

  if (leftSidebarTab === 'files') return <FileBrowser />
  return <PluginBrowser />
}
