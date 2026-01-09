"""SAW Plugin: Predict (centroid model)"""

from __future__ import annotations

import numpy as np


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - np.max(z, axis=-1, keepdims=True)
    e = np.exp(z)
    return e / np.sum(e, axis=-1, keepdims=True)


def main(inputs: dict, params: dict, context) -> dict:
    m = ((inputs or {}).get("model") or {}).get("data") or {}
    x = ((inputs or {}).get("x") or {}).get("data") or {}

    if str(m.get("type") or "") != "centroid":
        raise ValueError("unsupported_model")

    classes = list(m.get("classes") or [])
    centroids = np.asarray(m.get("centroids") or [], dtype=np.float32)
    vectors = np.asarray(x.get("vectors") or [], dtype=np.float32)
    if centroids.ndim != 2 or vectors.ndim != 2:
        raise ValueError("bad_inputs")
    if centroids.shape[0] != len(classes):
        raise ValueError("model_corrupt")
    if vectors.shape[1] != centroids.shape[1]:
        raise ValueError("dims_mismatch")

    # negative squared distance as logits
    # logits[i, c] = -||x_i - mu_c||^2
    d2 = np.sum((vectors[:, None, :] - centroids[None, :, :]) ** 2, axis=-1)
    logits = -d2
    probs = _softmax(logits).astype(np.float32)
    pred_idx = np.argmax(probs, axis=1)
    pred_labels = [str(classes[int(i)]) for i in pred_idx]

    threshold = float((params or {}).get("threshold") or 0.5)
    out = {
        "labels": pred_labels,
        "probs": probs,
        "classes": [str(c) for c in classes],
        "threshold": float(threshold),
    }
    context.log("info", "predict:done", n=int(vectors.shape[0]), n_classes=len(classes))
    return {"pred": {"data": out, "metadata": {}}}


