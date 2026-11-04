"""Días anteriores de Alma (data/days.json): el resumen de cada noche y lo que dijo Haiku.

Haiku juzga el día con los anteriores (07: "previous_days", hasta 6) y la app muestra el diario.
"""

import json
import os
import threading

from . import settings

KEEP = 60
_lock = threading.Lock()


def _path() -> str:
    return os.path.join(settings.data_dir(), "days.json")


def load() -> list[dict]:
    try:
        with open(_path(), encoding="utf-8") as f:
            days = json.load(f)
        return days if isinstance(days, list) else []
    except (FileNotFoundError, ValueError):
        return []


def add(summary: dict, result: dict | None) -> None:
    with _lock:
        days = load() + [{"summary": summary, "result": result or {}}]
        tmp = _path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(days[-KEEP:], f, ensure_ascii=False)
        os.replace(tmp, _path())


def previous(n: int = 6) -> list[dict]:
    return [d["summary"] for d in load()[-n:]]


def journal(n: int = 7) -> list[dict]:
    """Lo más reciente primero, para la app."""
    out = []
    for d in reversed(load()[-n:]):
        s, r = d.get("summary") or {}, d.get("result") or {}
        out.append({"date": s.get("date"), "age_days": s.get("age_days"), "wellbeing": s.get("wellbeing"),
                    "journal_es": r.get("journal_es", ""), "wellbeing_adjust": r.get("wellbeing_adjust"),
                    "wellbeing_reason": r.get("wellbeing_reason", "")})
    return out
