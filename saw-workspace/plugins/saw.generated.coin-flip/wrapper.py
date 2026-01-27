"""SAW Plugin: Coin Flip

Contract:
 - main(inputs: dict, params: dict, context) -> dict
 - Each input/output value is: {"data": <value>, "metadata": <dict>}

This plugin can be deterministic if you provide a seed.
"""

from __future__ import annotations

import hashlib
import random
from typing import Any


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _seed_to_int(seed: str) -> int:
    # Stable across processes/platforms (unlike Python's hash()).
    h = hashlib.sha256(seed.encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big", signed=False)


def main(inputs: dict, params: dict, context) -> dict:
    try:
        num_flips = int((params or {}).get("num_flips", 1))
    except Exception:
        num_flips = 1
    num_flips = max(1, num_flips)

    try:
        p_heads = float((params or {}).get("p_heads", 0.5))
    except Exception:
        p_heads = 0.5
    p_heads = _clamp(p_heads, 0.0, 1.0)

    seed = str((params or {}).get("seed", "") or "").strip()
    return_labels = str((params or {}).get("return_labels", "HT") or "HT").strip().lower()

    rng = random.Random(_seed_to_int(seed)) if seed else random.Random()

    if return_labels in ("words", "heads/tails", "headstails"):
        heads_label, tails_label = "heads", "tails"
    else:
        heads_label, tails_label = "H", "T"

    flips: list[str] = []
    heads = 0
    for _ in range(num_flips):
        is_heads = rng.random() < p_heads
        if is_heads:
            flips.append(heads_label)
            heads += 1
        else:
            flips.append(tails_label)

    tails = num_flips - heads

    context.log(
        "info",
        "coin_flip:done",
        num_flips=num_flips,
        p_heads=p_heads,
        seed_provided=bool(seed),
        heads=heads,
        tails=tails,
    )

    summary: dict[str, Any] = {
        "num_flips": num_flips,
        "p_heads": p_heads,
        "heads": heads,
        "tails": tails,
        "seed": seed or None,
    }

    return {
        "flips": {"data": flips, "metadata": {"count": len(flips)}},
        "summary": {"data": summary, "metadata": {}},
    }
