from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterator

import psycopg

from .settings import Settings


@dataclass(frozen=True)
class MigrationResult:
    applied: list[str]
    already_applied: list[str]


def iter_migration_files() -> Iterator[str]:
    here = os.path.dirname(__file__)
    mig_dir = os.path.abspath(os.path.join(here, "..", "migrations"))
    if not os.path.isdir(mig_dir):
        return iter(())
    names = [n for n in os.listdir(mig_dir) if n.endswith(".sql")]
    names.sort()
    for n in names:
        yield os.path.join(mig_dir, n)


def ensure_migrations_table(conn: psycopg.Connection) -> None:
    conn.execute(
        """
        CREATE SCHEMA IF NOT EXISTS saw_meta;
        CREATE TABLE IF NOT EXISTS saw_meta.schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        """
    )


def migrate(settings: Settings) -> MigrationResult:
    applied: list[str] = []
    already: list[str] = []
    with psycopg.connect(settings.db_admin_url, autocommit=True) as conn:
        ensure_migrations_table(conn)
        for path in iter_migration_files():
            name = os.path.basename(path)
            row = conn.execute(
                "SELECT 1 FROM saw_meta.schema_migrations WHERE name=%s",
                (name,),
            ).fetchone()
            if row:
                already.append(name)
                continue
            sql = open(path, "r", encoding="utf-8").read()
            conn.execute(sql)
            conn.execute("INSERT INTO saw_meta.schema_migrations(name) VALUES (%s)", (name,))
            applied.append(name)
    return MigrationResult(applied=applied, already_applied=already)


