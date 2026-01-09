"""SAW Plugin: PCA (SVD)

Input table -> output embedding:
  {
    "vectors": [[float,...], ...],
    "columns": ["pc1", ...],
    "n_rows": int
  }
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

    n_components = int(float((params or {}).get("n_components") or 2))
    n_components = max(2, min(64, n_components))

    # numeric columns only
    num_cols = []
    for c in cols:
        if any(isinstance(r, dict) and _is_number(r.get(c)) for r in rows):
            num_cols.append(c)
    if not num_cols:
        raise ValueError("no_numeric_columns")

    X = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        X.append([float(r.get(c) or 0.0) if _is_number(r.get(c)) else 0.0 for c in num_cols])
    if not X:
        raise ValueError("empty_table")

    X = np.asarray(X, dtype=np.float64)
    context.log("info", "pca:start", n_rows=int(X.shape[0]), n_cols=int(X.shape[1]), n_components=n_components)

    mu = np.mean(X, axis=0, keepdims=True)
    Xc = X - mu

    # SVD
    U, S, Vt = np.linalg.svd(Xc, full_matrices=False)
    k = min(n_components, Vt.shape[0])
    Z = Xc @ Vt[:k].T

    out = {
        "vectors": Z.astype(np.float32),
        "columns": [f"pc{i+1}" for i in range(k)],
        "n_rows": int(Z.shape[0]),
        "source_columns": num_cols,
    }
    return {"emb": {"data": out, "metadata": {"mean": mu.squeeze().astype(np.float32)}}}


