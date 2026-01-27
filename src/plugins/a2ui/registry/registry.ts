import type { ReactNode } from 'react'
import type { A2uiViewNode } from '../a2uiTypes'
import type { A2uiRenderContext } from '../renderer/types'

export type A2uiComponentFactory = (args: {
  node: A2uiViewNode
  ctx: A2uiRenderContext
  children: ReactNode[]
}) => ReactNode

export type A2uiRegistry = Record<string, A2uiComponentFactory>

export function getRegistryComponent(registry: A2uiRegistry, type: string): A2uiComponentFactory | null {
  return registry[type] ?? null
}
