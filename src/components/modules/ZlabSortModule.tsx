import { useEffect, useMemo, useState } from 'react'
import { useSawStore } from '../../store/useSawStore'
import { fetchDevFile, fetchDevTree } from '../../dev/runtimeTree'

type StepStatus = {
  uploaded: boolean
  sorted: boolean
  analyzed: boolean
  curation: boolean
  uploadingPath?: string
  error?: string
}

async function existsNonEmptyDir(path: string): Promise<boolean> {
  try {
    const t = await fetchDevTree({ root: path, depth: 1 })
    return t.type === 'dir' && (t.children ?? []).length > 0
  } catch {
    return false
  }
}

async function hasAnyRhdFile(path: string): Promise<boolean> {
  try {
    const t = await fetchDevTree({ root: path, depth: 2 })
    if (t.type !== 'dir') return false

    const stack = [...(t.children ?? [])]
    while (stack.length) {
      const n = stack.pop()!
      if (n.type === 'file' && n.name.toLowerCase().endsWith('.rhd')) return true
      if (n.type === 'dir') stack.push(...(n.children ?? []))
    }
    return false
  } catch {
    return false
  }
}

async function existsFile(path: string): Promise<boolean> {
  try {
    await fetchDevFile(path)
    return true
  } catch {
    return false
  }
}

