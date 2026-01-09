"""SAW Plugin: Filter Rows

Expr DSL (minimal):
  col("name") <op> <number|string>
Where <op> is one of: == != >= <= > <

Table format is the same as load_csv.
"""

from __future__ import annotations

import re


_EXPR_RE = re.compile(
    r"""^\s*col\(\s*["'](?P<col>[^"']+)["']\s*\)\s*(?P<op>==|!=|>=|<=|>|<)\s*(?P<rhs>.+?)\s*$"""
)


def _parse_rhs(rhs: str):
    s = (rhs or "").strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    try:
        if any(c in s for c in (".", "e", "E")):
            return float(s)
        return int(s)
    except Exception:
        return s


def _cmp(op: str, a, b) -> bool:
    try:
        if op == "==":
            return a == b
        if op == "!=":
            return a != b
        if op == ">":
            return a > b
        if op == "<":
            return a < b
        if op == ">=":
            return a >= b
        if op == "<=":
            return a <= b
    except Exception:
        return False
    return False


def main(inputs: dict, params: dict, context) -> dict:
    df = ((inputs or {}).get("df_in") or {}).get("data") or {}
    cols = list(df.get("columns") or [])
    rows = list(df.get("rows") or [])
    expr = str((params or {}).get("expr") or "").strip()
    m = _EXPR_RE.match(expr or "")
    if not m:
        raise ValueError("invalid_expr (expected: col(\"name\") > 0.5)")
    col = str(m.group("col"))
    op = str(m.group("op"))
    rhs = _parse_rhs(str(m.group("rhs")))

    context.log("info", "filter_rows:start", expr=expr, col=col, op=op)

    out_rows = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        a = r.get(col)
        if _cmp(op, a, rhs):
            out_rows.append(r)

    out = {"columns": cols, "rows": out_rows, "n_rows": len(out_rows), "expr": expr}
    return {"df_out": {"data": out, "metadata": {}}}


