import type { ReactNode } from 'react'
import type { DeclarativeUiViewNode } from '../declarativeUiTypes'
import type { DeclarativeUiRenderContext } from '../renderer/types'

export type DeclarativeUiComponentFactory = (args: {
  node: DeclarativeUiViewNode
  ctx: DeclarativeUiRenderContext
  children: ReactNode[]
}) => ReactNode

export type DeclarativeUiRegistry = Record<string, DeclarativeUiComponentFactory>

export function getRegistryComponent(registry: DeclarativeUiRegistry, type: string): DeclarativeUiComponentFactory | null {
  return registry[type] ?? null
}
