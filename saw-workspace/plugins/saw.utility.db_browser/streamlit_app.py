from __future__ import annotations

import os
from typing import Any

import pandas as pd
import psycopg
import streamlit as st


def _default_db_url() -> str:
    return os.environ.get("SAW_DB_URL") or "postgresql://saw_app:saw_app@127.0.0.1:54329/saw"


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
    conn = psycopg.connect(db_url)
except Exception as exc:
    st.error(f"Connection failed: {exc}")
    st.stop()

with conn:
    tables = _fetch_tables(conn)

if not tables:
    st.info("No tables found.")
    st.stop()

schema_table = st.selectbox(
    "Select table",
    options=tables,
    format_func=lambda t: f"{t[0]}.{t[1]}",
)

schema, table = schema_table

with conn:
    columns = _fetch_columns(conn, schema, table)

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
