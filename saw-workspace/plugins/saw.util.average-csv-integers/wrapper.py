"""SAW Plugin: Average (CSV Integers)

Computes the arithmetic mean of a comma-separated list of integers.

Contract:
 - main(inputs: dict, params: dict, context) -> dict
 - Each input/output value is: {"data": <value>, "metadata": <dict>}
"""

from __future__ import annotations


def _parse_csv_ints(s: str, *, on_invalid: str) -> list[int]:
    raw = (s or "").strip()
    if not raw:
        return []

    out: list[int] = []
    for tok in raw.split(","):
        t = tok.strip()
        if not t:
            continue
        try:
            out.append(int(t))
        except Exception:
            if on_invalid == "ignore":
                continue
            raise ValueError(f"invalid_integer_token: {t!r}")
    return out


def main(inputs: dict, params: dict, context) -> dict:
    csv_integers = str((params or {}).get("csv_integers") or "")
    on_invalid = str((params or {}).get("on_invalid") or "error").strip().lower()
    if on_invalid not in {"error", "ignore"}:
        raise ValueError("on_invalid must be 'error' or 'ignore'")

    values = _parse_csv_ints(csv_integers, on_invalid=on_invalid)
    if not values:
        raise ValueError("no_valid_integers")

    total = sum(values)
    avg = total / len(values)

    context.log("info", "average_csv_integers:computed", count=len(values), sum=total, average=avg)

    return {
        "average": {"data": avg, "metadata": {}},
        "count": {"data": len(values), "metadata": {}},
        "sum": {"data": total, "metadata": {}},
    }
