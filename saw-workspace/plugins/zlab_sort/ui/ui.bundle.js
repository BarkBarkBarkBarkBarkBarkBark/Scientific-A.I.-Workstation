// Prebuilt UI bundle for zlab.sorting_script
// Exports: module.exports.render({ nodeId, plugin, api, components })

module.exports.render = function render(props) {
  const api = props.api
  const h = api.h
  const useState = api.useState
  const useEffect = api.useEffect
  const useMemo = api.useMemo
  const useSawStore = api.useSawStore
  const fetchDevTree = api.fetchDevTree
  const fetchDevFile = api.fetchDevFile

  function existsNonEmptyDir(path) {
    return fetchDevTree({ root: path, depth: 1 })
      .then((t) => t && t.type === 'dir' && (t.children || []).length > 0)
      .catch(() => false)
  }

  function hasAnyRhdFile(path) {
    return fetchDevTree({ root: path, depth: 2 })
      .then((t) => {
        if (!t || t.type !== 'dir') return false
        const stack = [].concat(t.children || [])
        while (stack.length) {
          const n = stack.pop()
          if (!n) continue
          if (n.type === 'file' && String(n.name || '').toLowerCase().endsWith('.rhd')) return true
          if (n.type === 'dir') stack.push.apply(stack, n.children || [])
        }
        return false
      })
      .catch(() => false)
  }

  function existsFile(path) {
    return fetchDevFile(path)
      .then(() => true)
      .catch(() => false)
  }

  function ZlabSortUi() {
    const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) || null)
    const updateNodeParam = useSawStore((s) => s.updateNodeParam)
    const runPluginNode = useSawStore((s) => s.runPluginNode)

    const statusInit = { uploaded: false, sorted: false, analyzed: false, curation: false }
    const _st = useState(statusInit)
    const status = _st[0]
    const setStatus = _st[1]

    const patient = String((node && node.data && node.data.params && node.data.params.patient) || '').trim()
    const session = String((node && node.data && node.data.params && node.data.params.session) || '').trim()
    const recordingPath = String((node && node.data && node.data.params && node.data.params.recording_path) || '').trim()

    const pluginId = String((node && node.data && node.data.pluginId) || '')
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
        setStatus(function (s) {
          return Object.assign({}, s, { uploaded: false, sorted: false, analyzed: false, curation: false, error: undefined })
        })
        return
      }

      let cancelled = false
      Promise.all([
        hasAnyRhdFile(rawSessionDir),
        existsNonEmptyDir(sorterDir),
        existsNonEmptyDir(analyzerDir),
        existsFile(`${curationDir}/curation_data.json`),
      ])
        .then(function (vals) {
          if (cancelled) return
          setStatus(function (s) {
            return Object.assign({}, s, {
              uploaded: !!vals[0],
              sorted: !!vals[1],
              analyzed: !!vals[2],
              curation: !!vals[3],
              error: undefined,
            })
          })
        })
        .catch(function (e) {
          if (cancelled) return
          setStatus(function (s) {
            return Object.assign({}, s, { error: String((e && e.message) || e) })
          })
        })

      return function () {
        cancelled = true
      }
    }, [node, patientOk, sessionOk, rawSessionDir, sorterDir, analyzerDir, curationDir])

    if (!node) return null

    const running = node.data && node.data.status === 'running'
    const lastRun = (node.data && node.data.runtime && node.data.runtime.exec && node.data.runtime.exec.last) || null

    function setParam(key, value) {
      updateNodeParam(props.nodeId, key, value)
    }

    function runStep(step) {
      // for sort/analyze/gui we clear recording_path so wrapper reads uploaded file
      if (step !== 'upload') setParam('recording_path', '')
      setParam('step', step)
      return runPluginNode(props.nodeId)
    }

    return h(
      'div',
      { className: 'space-y-3' },
      h(
        'div',
        { className: 'space-y-2' },
        h('div', { className: 'text-xs font-semibold tracking-wide text-zinc-200' }, 'Inputs'),
        h(
          'div',
          { className: 'grid gap-2' },
          h(
            'label',
            { className: 'grid gap-1' },
            h('div', { className: 'text-[11px] text-zinc-500' }, 'Patient'),
            h('input', {
              value: patient,
              onChange: (e) => setParam('patient', e.target.value),
              className: 'w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100',
              placeholder: 'e.g. Intan_RHD_2000',
            })
          ),
          h(
            'label',
            { className: 'grid gap-1' },
            h('div', { className: 'text-[11px] text-zinc-500' }, 'Session'),
            h('input', {
              value: session,
              onChange: (e) => setParam('session', e.target.value),
              className: 'w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100',
              placeholder: 'e.g. session_1',
            })
          ),
          h(
            'label',
            { className: 'grid gap-1' },
            h('div', { className: 'text-[11px] text-zinc-500' }, 'Recording path'),
            h('input', {
              value: recordingPath,
              onChange: (e) => setParam('recording_path', e.target.value),
              className: 'w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100',
              placeholder: 'Absolute path to .rhd (or folder containing it)',
            })
          )
        )
      ),
      h(
        'div',
        { className: 'rounded-md border border-zinc-800 bg-zinc-950/30 p-2' },
        h(
          'div',
          { className: 'flex items-center justify-between gap-2' },
          h('div', { className: 'text-xs font-semibold tracking-wide text-zinc-200' }, 'Actions'),
          h('div', { className: 'text-[11px] text-zinc-500' }, running ? 'Running…' : 'Idle')
        ),
        h(
          'div',
          { className: 'mt-2 grid grid-cols-2 gap-2' },
          h(
            'button',
            {
              type: 'button',
              disabled: !canUpload || running,
              onClick: () => void runStep('upload'),
              className:
                'rounded-md bg-emerald-700 px-2 py-1.5 text-xs font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50',
              title: 'Copy recording into artifacts/data/raw/<patient>/<session>/',
            },
            'Upload'
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: !status.uploaded || running,
              onClick: () => void runStep('sort'),
              className:
                'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50',
              title: 'Run spike sorting (Kilosort4)',
            },
            'Sort'
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: !status.sorted || running,
              onClick: () => void runStep('analyze'),
              className:
                'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50',
              title: 'Create or load SortingAnalyzer',
            },
            'Create Analyzer'
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: !status.analyzed || running,
              onClick: () => void runStep('gui'),
              className:
                'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50',
              title: 'Launch SpikeInterface GUI (web mode)',
            },
            'Launch Curation Window'
          )
        ),
        h(
          'div',
          { className: 'mt-2 grid gap-1 text-[11px] text-zinc-400' },
          h(
            'div',
            { className: 'flex items-center justify-between gap-2' },
            h('div', null, 'Upload'),
            h('div', { className: status.uploaded ? 'text-emerald-300' : 'text-zinc-500' }, status.uploaded ? 'done' : 'pending')
          ),
          h(
            'div',
            { className: 'flex items-center justify-between gap-2' },
            h('div', null, 'Sort'),
            h('div', { className: status.sorted ? 'text-emerald-300' : 'text-zinc-500' }, status.sorted ? 'done' : 'pending')
          ),
          h(
            'div',
            { className: 'flex items-center justify-between gap-2' },
            h('div', null, 'Create Analyzer'),
            h('div', { className: status.analyzed ? 'text-emerald-300' : 'text-zinc-500' }, status.analyzed ? 'done' : 'pending')
          ),
          h(
            'div',
            { className: 'flex items-center justify-between gap-2' },
            h('div', null, 'Curation Window'),
            h('div', { className: status.curation ? 'text-emerald-300' : 'text-zinc-500' }, status.curation ? 'done' : 'pending')
          ),
          status.error ? h('div', { className: 'mt-1 text-red-300' }, String(status.error)) : null,
          lastRun
            ? h(
                'div',
                { className: 'mt-1 flex items-center justify-between gap-2' },
                h('div', null, 'Last run'),
                h('div', { className: lastRun.ok ? 'text-emerald-300' : 'text-red-300' }, lastRun.ok ? 'ok' : 'error')
              )
            : null,
          lastRun && lastRun.error ? h('div', { className: 'text-red-300' }, String(lastRun.error)) : null
        )
      ),
      h(
        'div',
        { className: 'rounded-md border border-zinc-800 bg-zinc-950/30 p-2' },
        h('div', { className: 'text-xs font-semibold tracking-wide text-zinc-200' }, 'Paths'),
        h(
          'div',
          { className: 'mt-1 space-y-1 font-mono text-[11px] text-zinc-400' },
          h('div', null, `raw: ${rawSessionDir}`),
          h('div', null, `sorted: ${sortedSessionDir}`),
          h('div', null, `sorter: ${sorterDir}`),
          h('div', null, `analyzer: ${analyzerDir}`)
        )
      )
    )
  }

  return h(ZlabSortUi, null)
}
