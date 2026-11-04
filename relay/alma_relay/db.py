"""Registro de peticiones en SQLite (07: transcripción, source, resultado, latencia). Sin audio."""

import json
import os
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    route TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    person_id TEXT,
    transcript TEXT,
    source TEXT,
    result TEXT,
    error TEXT,
    stt_ms INTEGER,
    haiku_ms INTEGER,
    total_ms INTEGER
)
"""


def path() -> str:
    return os.environ.get("ALMA_RELAY_DB", "alma_relay.db")


def log_request(route: str, http_status: int, result, *, person_id=None, transcript=None,
                source=None, error=None, stt_ms=None, haiku_ms=None, total_ms=None) -> None:
    con = sqlite3.connect(path())
    try:
        con.execute(SCHEMA)
        con.execute(
            "INSERT INTO requests (ts, route, http_status, person_id, transcript, source, result, error,"
            " stt_ms, haiku_ms, total_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                route, http_status, person_id, transcript, source,
                json.dumps(result, ensure_ascii=False) if result is not None else None,
                error, stt_ms, haiku_ms, total_ms,
            ),
        )
        con.commit()
    finally:
        con.close()
