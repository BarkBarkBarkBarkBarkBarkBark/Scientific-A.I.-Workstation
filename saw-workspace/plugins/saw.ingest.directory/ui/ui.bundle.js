// Prebuilt UI bundle for saw.ingest.directory
// Exports: module.exports.render({ nodeId, plugin, api, components })

module.exports.render = function render(props) {
  const api = props.api
  const h = api.h
  const useState = api.useState
  const useMemo = api.useMemo
  const useSawStore = api.useSawStore

  function IngestUi() {
    const _dir = useState('.')
    const directory = _dir[0]
    const setDirectory = _dir[1]

    const _busy = useState(false)
    const busy = _busy[0]
    const setBusy = _busy[1]

    const _result = useState('')
    const result = _result[0]
    const setResult = _result[1]

    const _error = useState('')
    const error = _error[0]
    const setError = _error[1]

    const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) || null)
    const updateNodeParam = useSawStore((s) => s.updateNodeParam)
    const plugin = useSawStore((s) => s.pluginCatalog.find((p) => p.id === 'saw.ingest.directory') || null)

    const hint = useMemo(
      () => (plugin && plugin.description ? plugin.description : 'Index workspace files into the vector DB.'),
      [plugin && plugin.description]
    )

    const query = String((node && node.data && node.data.params && node.data.params.query) ?? 'patch engine')
    const topK = Number((node && node.data && node.data.params && node.data.params.top_k) ?? 8)

    async function runIngest() {
      setBusy(true)
      setError('')
      setResult('')
      try {
        const r = await api.fetch('/api/saw/plugins/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plugin_id: 'saw.ingest.directory',
            inputs: { directory: { data: directory } },
            params: { query: query, top_k: topK },
          }),
        })
        const txt = await r.text()
        if (!r.ok) throw new Error(txt)
        const j = JSON.parse(txt)
        setResult(JSON.stringify(j, null, 2))
      } catch (e) {
        setError(String((e && e.message) || e))
      } finally {
        setBusy(false)
      }
    }

    return h(
      'div',
      { className: 'space-y-2' },
      h(
        'div',
        { className: 'rounded-md border border-zinc-800 bg-zinc-950/40 p-3' },
        h('div', { className: 'text-xs font-semibold tracking-wide text-zinc-200' }, 'Directory to ingest'),
        h('div', { className: 'mt-1 text-[11px] text-zinc-500' }, hint),
        h(
          'div',
          { className: 'mt-2 grid grid-cols-[1fr,180px] gap-2' },
          h('input', {
            value: directory,
            onChange: (e) => setDirectory(e.target.value),
            placeholder: 'e.g. "." or "docs" or "plugins"',
            className:
              'w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700',
            disabled: busy,
          }),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => void runIngest(),
              className: 'rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50',
              title: 'Run ingest (calls SAW API /plugins/execute)',
            },
            busy ? 'Running…' : 'Run ingest'
          )
        ),
        h(
          'div',
          { className: 'mt-2 grid grid-cols-[1fr,120px] gap-2' },
          h('input', {
            value: query,
            onChange: (e) => node && updateNodeParam(node.id, 'query', e.target.value),
            placeholder: 'Optional: query for nearest neighbors after ingest',
            className:
              'w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700',
            disabled: busy,
          }),
          h('input', {
            type: 'number',
            value: topK,
            onChange: (e) => node && updateNodeParam(node.id, 'top_k', Number(e.target.value)),
            min: 1,
            max: 50,
            step: 1,
            className: 'w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700',
            disabled: busy,
            title: 'top_k',
          })
        ),
        error
          ? h('div', { className: 'mt-2 rounded-md border border-rose-900/40 bg-rose-950/20 p-2 text-[11px] text-rose-200' }, error)
          : null
      ),
      h(
        'div',
        { className: 'rounded-md border border-zinc-800 bg-zinc-950/40 overflow-hidden' },
        h('div', { className: 'px-3 py-2 text-xs font-semibold tracking-wide text-zinc-200 border-b border-zinc-800' }, 'Last run (raw JSON)'),
        h(
          'div',
          { className: 'max-h-[260px] overflow-auto p-3' },
          h('pre', { className: 'whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-200' }, result || '(none yet)')
        )
      )
    )
  }

  return h(IngestUi, null)
}
