"""SAW Plugin: Plot Scatter (payload only)

Produces a simple JSON payload the frontend can render later.
"""

from __future__ import annotations


def main(inputs: dict, params: dict, context) -> dict:
    emb = ((inputs or {}).get("emb") or {}).get("data") or {}
    vectors = emb.get("vectors") or []
    columns = [str(c) for c in (emb.get("columns") or [])]
    xk = str((params or {}).get("x") or "pc1")
    yk = str((params or {}).get("y") or "pc2")
    ck = str((params or {}).get("color") or "label")

    # Best-effort: if columns include requested keys, map; else fallback to first two dims.
    xi = columns.index(xk) if xk in columns else 0
    yi = columns.index(yk) if yk in columns else 1

    pts = []
    for i, v in enumerate(vectors):
        try:
            x = float(v[xi])
            y = float(v[yi])
        except Exception:
            continue
        pts.append({"x": x, "y": y, "color": None, "i": int(i)})

    context.log("info", "plot_scatter:done", n=len(pts), x=xk, y=yk, color=ck)
    payload = {"type": "scatter", "x": xk, "y": yk, "color": ck, "points": pts}
    return {"viz": {"data": payload, "metadata": {"mime": "application/json"}}}


