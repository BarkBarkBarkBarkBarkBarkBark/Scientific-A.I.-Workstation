"""SAW Plugin: Normalize

Normalizes numeric columns in a table:
  - method=zscore: (x-mean)/(std+eps)
  - method=minmax: (x-min)/(max-min+eps)
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not (isinstance(x, float) and (math.isnan(x) or math.isinf(x)))


def main(inputs: dict, params: dict, context) -> dict:
    df = ((inputs or {}).get("df") or {}).get("data") or {}
    cols = list(df.get("columns") or [])
    rows = list(df.get("rows") or [])

    method = str((params or {}).get("method") or "zscore").strip().lower()
    eps = float((params or {}).get("eps") or 1e-6)
    eps = float(max(0.0, eps))

    context.log("info", "normalize:start", method=method, eps=eps)

    # Collect numeric columns
    num_cols = []
    for c in cols:
        any_num = False
        for r in rows:
            if isinstance(r, dict) and _is_number(r.get(c)):
                any_num = True
                break
        if any_num:
            num_cols.append(c)

    stats: dict[str, dict[str, float]] = {}
    for c in num_cols:
        xs = [float(r.get(c)) for r in rows if isinstance(r, dict) and _is_number(r.get(c))]
        if not xs:
            continue
        a = np.asarray(xs, dtype=np.float64)
        if method == "minmax":
            mn = float(np.min(a))
            mx = float(np.max(a))
            stats[c] = {"min": mn, "max": mx}
        else:
            mu = float(np.mean(a))
            sd = float(np.std(a))
            stats[c] = {"mean": mu, "std": sd}

    out_rows = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        nr = dict(r)
        for c, st in stats.items():
            v = nr.get(c)
            if not _is_number(v):
                continue
            x = float(v)
            if method == "minmax":
                denom = (st["max"] - st["min"]) + eps
                nr[c] = (x - st["min"]) / denom
            else:
                denom = st["std"] + eps
                nr[c] = (x - st["mean"]) / denom
        out_rows.append(nr)

    out = {"columns": cols, "rows": out_rows, "n_rows": len(out_rows), "method": method, "stats": stats}
    return {"df_norm": {"data": out, "metadata": {}}}


