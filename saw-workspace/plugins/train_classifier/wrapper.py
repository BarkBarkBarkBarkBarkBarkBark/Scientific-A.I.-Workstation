"""SAW Plugin: Train Classifier (centroid)

Embedding format:
  { "vectors": [[...], ...], "columns": [...] }
Labels format:
  { "labels": [...] }
"""

from __future__ import annotations

from typing import Any

import numpy as np


def main(inputs: dict, params: dict, context) -> dict:
    x = ((inputs or {}).get("x") or {}).get("data") or {}
    y = ((inputs or {}).get("y") or {}).get("data") or {}

    vectors = x.get("vectors") or []
    labels = y.get("labels") or []
    algo = str((params or {}).get("algo") or "logreg").strip()
    seed = int(float((params or {}).get("seed") or 42))
    _ = algo

    X = np.asarray(vectors, dtype=np.float32)
    if X.ndim != 2 or X.shape[0] == 0:
        raise ValueError("bad_embedding")
    if len(labels) != X.shape[0]:
        raise ValueError("labels_length_mismatch")

    rng = np.random.default_rng(seed)
    _ = rng

    classes = []
    centroids = []
    for cls in sorted({str(v) for v in labels}):
        idx = [i for i, v in enumerate(labels) if str(v) == cls]
        if not idx:
            continue
        mu = np.mean(X[idx, :], axis=0)
        classes.append(cls)
        centroids.append(mu)

    C = np.asarray(centroids, dtype=np.float32)
    model: dict[str, Any] = {
        "type": "centroid",
        "classes": classes,
        "centroids": C,
        "dims": int(X.shape[1]),
    }
    context.log("info", "train_classifier:done", classes=len(classes), dims=int(X.shape[1]))
    return {"model": {"data": model, "metadata": {"algo": "centroid"}}}