export function ZlabSortModule(props: { nodeId: string }) {
  const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) ?? null)
  const updateNodeParam = useSawStore((s) => s.updateNodeParam)
  const runPluginNode = useSawStore((s) => s.runPluginNode)

  const [status, setStatus] = useState<StepStatus>({ uploaded: false, sorted: false, analyzed: false, curation: false })

  const patient = String(node?.data.params?.patient ?? '').trim()
  const session = String(node?.data.params?.session ?? '').trim()
  const recordingPath = String(node?.data.params?.recording_path ?? '').trim()

  const pluginId = String(node?.data.pluginId ?? '')
  const artifactsRoot = useMemo(() => `saw-workspace/artifacts/${pluginId}`, [pluginId])
  const dataRoot = useMemo(() => `${artifactsRoot}/data`, [artifactsRoot])

  const rawSessionDir = useMemo(() => `${dataRoot}/raw/${patient}/${session}`, [dataRoot, patient, session])
  const sortedSessionDir = useMemo(() => `${dataRoot}/sorted/${patient}/${session}`, [dataRoot, patient, session])
  const sorterDir = useMemo(() => `${sortedSessionDir}/sorter_folder`, [sortedSessionDir])
  const analyzerDir = useMemo(() => `${sortedSessionDir}/analyzer_folder`, [sortedSessionDir])
  const curationDir = useMemo(() => `${analyzerDir}/spikeinterface_gui`, [analyzerDir])

  const patientOk = patient.length > 0
  const sessionOk = session.length > 0
  const recordingOk = recordingPath.length > 0
  const canUpload = patientOk && sessionOk && recordingOk

  useEffect(() => {
    if (!node) return
    if (!patientOk || !sessionOk) {
      setStatus((s) => ({ ...s, uploaded: false, sorted: false, analyzed: false, curation: false, error: undefined }))
      return
    }

    let cancelled = false
    void (async () => {
      const uploaded = await hasAnyRhdFile(rawSessionDir)
      // Patch Engine's /api/dev/tree returns an empty dir node when the path
      // doesn't exist, so we treat "done" as "non-empty" for derived outputs.
      const sorted = await existsNonEmptyDir(sorterDir)
      const analyzed = await existsNonEmptyDir(analyzerDir)
      const curation = await existsFile(`${curationDir}/curation_data.json`)

      if (cancelled) return
      setStatus((s) => ({ ...s, uploaded, sorted, analyzed, curation, error: undefined }))
    })().catch((e) => {
      if (cancelled) return
      setStatus((s) => ({ ...s, error: String((e as any)?.message ?? e) }))
    })

    return () => {
      cancelled = true
    }
  }, [node, patientOk, sessionOk, rawSessionDir, sorterDir, analyzerDir, curationDir])

  if (!node) return null

  const running = node.data.status === 'running'
  const lastRun = node.data.runtime?.exec?.last ?? null

  const setParam = (key: string, value: string) => updateNodeParam(props.nodeId, key, value)

  const runStep = async (step: 'upload' | 'sort' | 'analyze' | 'gui') => {
    // For sort/analyze/gui we intentionally clear recording_path so the wrapper reads
    // the uploaded file under artifacts/data/raw.
    if (step !== 'upload') {
      setParam('recording_path', '')
    }
    setParam('step', step)
    await runPluginNode(props.nodeId)
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="text-xs font-semibold tracking-wide text-zinc-200">Inputs</div>
        <div className="grid gap-2">
          <label className="grid gap-1">
            <div className="text-[11px] text-zinc-500">Patient</div>
            <input
              value={patient}
              onChange={(e) => setParam('patient', e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
              placeholder="e.g. Intan_RHD_2000"
            />
          </label>
          <label className="grid gap-1">
            <div className="text-[11px] text-zinc-500">Session</div>
            <input
              value={session}
              onChange={(e) => setParam('session', e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
              placeholder="e.g. session_1"
            />
          </label>
          <label className="grid gap-1">
            <div className="text-[11px] text-zinc-500">Recording path</div>
            <input
              value={recordingPath}
              onChange={(e) => setParam('recording_path', e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
              placeholder="Absolute path to .rhd (or folder containing it)"
            />
          </label>
        </div>
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold tracking-wide text-zinc-200">Actions</div>
          <div className="text-[11px] text-zinc-500">{running ? 'Running…' : 'Idle'}</div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!canUpload || running}
            onClick={() => void runStep('upload')}
            className="rounded-md bg-emerald-700 px-2 py-1.5 text-xs font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50"
            title="Copy recording into artifacts/data/raw/<patient>/<session>/"
          >
            Upload
          </button>
          <button
            type="button"
            disabled={!status.uploaded || running}
            onClick={() => void runStep('sort')}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
            title="Run spike sorting (Kilosort4)"
          >
            Sort
          </button>
          <button
            type="button"
            disabled={!status.sorted || running}
            onClick={() => void runStep('analyze')}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
            title="Create or load SortingAnalyzer"
          >
            Create Analyzer
          </button>
          <button
            type="button"
            disabled={!status.analyzed || running}
            onClick={() => void runStep('gui')}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
            title="Launch SpikeInterface GUI (web mode)"
          >
            Launch Curation Window
          </button>
        </div>

        <div className="mt-2 grid gap-1 text-[11px] text-zinc-400">
          <div className="flex items-center justify-between gap-2">
            <div>Upload</div>
            <div className={status.uploaded ? 'text-emerald-300' : 'text-zinc-500'}>{status.uploaded ? 'done' : 'pending'}</div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>Sort</div>
            <div className={status.sorted ? 'text-emerald-300' : 'text-zinc-500'}>{status.sorted ? 'done' : 'pending'}</div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>Create Analyzer</div>
            <div className={status.analyzed ? 'text-emerald-300' : 'text-zinc-500'}>{status.analyzed ? 'done' : 'pending'}</div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>Curation Window</div>
            <div className={status.curation ? 'text-emerald-300' : 'text-zinc-500'}>{status.curation ? 'done' : 'pending'}</div>
          </div>
          {status.error ? <div className="mt-1 text-red-300">{status.error}</div> : null}
          {lastRun ? (
            <div className="mt-1 flex items-center justify-between gap-2">
              <div>Last run</div>
              <div className={lastRun.ok ? 'text-emerald-300' : 'text-red-300'}>{lastRun.ok ? 'ok' : 'error'}</div>
            </div>
          ) : null}
          {lastRun?.error ? <div className="text-red-300">{String(lastRun.error)}</div> : null}
        </div>
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
        <div className="text-xs font-semibold tracking-wide text-zinc-200">Paths</div>
        <div className="mt-1 space-y-1 font-mono text-[11px] text-zinc-400">
          <div>raw: {rawSessionDir}</div>
          <div>sorted: {sortedSessionDir}</div>
          <div>sorter: {sorterDir}</div>
          <div>analyzer: {analyzerDir}</div>
        </div>
      </div>
    </div>
  )
}
