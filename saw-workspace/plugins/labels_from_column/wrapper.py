"""SAW Plugin: Labels From Column"""

from __future__ import annotations


def main(inputs: dict, params: dict, context) -> dict:
    df = ((inputs or {}).get("df") or {}).get("data") or {}
    rows = list(df.get("rows") or [])
    col = str((params or {}).get("column") or "").strip()
    if not col:
        raise ValueError("missing_column")
    ys = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        ys.append(r.get(col))
    context.log("info", "labels_from_column:done", column=col, n=len(ys))
    return {"y": {"data": {"labels": ys, "column": col}, "metadata": {}}}


