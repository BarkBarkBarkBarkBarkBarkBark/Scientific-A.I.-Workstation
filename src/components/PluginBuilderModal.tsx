import Editor from '@monaco-editor/react'
import { useEffect, useMemo, useState } from 'react'
import { useSawStore } from '../store/useSawStore'
import { Panel } from './ui/Panel'
import { ResizableDivider } from './ui/ResizableDivider'

function sanitizePluginId(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  // allow: letters, digits, dot, dash, underscore
  const cleaned = s
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '')
  return cleaned
}

function yamlQuote(s: string): string {
  const v = String(s ?? '')
  // simplest safe quoting for our fields
  return JSON.stringify(v)
}

function normalizeText(text: string): string {
  let t = String(text ?? '').replaceAll('\r\n', '\n')
  if (!t.endsWith('\n')) t += '\n'
  return t
}

function newFilePatch(path: string, content: string): string {
  const p = String(path).replaceAll('\\', '/')
  const body = normalizeText(content)
  const lines = body.slice(0, -1).split('\n') // drop trailing newline
  const n = Math.max(1, lines.length)
  return [
    `diff --git a/${p} b/${p}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${p}`,
    `@@ -0,0 +1,${n} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n')
}

export function PluginBuilderModal(props: { open: boolean; onClose: () => void }) {
  const open = Boolean(props.open)
  const onClose = props.onClose

  const applyPatch = useSawStore((s) => s.applyPatch)
  const grantWriteCaps = useSawStore((s) => s.grantWriteCaps)
  const refreshWorkspacePlugins = useSawStore((s) => s.refreshWorkspacePlugins)
  const layout = useSawStore((s) => s.layout)
  const setLayout = useSawStore((s) => s.setLayout)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth))

  useEffect(() => {
    if (!open) return
    setVw(typeof window === 'undefined' ? 1200 : window.innerWidth)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
  }, [open, onClose])

  const [pluginIdRaw, setPluginIdRaw] = useState('zlab.sorting.kilosort')
  const pluginId = useMemo(() => sanitizePluginId(pluginIdRaw), [pluginIdRaw])
  const [name, setName] = useState('Kilosort (lab)')
  const [description, setDescription] = useState('Spike sorting wrapper (custom lab script).')
  const [categoryPath, setCategoryPath] = useState('workspace/zlab/sorting')
  const [pipRaw, setPipRaw] = useState<string>('numpy>=1.26\nscipy>=1.11')

  const [script, setScript] = useState<string>(
    [
      '"""',
      'Put your lab code here.',
      '',
      'Implement either:',
      '  - run(inputs: dict, params: dict, context) -> dict',
      'or',
      '  - main(inputs: dict, params: dict, context) -> dict',
      '',
      'Tips:',
      '- Read params like params["input_path"].',
      '- Write files to: os.path.join(os.environ["SAW_RUN_DIR"], "output", ...)',
      '"""',
      '',
      'from __future__ import annotations',
      '',
      'import os',
      'from typing import Any',
      '',
      '',
      'def run(inputs: dict, params: dict, context) -> dict:',
      '    input_path = str(params.get("input_path") or "")',
      '    file_type = str(params.get("file_type") or "")',
      '    context.log("info", "script:run", input_path=input_path, file_type=file_type)',
      '',
      '    # Example: write a small result artifact',
      '    run_dir = os.environ.get("SAW_RUN_DIR") or ""',
      '    out_dir = os.path.join(run_dir, "output") if run_dir else ""',
      '    if out_dir:',
      '        os.makedirs(out_dir, exist_ok=True)',
      '        with open(os.path.join(out_dir, "result.txt"), "w", encoding="utf-8") as f:',
      '            f.write(f"input_path={input_path}\\nfile_type={file_type}\\n")',
      '',
      '    return {',
      '        "result": {',
      '            "data": {"ok": True, "input_path": input_path, "file_type": file_type},',
      '            "metadata": {},',
      '        }',
      '    }',
      '',
    ].join('\n'),
  )

  const pipList = useMemo(() => {
    return pipRaw
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
  }, [pipRaw])

  const pluginDir = useMemo(() => {
    if (!pluginId) return ''
    // 1 folder per plugin id (dots are ok in folder names)
    return `saw-workspace/plugins/${pluginId}`
  }, [pluginId])

  const manifestPath = useMemo(() => (pluginDir ? `${pluginDir}/plugin.yaml` : ''), [pluginDir])
  const wrapperPath = useMemo(() => (pluginDir ? `${pluginDir}/wrapper.py` : ''), [pluginDir])
  const scriptPath = useMemo(() => (pluginDir ? `${pluginDir}/src/script.py` : ''), [pluginDir])
  const initPath = useMemo(() => (pluginDir ? `${pluginDir}/src/__init__.py` : ''), [pluginDir])

  const pluginYaml = useMemo(() => {
    const lines: string[] = []
    lines.push(`id: ${yamlQuote(pluginId || 'your.plugin.id')}`)
    lines.push(`name: ${yamlQuote(name || 'Your Plugin Name')}`)
    lines.push(`version: "0.1.0"`)
    lines.push(`description: ${yamlQuote(description || 'Short description.')}`)
    if (String(categoryPath || '').trim()) {
      lines.push(`category_path: ${yamlQuote(categoryPath.trim())}`)
    }
    lines.push('entrypoint:')
    lines.push('  file: "wrapper.py"')
    lines.push('  callable: "main"')
    lines.push('environment:')
    lines.push('  python: ">=3.11,<3.13"')
    lines.push('  pip:')
    if (pipList.length === 0) {
      lines.push('    - ""')
    } else {
      for (const dep of pipList) lines.push(`    - ${yamlQuote(dep)}`)
    }
    lines.push('inputs: {}')
    lines.push('params:')
    lines.push('  input_path:')
    lines.push('    type: "string"')
    lines.push('    default: ""')
    lines.push('    ui: { label: "Input path (relative to repo root)" }')
    lines.push('  file_type:')
    lines.push('    type: "string"')
    lines.push('    default: ""')
    lines.push('    ui: { label: "File type" }')
    lines.push('outputs:')
    lines.push('  result:')
    lines.push('    type: "object"')
    lines.push('execution:')
    lines.push('  deterministic: false')
    lines.push('  cacheable: false')
    lines.push('side_effects:')
    lines.push('  network: "none"')
    lines.push('  disk: "read_write"')
    lines.push('  subprocess: "forbidden"')
    lines.push('resources:')
    lines.push('  gpu: "optional"')
    lines.push('  threads: 2')
    lines.push('')
    return lines.join('\n')
  }, [categoryPath, description, name, pipList, pluginId])

  const wrapperPy = useMemo(() => {
    return [
      '"""SAW Workspace Plugin Wrapper (generated)',
      '',
      'This wrapper imports your code from `src/script.py`.',
      'Provide either `run(inputs, params, context)` or `main(inputs, params, context)` in that file.',
      '"""',
      '',
      'from __future__ import annotations',
      '',
      'import importlib',
      '',
      '',
      'def main(inputs: dict, params: dict, context) -> dict:',
      `    context.log("info", "plugin:start", plugin_id=${JSON.stringify(pluginId)})`,
      '    mod = importlib.import_module("src.script")',
      '    fn = getattr(mod, "run", None) or getattr(mod, "main", None)',
      '    if not callable(fn):',
      '        raise RuntimeError("src/script.py must define run(...) or main(...)")',
      '    return fn(inputs or {}, params or {}, context)',
      '',
    ].join('\n')
  }, [pluginId])

  const patch = useMemo(() => {
    if (!pluginDir) return ''
    return [
      newFilePatch(manifestPath, pluginYaml),
      newFilePatch(wrapperPath, wrapperPy),
      newFilePatch(initPath, ''),
      newFilePatch(scriptPath, script),
    ].join('\n')
  }, [initPath, manifestPath, pluginDir, pluginYaml, script, scriptPath, wrapperPath, wrapperPy])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-6">
      <div className="h-[86vh] w-[92vw] max-w-[1400px]">
        <Panel
          title="New Workspace Plugin (Python)"
          right={
            <div className="flex items-center gap-2">
              {status ? <div className="text-[11px] text-zinc-500">{status}</div> : null}
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
              >
                Close (Esc)
              </button>
            </div>
          }
          className="h-full overflow-hidden"
        >
          <div
            className="grid h-full min-h-0 gap-2 p-2"
            style={{ gridTemplateColumns: `${layout.pluginBuilderSettingsWidth}px 12px 1fr` }}
          >
            <Panel title="Settings" className="min-h-0 overflow-hidden">
              <div className="h-full overflow-auto p-3">
                <div className="space-y-3">
                  {error ? (
                    <div className="rounded-md border border-red-900/40 bg-red-950/30 p-2 text-[11px] text-red-200">
                      {error}
                    </div>
                  ) : null}

                  <div>
                    <div className="text-xs text-zinc-400">Plugin ID</div>
                    <input
                      value={pluginIdRaw}
                      onChange={(e) => setPluginIdRaw(e.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      placeholder="zlab.sorting.kilosort"
                    />
                    <div className="mt-1 text-[11px] text-zinc-500">folder: {pluginDir || '(invalid id)'}</div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs text-zinc-400">Name</div>
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      />
                    </div>
                    <div>
                      <div className="text-xs text-zinc-400">Category</div>
                      <input
                        value={categoryPath}
                        onChange={(e) => setCategoryPath(e.target.value)}
                        className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        placeholder="workspace/zlab/sorting"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-zinc-400">Description</div>
                    <input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                  </div>

                  <div>
                    <div className="text-xs text-zinc-400">pip dependencies (one per line)</div>
                    <textarea
                      value={pipRaw}
                      onChange={(e) => setPipRaw(e.target.value)}
                      className="mt-1 h-24 w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-[12px] text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      placeholder={'numpy>=1.26\nscipy>=1.11'}
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!pluginDir || busy}
                      onClick={async () => {
                        if (!pluginDir) return
                        setBusy(true)
                        setError('')
                        setStatus('creating…')
                        try {
                          // Allow writes under this plugin folder
                          const capPath = pluginDir.endsWith('/') ? pluginDir : pluginDir + '/'
                          const caps = await grantWriteCaps(capPath)
                          if (!caps.ok) throw new Error(caps.error ?? 'caps_failed')

                          const r = await applyPatch(patch)
                          if (!r.ok) throw new Error(r.error ?? 'apply_patch_failed')

                          setStatus('created; refreshing plugins…')
                          await refreshWorkspacePlugins()
                          setStatus('done')
                          onClose()
                        } catch (e: any) {
                          setError(String(e?.message ?? e))
                          setStatus('failed')
                        } finally {
                          setBusy(false)
                        }
                      }}
                      className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
                      title="Create plugin under saw-workspace/plugins/"
                    >
                      {busy ? 'Creating…' : 'Create plugin'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setScript(
                          [
                            'from __future__ import annotations',
                            '',
                            'def run(inputs: dict, params: dict, context) -> dict:',
                            '    context.log("info", "hello", params=params)',
                            '    return {"result": {"data": {"hello": True}, "metadata": {}}}',
                            '',
                          ].join('\n'),
                        )
                      }}
                      className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
                    >
                      Reset script
                    </button>
                  </div>
                </div>
              </div>
            </Panel>

            <div className="rounded-md border border-zinc-800 bg-zinc-950/40">
              <ResizableDivider
                orientation="vertical"
                value={layout.pluginBuilderSettingsWidth}
                setValue={(v) => setLayout({ pluginBuilderSettingsWidth: v })}
                min={300}
                max={Math.max(380, vw - 560)}
              />
            </div>

            <Panel title="src/script.py" className="min-h-0 overflow-hidden">
              <div className="h-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
                <Editor
                  height="100%"
                  defaultLanguage="python"
                  theme="vs-dark"
                  value={script}
                  onChange={(v) => setScript(String(v ?? ''))}
                  options={{
                    readOnly: false,
                    fontSize: 12,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                  }}
                />
              </div>
            </Panel>
          </div>
        </Panel>
      </div>
    </div>
  )
}


