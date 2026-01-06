"""SAW Plugin Wrapper (example)

Contract:
  - main(inputs: dict, params: dict, context) -> dict
  - inputs/outputs values are {data, metadata}
"""

from __future__ import annotations

import numpy as np


def main(inputs: dict, params: dict, context) -> dict:
    x = inputs["x"]["data"]
    fs = float(params["fs_hz"])
    low = float(params["low_hz"])
    high = float(params["high_hz"])

    context.log("info", "bandpass:start", fs_hz=fs, low_hz=low, high_hz=high)

    # MVP placeholder: pass-through (implement real filter later)
    y = np.asarray(x, dtype=np.float32)

    return {
        "y": {
            "data": y,
            "metadata": {
                "fs_hz": fs,
                "low_hz": low,
                "high_hz": high,
            },
        }
    }


