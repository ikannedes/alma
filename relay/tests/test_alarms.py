"""Alarmas del dueño (alarms.py y web.py; 2026-10-30). Sin red."""

import asyncio
import datetime as dt

from alma_relay import alarms, web
from tests.test_web import _setup, c  # noqa: F401  (fixture del servidor)

MX = alarms.ZoneInfo("America/Mexico_City")


def at(y, mo, d, h, mi):   # hora local de México → UTC
    return dt.datetime(y, mo, d, h, mi, tzinfo=MX).astimezone(dt.timezone.utc)


def test_alarms_ring_once_on_their_days(c, monkeypatch):  # noqa: F811
    _setup(c)
    c.post("/app/push/subscribe", json={"endpoint": "https://push.example/abc", "keys": {}})
    assert c.post("/app/alarms", json={"time": "25:00"}).status_code == 400
    diaria = c.post("/app/alarms", json={"time": "07:30", "days": [0, 1, 2, 3, 4], "label": "Despertar"}).json()
    una = c.post("/app/alarms", json={"time": "15:00", "label": "Junta"}).json()
    to_robot = []

    async def fake_send(obj):
        to_robot.append(obj)
        return True
    monkeypatch.setattr(web.hub, "send", fake_send)
    lunes = (2026, 11, 2)   # lunes
    assert asyncio.run(web._alarms_tick(at(*lunes, 7, 29))) == []
    assert [a["id"] for a in asyncio.run(web._alarms_tick(at(*lunes, 7, 30)))] == [diaria["id"]]
    assert asyncio.run(web._alarms_tick(at(*lunes, 7, 31))) == []            # una sola vez por día
    assert to_robot[-1] == {"t": "reminder", "title": "Despertar", "minutes": 0, "at": "07:30"}
    assert any(p["title"] == "⏰ Despertar" for p in c.sent)
    assert asyncio.run(web._alarms_tick(at(2026, 11, 7, 7, 30))) == []        # sábado: no
    assert [a["id"] for a in asyncio.run(web._alarms_tick(at(2026, 11, 3, 7, 31)))] == [diaria["id"]]   # martes, 1 min tarde
    assert [a["id"] for a in asyncio.run(web._alarms_tick(at(*lunes, 15, 0)))] == [una["id"]]
    v = c.get("/app/alarms").json()
    assert v["timezone"] == "America/Mexico_City"
    junta = next(a for a in v["alarms"] if a["id"] == una["id"])
    assert junta["enabled"] is False and junta["next"] is None                # la de una vez se apaga sola
    assert c.post(f"/app/alarms/{una['id']}", json={"enabled": True}).json()["enabled"] is True
    assert c.post(f"/app/alarms/{diaria['id']}", json={"time": "08:00"}).json()["time"] == "08:00"
    assert c.delete(f"/app/alarms/{una['id']}").json() == {"ok": True}
    assert [a["label"] for a in c.get("/app/alarms").json()["alarms"]] == ["Despertar"]
    assert any(e["ev"] == "reminder" for e in c.get("/app/state").json()["events"])


def test_next_ring_and_test_button(c):  # noqa: F811
    _setup(c)
    a = {"time": "07:30", "days": [5, 6], "enabled": True}
    assert alarms.next_ring(a, at(2026, 11, 2, 9, 0)) == "2026-11-07T07:30"   # del lunes al sábado
    c.post("/app/push/subscribe", json={"endpoint": "https://push.example/abc", "keys": {}})
    assert c.post("/app/alarm-test").json() == {"pushed": 1, "robot": False}
    c.post("/app/logout")
    assert c.get("/app/alarms").status_code == 401
