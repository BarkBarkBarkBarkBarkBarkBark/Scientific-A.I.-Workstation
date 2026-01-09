"""SAW Plugin: Bouncing Text Screensaver

Generates a self-contained HTML file that displays the provided text bouncing around a square canvas,
like an old-school screensaver.

Contract:
  - main(inputs: dict, params: dict, context) -> dict
  - inputs/outputs values are {data, metadata}

Run artifact:
  - Writes: <SAW_RUN_DIR>/output/screensaver.html
"""

from __future__ import annotations

import json
import os


def _num(params: dict, key: str, default: float) -> float:
    try:
        return float((params or {}).get(key, default))
    except Exception:
        return float(default)


def _str(params: dict, key: str, default: str) -> str:
    v = (params or {}).get(key, default)
    return str(v) if v is not None else str(default)


def _safe_text(s: str) -> str:
    # Keep it printable-ish; JS will still escape via json.dumps.
    s = (s or "").strip()
    if not s:
        return "SAW"
    return s[:200]


def main(inputs: dict, params: dict, context) -> dict:
    text = _safe_text(str(((inputs or {}).get("text") or {}).get("data") or ""))
    box_size = int(max(128.0, min(2048.0, _num(params, "box_size", 512))))
    speed = float(max(10.0, min(2000.0, _num(params, "speed_px_s", 140))))
    font_size = int(max(10.0, min(256.0, _num(params, "font_size", 36))))
    fg = _str(params, "fg_color", "#00ff88")
    bg = _str(params, "bg_color", "#0b1020")

    run_dir = os.environ.get("SAW_RUN_DIR") or ""
    if not run_dir:
        raise RuntimeError("SAW_RUN_DIR not set (run this plugin via /api/plugins/{id}/run)")
    out_dir = os.path.join(run_dir, "output")
    os.makedirs(out_dir, exist_ok=True)

    html_path = os.path.join(out_dir, "screensaver.html")

    # Embed values safely for JS
    js_text = json.dumps(text)
    js_fg = json.dumps(fg)
    js_bg = json.dumps(bg)

    html = f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Bouncing Text Screensaver</title>
    <style>
      html, body {{
        margin: 0;
        padding: 0;
        height: 100%;
        background: {bg};
        display: grid;
        place-items: center;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      }}
      .frame {{
        width: {box_size}px;
        height: {box_size}px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 12px 40px rgba(0,0,0,0.35);
        overflow: hidden;
        background: {bg};
      }}
      canvas {{
        display: block;
        width: 100%;
        height: 100%;
      }}
      .hint {{
        margin-top: 10px;
        font-size: 12px;
        color: rgba(255,255,255,0.55);
        text-align: center;
      }}
      kbd {{
        font: inherit;
        padding: 2px 6px;
        border: 1px solid rgba(255,255,255,0.2);
        border-bottom-width: 2px;
        border-radius: 6px;
        background: rgba(255,255,255,0.06);
      }}
    </style>
  </head>
  <body>
    <div>
      <div class="frame"><canvas id="c"></canvas></div>
      <div class="hint">Press <kbd>Space</kbd> to pause/resume</div>
    </div>
    <script>
      const TEXT = {js_text};
      const FG = {js_fg};
      const BG = {js_bg};
      const SPEED = {speed};
      const FONT_SIZE = {font_size};

      const canvas = document.getElementById("c");
      const ctx = canvas.getContext("2d");

      function resize() {{
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }}
      resize();
      window.addEventListener("resize", resize);

      let paused = false;
      window.addEventListener("keydown", (e) => {{
        if (e.code === "Space") {{
          e.preventDefault();
          paused = !paused;
        }}
      }});

      ctx.font = `bold ${{FONT_SIZE}}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
      ctx.textBaseline = "top";

      let x = 30;
      let y = 30;
      let vx = 1;
      let vy = 1;

      function measure() {{
        ctx.font = `bold ${{FONT_SIZE}}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
        const m = ctx.measureText(TEXT);
        const w = m.width;
        const h = FONT_SIZE * 1.15;
        return {{w, h}};
      }}

      let last = performance.now();
      function tick(now) {{
        const dt = Math.min(0.05, Math.max(0.0, (now - last) / 1000));
        last = now;
        if (!paused) {{
          const {{w, h}} = measure();
          const W = canvas.getBoundingClientRect().width;
          const H = canvas.getBoundingClientRect().height;

          x += vx * SPEED * dt;
          y += vy * SPEED * dt;

          if (x <= 0) {{ x = 0; vx = Math.abs(vx); }}
          if (y <= 0) {{ y = 0; vy = Math.abs(vy); }}
          if (x + w >= W) {{ x = Math.max(0, W - w); vx = -Math.abs(vx); }}
          if (y + h >= H) {{ y = Math.max(0, H - h); vy = -Math.abs(vy); }}
        }}

        // Draw
        const W = canvas.getBoundingClientRect().width;
        const H = canvas.getBoundingClientRect().height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, W, H);

        const {{w, h}} = measure();
        // Glow
        ctx.save();
        ctx.shadowColor = FG;
        ctx.shadowBlur = 16;
        ctx.fillStyle = FG;
        ctx.fillText(TEXT, x, y);
        ctx.restore();

        // Subtle outline for crispness
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 2;
        ctx.strokeText(TEXT, x, y);

        requestAnimationFrame(tick);
      }}
      requestAnimationFrame(tick);
    </script>
  </body>
</html>
"""

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    context.log(
        "info",
        "bouncing_text:generated",
        html_path=html_path,
        box_size=box_size,
        speed_px_s=speed,
        font_size=font_size,
    )

    # Return relative path so SAW output path validation passes.
    return {
        "page": {
            "data": {
                "html_path": "screensaver.html",
                "hint": "Open the HTML file in a browser to see the bouncing text.",
            },
            "metadata": {"mime": "text/html"},
        }
    }



