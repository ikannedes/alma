"""Alarmas del dueño (2026-10-30: "no quiero programar en calendario, mejor haz el apartado de alarmas").

Se crean en la app y viven en data/alarms.json. A su hora, el servidor manda la notificación al celular y
{"t":"reminder"} al robot (bhv_reminder: animación de alarma con sonido). Días 0 = lunes … 6 = domingo; sin días,
suena una vez y se apaga.
"""

import datetime as dt
import json
import os
import secrets
import threading
from zoneinfo import ZoneInfo

from . import settings

DEFAULT_TZ = "America/Mexico_City"   # la del robot (CST6, sin horario de verano)
GRACE = dt.timedelta(minutes=2)      # si el servidor estuvo ocupado o reiniciando, todavía suena
MAX_ALARMS = 30
_lock = threading.Lock()


def tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.load().get("timezone") or DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def _path() -> str:
    return os.path.join(settings.data_dir(), "alarms.json")


def load() -> list[dict]:
    try:
        with open(_path(), encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, list) else []
    except (FileNotFoundError, ValueError):
        return []


def _save(alarms: list[dict]) -> None:
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(alarms, f, ensure_ascii=False)
    os.replace(tmp, _path())


def clean(body: dict) -> dict | str:
    """Valida lo que manda la app. Devuelve los campos o un mensaje de error."""
    t = str(body.get("time", ""))
    try:
        h, m = (int(x) for x in t.split(":"))
        assert 0 <= h < 24 and 0 <= m < 60
    except Exception:
        return "la hora va como HH:MM"
    days = body.get("days") or []
    if not isinstance(days, list) or any(not isinstance(d, int) or not 0 <= d <= 6 for d in days):
        return "días inválidos"
    label = str(body.get("label") or "").strip()[:60]
    return {"time": f"{h:02d}:{m:02d}", "days": sorted(set(days)), "label": label}


def add(fields: dict) -> dict | None:
    with _lock:
        alarms = load()
        if len(alarms) >= MAX_ALARMS:
            return None
        a = fields | {"id": secrets.token_hex(4), "enabled": True, "last_fired": ""}
        _save(alarms + [a])
        return a


def update(alarm_id: str, fields: dict) -> dict | None:
    with _lock:
        alarms = load()
        for a in alarms:
            if a["id"] == alarm_id:
                a.update({k: v for k, v in fields.items() if k in ("time", "days", "label", "enabled")})
                if fields.get("enabled") or "time" in fields:
                    a["last_fired"] = ""
                _save(alarms)
                return a
        return None


def delete(alarm_id: str) -> bool:
    with _lock:
        alarms = load()
        rest = [a for a in alarms if a["id"] != alarm_id]
        _save(rest)
        return len(rest) != len(alarms)


def due(now_utc: dt.datetime) -> list[dict]:
    """Las alarmas que suenan ahora; las marca para no repetir (y apaga las de una sola vez)."""
    now = now_utc.astimezone(tz())
    out = []
    with _lock:
        alarms = load()
        for a in alarms:
            if not a.get("enabled"):
                continue
            h, m = (int(x) for x in a["time"].split(":"))
            at = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if at > now:
                at -= dt.timedelta(days=1)   # una alarma de 23:59 que suena pasada la medianoche
            if not now - at < GRACE:
                continue
            if a["days"] and at.weekday() not in a["days"]:
                continue
            stamp = at.strftime("%Y-%m-%dT%H:%M")
            if a.get("last_fired") == stamp:
                continue
            a["last_fired"] = stamp
            if not a["days"]:
                a["enabled"] = False
            out.append(a)
        if out:
            _save(alarms)
    return out


def next_ring(a: dict, now_utc: dt.datetime) -> str | None:
    """Cuándo suena la próxima vez (para la app), en la zona del dueño: "2026-11-03T07:30"."""
    if not a.get("enabled"):
        return None
    now = now_utc.astimezone(tz())
    h, m = (int(x) for x in a["time"].split(":"))
    for k in range(8):
        d = (now + dt.timedelta(days=k)).replace(hour=h, minute=m, second=0, microsecond=0)
        if d > now and (not a["days"] or d.weekday() in a["days"]):
            return d.strftime("%Y-%m-%dT%H:%M")
    return None
