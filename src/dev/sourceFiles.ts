import App from '../App.tsx?raw'
import Main from '../main.tsx?raw'
import Store from '../store/useSawStore.ts?raw'
import Plugins from '../mock/plugins.ts?raw'
import AiMock from '../mock/ai.ts?raw'
import AiClient from '../ai/client.ts?raw'
import NodeCanvas from '../components/NodeCanvas.tsx?raw'
import PluginNode from '../components/nodes/PluginNode.tsx?raw'
import Inspector from '../components/Inspector.tsx?raw'
import BottomPanel from '../components/BottomPanel.tsx?raw'
import CodeEditorModal from '../components/CodeEditorModal.tsx?raw'
import TopBar from '../components/TopBar.tsx?raw'

export type SourceFile = { path: string; content: string }

export const sourceFiles: SourceFile[] = [
  { path: 'src/App.tsx', content: App },
  { path: 'src/main.tsx', content: Main },
  { path: 'src/store/useSawStore.ts', content: Store },
  { path: 'src/mock/plugins.ts', content: Plugins },
  { path: 'src/mock/ai.ts', content: AiMock },
  { path: 'src/ai/client.ts', content: AiClient },
  { path: 'src/components/TopBar.tsx', content: TopBar },
  { path: 'src/components/NodeCanvas.tsx', content: NodeCanvas },
  { path: 'src/components/nodes/PluginNode.tsx', content: PluginNode },
  { path: 'src/components/Inspector.tsx', content: Inspector },
  { path: 'src/components/BottomPanel.tsx', content: BottomPanel },
  { path: 'src/components/CodeEditorModal.tsx', content: CodeEditorModal },
]


