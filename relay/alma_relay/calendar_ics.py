"""Recordatorios del calendario de Google (dueño, 2026-10-30: "si lo quiero, además de alarmas").

El dueño pega en la app la "dirección secreta en formato iCal" de su calendario (solo lectura; no hace falta un
proyecto de Google Cloud). El servidor la lee cada FETCH_EVERY_S y, a la hora de cada aviso, manda una notificación
al celular y {"t":"reminder"} al robot (bhv_reminder: animación de alarma con sonido).

Cuándo avisa: con las notificaciones que el evento trae en el calendario (VALARM); si no trae ninguna, lead_min antes.
Los eventos de todo el día no avisan. Cada aviso sale una sola vez (data/reminded.json).
"""

import datetime as dt
import json
import os
import threading
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events

from . import settings

FETCH_EVERY_S = 300
DEFAULT_LEAD_MIN = 10
GRACE_S = 300          # si el servidor estuvo caído, un aviso de hace menos de 5 min todavía sale
KEEP_SENT = 500
_lock = threading.Lock()


def lead_min() -> int:
    v = settings.load().get("calendar_lead_min")
    return v if isinstance(v, int) and 0 <= v <= 240 else DEFAULT_LEAD_MIN


def parse(ics: bytes, start: dt.datetime, end: dt.datetime) -> tuple[list[dict], str]:
    """Eventos con hora entre start y end (UTC), con las repeticiones ya expandidas, y la zona del calendario."""
    cal = icalendar.Calendar.from_ical(ics)
    tz = str(cal.get("X-WR-TIMEZONE") or "UTC")
    out = []
    for ev in recurring_ical_events.of(cal).between(start, end):
        s = ev.get("DTSTART")
        if s is None or not isinstance(s.dt, dt.datetime):
            continue   # todo el día: sin aviso
        when = s.dt if s.dt.tzinfo else s.dt.replace(tzinfo=ZoneInfo(tz))
        alarms = []
        for al in ev.walk("VALARM"):
            trig = al.get("TRIGGER")
            if trig is not None and isinstance(trig.dt, dt.timedelta) and trig.dt <= dt.timedelta(0):
                alarms.append(int(-trig.dt.total_seconds() // 60))
        out.append({"uid": str(ev.get("UID", "")), "title": str(ev.get("SUMMARY", "") or "Evento"),
                    "start": when.astimezone(dt.timezone.utc), "alarms": sorted(set(alarms))})
    out.sort(key=lambda e: e["start"])
    return out, tz


def due(events: list[dict], now: dt.datetime, lead: int, sent: set[str]) -> list[dict]:
    """Avisos que tocan ahora y no han salido."""
    out = []
    for e in events:
        for m in e["alarms"] or [lead]:
            at = e["start"] - dt.timedelta(minutes=m)
            key = f"{e['uid']}|{e['start'].isoformat()}|{m}"
            if at <= now < at + dt.timedelta(seconds=GRACE_S) and key not in sent:
                out.append({"key": key, "title": e["title"], "minutes": m, "start": e["start"]})
    return out


def _sent_path() -> str:
    return os.path.join(settings.data_dir(), "reminded.json")


def load_sent() -> list[str]:
    try:
        with open(_sent_path(), encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, list) else []
    except (FileNotFoundError, ValueError):
        return []


def mark_sent(keys: list[str]) -> None:
    with _lock:
        v = (load_sent() + keys)[-KEEP_SENT:]
        tmp = _sent_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(v, f)
        os.replace(tmp, _sent_path())


def local_hhmm(t: dt.datetime, tz: str) -> str:
    try:
        return t.astimezone(ZoneInfo(tz)).strftime("%H:%M")
    except Exception:
        return t.strftime("%H:%M UTC")
