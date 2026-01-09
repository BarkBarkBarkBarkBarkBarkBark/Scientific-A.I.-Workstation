"""SAW Plugin: Audio Lowpass (runtime)

Inputs:
  - wav_path: workspace-relative path to a WAV file (PCM16/PCM32 float supported)

Outputs:
  - audio: {sample_rate_hz, channels, samples: float32[][]}
"""

from __future__ import annotations

import os
import wave
from typing import Any

import numpy as np


def _workspace_root() -> str:
    env = os.environ.get("SAW_WORKSPACE_ROOT")
    if env:
        return os.path.abspath(env)
    here = os.path.dirname(__file__)
    return os.path.abspath(os.path.join(here, "..", ".."))


def _safe_join_under(root: str, rel: str) -> str:
    rel = (rel or "").replace("\\", "/").strip()
    if not rel:
        raise ValueError("missing_path")
    if rel.startswith("/") or rel.startswith("~"):
        raise ValueError("path must be workspace-relative")
    if rel.startswith("..") or "/../" in f"/{rel}/":
        raise ValueError("path traversal is not allowed")
    abs_path = os.path.abspath(os.path.join(root, rel))
    root_abs = os.path.abspath(root)
    if not abs_path.startswith(root_abs):
        raise ValueError("path must be inside saw-workspace/")
    return abs_path


def _read_wav_float32(path: str) -> tuple[np.ndarray, int]:
    # Returns (x[ch, n], sample_rate)
    with wave.open(path, "rb") as wf:
        n_channels = int(wf.getnchannels())
        sampwidth = int(wf.getsampwidth())
        fr = int(wf.getframerate())
        n_frames = int(wf.getnframes())
        raw = wf.readframes(n_frames)

    if sampwidth == 1:
        a = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        a = (a - 128.0) / 128.0
    elif sampwidth == 2:
        a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 3:
        # 24-bit PCM: unpack manually into int32
        b = np.frombuffer(raw, dtype=np.uint8)
        if (len(b) % 3) != 0:
            raise ValueError("bad_wav_bytes")
        x = b.reshape(-1, 3)
        v = (x[:, 0].astype(np.int32) | (x[:, 1].astype(np.int32) << 8) | (x[:, 2].astype(np.int32) << 16))
        # sign extend
        v = (v ^ 0x800000) - 0x800000
        a = v.astype(np.float32) / 8388608.0
    elif sampwidth == 4:
        # Many WAVs use int32; some use float32. Detect by heuristic.
        i32 = np.frombuffer(raw, dtype=np.int32)
        # If values look small (mostly within [-1,1]), treat as float32
        if np.max(np.abs(i32.astype(np.float64))) <= 4:
            a = np.frombuffer(raw, dtype=np.float32).astype(np.float32)
        else:
            a = i32.astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported_wav_sampwidth:{sampwidth}")

    if n_channels <= 0:
        raise ValueError("bad_wav_channels")

    total = a.size
    if total % n_channels != 0:
        raise ValueError("bad_wav_shape")
    n = total // n_channels
    x = a.reshape(n, n_channels).T
    return x.astype(np.float32), fr


def _biquad_lowpass(x: np.ndarray, fs: int, cutoff_hz: float, q: float = 0.70710678) -> np.ndarray:
    # RBJ cookbook biquad lowpass; x shape (n,)
    fc = float(max(10.0, min(0.49 * float(fs), float(cutoff_hz))))
    w0 = 2.0 * np.pi * (fc / float(fs))
    cosw0 = float(np.cos(w0))
    sinw0 = float(np.sin(w0))
    alpha = sinw0 / (2.0 * float(q))

    b0 = (1.0 - cosw0) / 2.0
    b1 = 1.0 - cosw0
    b2 = (1.0 - cosw0) / 2.0
    a0 = 1.0 + alpha
    a1 = -2.0 * cosw0
    a2 = 1.0 - alpha

    b0 /= a0
    b1 /= a0
    b2 /= a0
    a1 /= a0
    a2 /= a0

    y = np.empty_like(x, dtype=np.float32)
    x1 = 0.0
    x2 = 0.0
    y1 = 0.0
    y2 = 0.0
    for i in range(x.size):
        x0 = float(x[i])
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        y[i] = np.float32(y0)
        x2 = x1
        x1 = x0
        y2 = y1
        y1 = y0
    return y


def main(inputs: dict, params: dict, context) -> dict:
    ws_root = _workspace_root()
    rel = str(((inputs or {}).get("wav_path") or {}).get("data") or "").strip()
    cutoff = float((params or {}).get("cutoff_hz") or 1200.0)
    abs_path = _safe_join_under(ws_root, rel)

    context.log("info", "audio_lowpass:start", wav_path=rel, cutoff_hz=cutoff)

    x, fs = _read_wav_float32(abs_path)
    y = np.stack([_biquad_lowpass(x[ch], fs=fs, cutoff_hz=cutoff) for ch in range(x.shape[0])], axis=0)

    # Safety cap for payload size (frontend preview). Keep it small-ish by default.
    max_samples = int(48_000 * 20)  # 20s @ 48k
    if y.shape[1] > max_samples:
        context.log("warning", "audio_lowpass:truncated", max_samples=max_samples, original_samples=int(y.shape[1]))
        y = y[:, :max_samples]

    out: dict[str, Any] = {
        "sample_rate_hz": int(fs),
        "channels": int(y.shape[0]),
        "samples": y.astype(np.float32),
    }

    return {"audio": {"data": out, "metadata": {"cutoff_hz": float(cutoff)}}}


