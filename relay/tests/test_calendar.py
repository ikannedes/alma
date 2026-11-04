"""Recordatorios del calendario (calendar_ics.py y web.py; dueño, 2026-10-30: además de las alarmas). Sin red."""

import asyncio
import datetime as dt

from alma_relay import calendar_ics, web
from tests.test_web import _setup, c  # noqa: F401  (fixture del servidor)

NOW = dt.datetime(2026, 11, 3, 15, 0, tzinfo=dt.timezone.utc)


def _ics(now: dt.datetime) -> bytes:
    f = lambda t: t.strftime("%Y%m%dT%H%M%SZ")
    return f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//prueba//ES
X-WR-TIMEZONE:America/Mexico_City
BEGIN:VEVENT
UID:junta@x
DTSTART:{f(now + dt.timedelta(minutes=10))}
DTEND:{f(now + dt.timedelta(minutes=40))}
SUMMARY:Junta con el equipo
END:VEVENT
BEGIN:VEVENT
UID:medico@x
DTSTART:{f(now + dt.timedelta(minutes=30))}
SUMMARY:Médico
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT30M
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:pastilla@x
DTSTART:{f(now - dt.timedelta(days=3) + dt.timedelta(minutes=10))}
RRULE:FREQ=DAILY
SUMMARY:Pastilla
END:VEVENT
BEGIN:VEVENT
UID:cumple@x
DTSTART;VALUE=DATE:{now.strftime("%Y%m%d")}
SUMMARY:Cumpleaños
END:VEVENT
BEGIN:VEVENT
UID:luego@x
DTSTART:{f(now + dt.timedelta(hours=3))}
SUMMARY:Más tarde
END:VEVENT
END:VCALENDAR
""".replace("\n", "\r\n").encode()


def test_parse_and_due():
    events, tz = calendar_ics.parse(_ics(NOW), NOW - dt.timedelta(hours=1), NOW + dt.timedelta(days=1))
    titles = [e["title"] for e in events]
    assert tz == "America/Mexico_City"
    assert "Cumpleaños" not in titles                      # todo el día: sin aviso
    assert titles.count("Pastilla") == 1                   # solo la de hoy: la de mañana cae fuera de la ventana de 1 día
    d = calendar_ics.due(events, NOW, 10, set())
    assert {(r["title"], r["minutes"]) for r in d} == {("Junta con el equipo", 10), ("Médico", 30), ("Pastilla", 10)}
    assert calendar_ics.due(events, NOW, 10, {r["key"] for r in d}) == []          # una sola vez
    assert calendar_ics.due(events, NOW - dt.timedelta(minutes=1), 10, set()) == []   # todavía no
    assert calendar_ics.local_hhmm(NOW, tz) == "09:00"


def test_tick_pushes_and_tells_robot(c, monkeypatch):  # noqa: F811
    _setup(c)
    c.post("/app/push/subscribe", json={"endpoint": "https://push.example/abc", "keys": {}})
    assert c.post("/app/settings", json={"calendar_ics": "http://inseguro"}).status_code == 400
    r = c.post("/app/settings", json={"calendar_ics": "webcal://calendar.google.com/calendar/ical/x/private-abc/basic.ics",
                                      "calendar_lead_min": 15})
    assert r.json()["calendar_ics"] is True and "private-abc" not in r.text      # nunca se devuelve
    events, tz = calendar_ics.parse(_ics(NOW), NOW - dt.timedelta(hours=1), NOW + dt.timedelta(days=2))
    web._cal.update(fetched=1e12, events=events, tz=tz, error=None)               # ya leída: sin red
    to_robot = []

    async def fake_send(obj):
        to_robot.append(obj)
        return True
    monkeypatch.setattr(web.hub, "send", fake_send)
    out = asyncio.run(web._calendar_tick(NOW + dt.timedelta(minutes=-5)))       # aviso de 15 min (lead del dueño)
    assert {x["title"] for x in out} == {"Junta con el equipo", "Pastilla"}
    assert {m["t"] for m in to_robot} == {"reminder"} and to_robot[0]["at"] == "09:10" and to_robot[0]["minutes"] == 15
    assert any(p["kind"] == "reminder" and p["title"].startswith("📅 En 15 min:") for p in c.sent)
    assert asyncio.run(web._calendar_tick(NOW + dt.timedelta(minutes=-4))) == []  # no repite
    v = c.get("/app/calendar").json()
    assert v["configured"] and v["lead_min"] == 15 and v["next"][0]["title"] == "Junta con el equipo"
    c.post("/app/settings", json={"calendar_off": True})
    assert c.get("/app/calendar").json()["configured"] is False
