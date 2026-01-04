import type { CodeIndex, GitPreview, PluginDefinition } from '../types/saw'

export function makeMockCode(plugin: PluginDefinition): string {
  const fnName = plugin.id
  const inArgs =
    plugin.inputs.length === 0 ? '' : plugin.inputs.map((p) => `${p.id}: "${p.type}"`).join(', ')
  const outType = plugin.outputs[0]?.type ?? 'Any'

  return `# ${plugin.name} v${plugin.version}
# NOTE: frontend-only mock; execution hooks will be wired later.

from typing import Any

def ${fnName}(${inArgs}${inArgs ? ', ' : ''}params: dict[str, Any]) -> "${outType}":
    """
    ${plugin.description}
    """
    # TODO(runtime): validate inputs
    # TODO(runtime): run plugin code
    # TODO(runtime): emit structured logs + metrics
    return None  # type: ignore
`
}

export function makeMockCodeIndex(plugin: PluginDefinition): CodeIndex {
  return {
    classes: [
      {
        name: `${plugin.name.replace(/\s+/g, '')}Plugin`,
        methods: ['__init__', 'validate', 'run'],
        attributes: ['version', 'params', 'inputs', 'outputs'],
      },
    ],
    functions: [
      {
        name: plugin.id,
        signature: `def ${plugin.id}(…, params: dict[str, Any]) -> "${plugin.outputs[0]?.type ?? 'Any'}"`,
      },
    ],
  }
}

export function makeMockGitPreview(code: string): GitPreview {
  const base = code
  const current = code
  const diff = `diff --git a/plugin.py b/plugin.py
index 0000000..1111111 100644
--- a/plugin.py
+++ b/plugin.py
@@ -1,6 +1,9 @@
 # NOTE: this is a mocked diff preview.
+# TODO: wire real diffs when filesystem/git exists.
 
 def plugin(...):
     pass
`
  return {
    base,
    current,
    diff,
    commitMessage: 'WIP: refine plugin parameters + add validation (mock)',
  }
}


