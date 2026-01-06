from __future__ import annotations

from contextlib import contextmanager
import hashlib
from typing import Any, Iterator

import psycopg
from pgvector.psycopg import register_vector

from .settings import Settings


@contextmanager
def db_conn(settings: Settings) -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(settings.db_url, autocommit=True)
    try:
        register_vector(conn)
    except Exception:
        # If extension is missing, queries may fail later; keep connection open.
        pass
    try:
        yield conn
    finally:
        conn.close()


def sha256_text(text: str) -> str:
    h = hashlib.sha256()
    h.update(text.encode("utf-8", errors="ignore"))
    return h.hexdigest()


def jsonable(x: Any) -> Any:
    # Best-effort conversion for json inserts (plain Python types only).
    if x is None:
        return None
    if isinstance(x, (str, int, float, bool)):
        return x
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, list):
        return [jsonable(v) for v in x]
    return str(x)


def jsonb(x: Any):
    # Wrap a plain-Python jsonable value as a JSONB parameter for psycopg.
    from psycopg.types.json import Jsonb

    return Jsonb(jsonable(x))


