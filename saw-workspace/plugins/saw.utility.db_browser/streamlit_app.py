from __future__ import annotations

import os
from typing import Any

import pandas as pd
import psycopg
import streamlit as st


def _default_db_url() -> str:
    # Matches dev docker-compose default port mapping (127.0.0.1:54329->5432).
    # Prefer localhost in the display string to avoid loopback/DNS quirks.
    return os.environ.get("SAW_DB_URL") or "postgresql://saw_app:saw_app@localhost:54329/saw"


def _get_conn(db_url: str) -> psycopg.Connection[Any]:
    # Streamlit reruns the script frequently; keep a single connection per session.
    conn: psycopg.Connection[Any] | None = st.session_state.get("_db_conn")
    url: str | None = st.session_state.get("_db_url")
    if conn is None or url != db_url or getattr(conn, "closed", False):
        try:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()
        except Exception:
            pass
        conn = psycopg.connect(db_url)
        st.session_state["_db_conn"] = conn
        st.session_state["_db_url"] = db_url
    return conn


def _fetch_tables(conn: psycopg.Connection[Any]) -> list[tuple[str, str]]:
    rows = conn.execute(
        """
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name
        """
    ).fetchall()
    return [(str(r[0]), str(r[1])) for r in rows]


def _fetch_columns(conn: psycopg.Connection[Any], schema: str, table: str) -> list[str]:
    rows = conn.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
        """,
        (schema, table),
    ).fetchall()
    return [str(r[0]) for r in rows]


st.set_page_config(page_title="SAW Database Browser", layout="wide")

st.title("Database Browser")

with st.sidebar:
    st.header("Connection")
    db_url = st.text_input("Database URL", value=_default_db_url())
    row_limit = st.number_input("Row limit", min_value=1, max_value=1000, value=100, step=10)

if not db_url:
    st.warning("Provide a database URL to continue.")
    st.stop()

try:
    conn = _get_conn(db_url)
except Exception as exc:
    st.error(f"Connection failed: {exc}")
    st.stop()

try:
    tables = _fetch_tables(conn)
except Exception as exc:
    st.error(f"Failed to list tables: {exc}")
    st.stop()

if not tables:
    st.info("No tables found.")
    st.stop()

schema_table = st.selectbox(
    "Select table",
    options=tables,
    format_func=lambda t: f"{t[0]}.{t[1]}",
)

schema, table = schema_table

try:
    columns = _fetch_columns(conn, schema, table)
except Exception as exc:
    st.error(f"Failed to list columns: {exc}")
    st.stop()

st.caption(f"Columns: {', '.join(columns)}")

query = st.text_area(
    "Optional SQL query (read-only)",
    value=f"SELECT * FROM {schema}.{table} LIMIT {int(row_limit)}",
    height=120,
)

if st.button("Run query"):
    try:
        df = pd.read_sql_query(query, conn)
        st.dataframe(df, use_container_width=True)
    except Exception as exc:
        st.error(f"Query failed: {exc}")

st.markdown("---")
st.subheader("Table preview")
try:
    preview_df = pd.read_sql_query(
        f"SELECT * FROM {schema}.{table} LIMIT {int(row_limit)}",
        conn,
    )
    st.dataframe(preview_df, use_container_width=True)
except Exception as exc:
    st.error(f"Preview failed: {exc}")
