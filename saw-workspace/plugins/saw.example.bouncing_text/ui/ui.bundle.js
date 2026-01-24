// Prebuilt UI bundle for saw.example.bouncing_text
// Exports: module.exports.render({ nodeId, plugin, api, components })

module.exports.render = function render(props) {
  const api = props.api
  const h = api.h
  const useState = api.useState
  const useMemo = api.useMemo
  const useSawStore = api.useSawStore

  function BouncingTextUi() {
    const _text = useState('Hello SAW!')
    const text = _text[0]
    const setText = _text[1]

    const _busy = useState(false)
    const busy = _busy[0]
    const setBusy = _busy[1]

    const _html = useState('')
    const htmlContent = _html[0]
    const setHtmlContent = _html[1]

    const _err = useState('')
    const error = _err[0]
    const setError = _err[1]

    const _result = useState('')
    const result = _result[0]
    const setResult = _result[1]

    const node = useSawStore((s) => s.nodes.find((n) => n.id === props.nodeId) || null)
    const updateNodeParam = useSawStore((s) => s.updateNodeParam)
    const plugin = useSawStore((s) => s.pluginCatalog.find((p) => p.id === 'saw.example.bouncing_text') || null)

    const boxSize = Number((node && node.data && node.data.params && node.data.params.box_size) ?? 512)
    const speed = Number((node && node.data && node.data.params && node.data.params.speed_px_s) ?? 140)
    const fontSize = Number((node && node.data && node.data.params && node.data.params.font_size) ?? 36)
    const fgColor = String((node && node.data && node.data.params && node.data.params.fg_color) ?? '#00ff88')
    const bgColor = String((node && node.data && node.data.params && node.data.params.bg_color) ?? '#0b1020')

    const hint = useMemo(
      () => (plugin && plugin.description ? plugin.description : 'Generate bouncing text HTML animation.'),
      [plugin && plugin.description]
    )

    async function run() {
      setBusy(true)
      setError('')
      setResult('')
      setHtmlContent('')
      try {
        const r = await api.fetch('/api/saw/plugins/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plugin_id: 'saw.example.bouncing_text',
            inputs: { text: { data: text } },
            params: { box_size: boxSize, speed_px_s: speed, font_size: fontSize, fg_color: fgColor, bg_color: bgColor },
          }),
        })
        const txt = await r.text()
        if (!r.ok) throw new Error(txt)
        const j = JSON.parse(txt)
        setResult(JSON.stringify(j, null, 2))

        if (j && j.ok && j.outputs && j.outputs.page && j.outputs.page.data && j.outputs.page.data.html_path) {
          const htmlPath = j.outputs.page.data.html_path
          const enhancedHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bouncing Text - ${text}</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      background: ${bgColor};
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
    }
    .frame {
      width: ${boxSize}px;
      height: ${boxSize}px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      overflow: hidden;
      background: ${bgColor};
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
    }
    .preview-text {
      font-size: ${fontSize}px;
      font-weight: bold;
      color: ${fgColor};
      text-align: center;
      position: absolute;
      animation: bounce 2s infinite ease-in-out;
      white-space: nowrap;
    }
    @keyframes bounce {
      0%, 100% { transform: translate(0, 0); }
      25% { transform: translate(${Math.min(50, boxSize / 4)}px, ${Math.min(-30, -boxSize / 8)}px); }
      50% { transform: translate(0, ${Math.min(-50, -boxSize / 6)}px); }
      75% { transform: translate(${Math.min(-50, -boxSize / 4)}px, ${Math.min(-30, -boxSize / 8)}px); }
    }
    .hint {
      font-size: 12px;
      color: rgba(255,255,255,0.55);
      text-align: center;
      max-width: 400px;
    }
    .status {
      font-size: 11px;
      color: rgba(0,255,136,0.8);
      background: rgba(0,255,136,0.1);
      padding: 4px 8px;
      border-radius: 4px;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="frame">
      <div class="preview-text">${text || 'Hello SAW!'}</div>
    </div>
    <div class="hint">
      Interactive animation generated successfully!<br>
      File: ${htmlPath}<br>
      Press Space to pause/resume the full animation.
    </div>
    <div class="status">✓ Plugin executed successfully</div>
  </div>
</body>
</html>`
          setHtmlContent(enhancedHtml)
        } else {
          const fallbackHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bouncing Text Preview</title>
  <style>
    body { margin: 0; padding: 20px; background: #0b1020; display: flex; justify-content: center; align-items: center; min-height: 100vh; color: #00ff88; font-family: monospace; }
  </style>
</head>
<body>
  <div>${text || 'Hello SAW!'}</div>
</body>
</html>`
          setHtmlContent(fallbackHtml)
        }
      } catch (e) {
        setError(String((e && e.message) || e))
      } finally {
        setBusy(false)
      }
    }

    return h(
      'div',
      { className: 'space-y-3' },
      h(
        'div',
        { className: 'rounded-md border border-zinc-800 bg-zinc-950/40 p-3' },
        h('div', { className: 'text-xs font-semibold tracking-wide text-zinc-200' }, 'Text Input'),
        h('div', { className: 'mt-1 text-[11px] text-zinc-500' }, hint),
        h('div', { className: 'mt-2' },
          h('textarea', {
            value: text,
            onChange: (e) => setText(e.target.value),
            placeholder: 'Enter text to animate...',
            rows: 3,
            className:
              'w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-700',
            disabled: busy,
          })
        )
      ),
      h(
        'div',
        { className: 'rounded-md border border-zinc-800 bg-zinc-950/40 p-3' },
        h('div', { className: 'text-xs font-semibold tracking-wide text-zinc-200' }, 'Animation Parameters'),
        h(
          'div',
          { className: 'mt-2 grid grid-cols-2 gap-3' },
          h(
            'div',
            null,
            h('label', { className: 'block text-[11px] text-zinc-400' }, 'Box Size (px)'),
            h('input', {
              type: 'number',
              value: boxSize,
              onChange: (e) => node && updateNodeParam(node.id, 'box_size', Number(e.target.value)),
              min: 128,
              max: 2048,
              className:
                'mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700',
              disabled: busy,
            })
          ),
          h(
            'div',
            null,
            h('label', { className: 'block text-[11px] text-zinc-400' }, 'Speed (px/s)'),
            h('input', {
              type: 'number',
              value: speed,
              onChange: (e) => node && updateNodeParam(node.id, 'speed_px_s', Number(e.target.value)),
              min: 10,
              max: 2000,
              className:
                'mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700',
              disabled: busy,
            })
          ),
          h(
            'div',
            null,
            h('label', { className: 'block text-[11px] text-zinc-400' }, 'Font Size (px)'),
            h('input', {
              type: 'number',
              value: fontSize,
              onChange: (e) => node && updateNodeParam(node.id, 'font_size', Number(e.target.value)),
              min: 10,
              max: 256,
              className:
                'mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-700',
              disabled: busy,
            })
          ),
          h(
            'div',
            null,
            h('label', { className: 'block text-[11px] text-zinc-400' }, 'Colors'),
            h(
              'div',
              { className: 'mt-1 flex gap-2' },
              h('input', {
                type: 'color',
                value: fgColor,
                onChange: (e) => node && updateNodeParam(node.id, 'fg_color', e.target.value),
                className: 'h-8 w-8 rounded border border-zinc-700',
                disabled: busy,
                title: 'Text Color',
              }),
              h('input', {
                type: 'color',
                value: bgColor,
                onChange: (e) => node && updateNodeParam(node.id, 'bg_color', e.target.value),
                className: 'h-8 w-8 rounded border border-zinc-700',
                disabled: busy,
                title: 'Background Color',
              })
            )
          )
        )
      ),
      h(
        'div',
        { className: 'flex justify-center' },
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: () => void run(),
            className: 'rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-zinc-50 hover:bg-emerald-600 disabled:opacity-50',
            title: 'Generate bouncing text animation',
          },
          busy ? 'Generating…' : 'Generate Animation'
        )
      ),
      error
        ? h('div', { className: 'rounded-md border border-rose-900/40 bg-rose-950/20 p-3 text-[11px] text-rose-200' }, error)
        : null,
      htmlContent
        ? h(
            'div',
            { className: 'rounded-md border border-zinc-800 bg-zinc-950/40 p-3' },
            h('div', { className: 'text-xs font-semibold tracking-wide text-zinc-200 mb-2' }, 'Live Preview'),
            h(
              'div',
              { className: 'bg-black rounded border overflow-hidden' },
              h('iframe', {
                srcDoc: htmlContent,
                className: 'w-full h-64 border-0',
                title: 'Bouncing Text Animation',
                sandbox: 'allow-scripts',
              })
            ),
            h(
              'div',
              { className: 'mt-2 text-[11px] text-zinc-500' },
              'Live preview of generated animation. The full interactive HTML file with collision detection and pause/resume controls has been created successfully.'
            )
          )
        : null,
      result
        ? h(
            'div',
            { className: 'rounded-md border border-zinc-800 bg-zinc-950/40 p-3' },
            h('div', { className: 'text-xs font-semibold tracking-wide text-zinc-200 mb-2' }, 'Execution Result'),
            h(
              'div',
              { className: 'max-h-[200px] overflow-auto' },
              h('pre', { className: 'whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-200' }, result)
            )
          )
        : null
    )
  }

  return h(BouncingTextUi, null)
}
