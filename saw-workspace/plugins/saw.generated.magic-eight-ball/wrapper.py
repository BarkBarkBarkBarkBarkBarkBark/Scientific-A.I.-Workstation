"""SAW Plugin: Magic Eight Ball

Contract:
 - main(inputs: dict, params: dict, context) -> dict
 - Each input/output value is: {"data": <value>, "metadata": <dict>}

Returns 1 of 8 canned answers; optionally deterministic via a seed.
"""

from __future__ import annotations

import hashlib
import random
from typing import Any


ANSWERS: list[str] = [
    "It is certain.",
    "It is decidedly so.",
    "Without a doubt.",
    "Yes — definitely.",
    "Ask again later.",
    "Cannot predict now.",
    "Don't count on it.",
    "Very doubtful.",
]


def _seed_to_int(seed: str) -> int:
    h = hashlib.sha256(seed.encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big", signed=False)


def main(inputs: dict, params: dict, context) -> dict:
    question = str((params or {}).get("question", "") or "").strip()
    seed = str((params or {}).get("seed", "") or "").strip()

    # If you provide a seed, we also fold in the question so the same seed can
    # yield different answers for different questions.
    rng = (
        random.Random(_seed_to_int(f"{seed}\n{question}"))
        if seed
        else random.Random()
    )

    idx = rng.randrange(len(ANSWERS))
    answer = ANSWERS[idx]

    context.log(
        "info",
        "magic_eight_ball:answer",
        question=question,
        seed_provided=bool(seed),
        index=idx,
        answer=answer,
    )

    details: dict[str, Any] = {
        "question": question,
        "index": idx,
        "answers": ANSWERS,
        "seed": seed or None,
    }

    return {
        "answer": {"data": answer, "metadata": {}},
        "details": {"data": details, "metadata": {}},
    }
