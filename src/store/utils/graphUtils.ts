import type { PluginNode } from '../../types/saw'

export function findFirstMatchingHandles(source: PluginNode, target: PluginNode) {
  const out = Object.entries(source.data.portTypes).filter(([hid]) => hid.startsWith('out:'))
  const inn = Object.entries(target.data.portTypes).filter(([hid]) => hid.startsWith('in:'))
  for (const [outH, outT] of out) {
    for (const [inH, inT] of inn) {
      if (outT === inT) return { sourceHandle: outH, targetHandle: inH, type: outT }
    }
  }
  return null
}
