"""Hitos de Alma (milestones.py; dueño, 2026-11-01: "no se nota que crezca")."""

import datetime as dt

from alma_relay import alarms, milestones, notify
from tests.test_web import _setup, c  # noqa: F401

TR = {"trait_boldness": 0.49, "trait_energy": 0.39, "trait_sociability": 0.61, "trait_playfulness": 0.23,
      "trait_impulsivity": 0.32}


def _at(h: int, day: int = 2) -> float:
    return dt.datetime(2026, 11, day, h, 0, tzinfo=alarms.tz()).timestamp()


def _st(age, **tr):
    return {"t": "state", "age_days": age, "traits": TR | tr}


def test_cumpleanos_y_aviso_de_dia(c):  # noqa: F811
    _setup(c)
    notify.subscribe({"endpoint": "https://x"})
    assert milestones.on_state(_st(6), now=_at(12)) == []
    assert milestones.on_state(_st(7), now=_at(23)) == ["edad_7"]       # de noche: se guarda, no avisa
    assert not c.sent
    assert milestones.on_state(_st(7), now=_at(23, 2) + 60) == []
    milestones.on_state(_st(7), now=_at(8, 3) + 60)                       # a las 8 llega el aviso
    assert [p["title"] for p in c.sent] == ["🐣 ¡Alma cumple 1 semana!"]
    milestones.on_state(_st(8), now=_at(12, 3))
    assert len(c.sent) == 1                                               # una sola vez
    r = c.get("/app/milestones").json()
    assert r["age_days"] == 8 and r["next"] == {"days": 30, "name": "1 mes", "left": 22}
    assert [m["title"] for m in r["milestones"]] == ["¡Alma cumple 1 semana!"]
    assert milestones.recent(_at(22, 2)) == ["¡Alma cumple 1 semana!"]   # para el diario


def test_saltos_y_anos(c):  # noqa: F811
    _setup(c)
    milestones.on_state(_st(3), now=_at(12))
    assert milestones.on_state(_st(400), now=_at(13)) == ["edad_7", "edad_30", "edad_182", "edad_365"]   # respaldo restaurado
    assert milestones.on_state(_st(730), now=_at(14)) == ["edad_730"]
    assert c.get("/app/milestones").json()["next"] == {"days": 1095, "name": "3 años", "left": 365}


def test_personalidad_y_memoria_borrada(c):  # noqa: F811
    _setup(c)
    milestones.on_state(_st(10), now=_at(12))                              # primera vez: solo la base
    assert milestones.on_state(_st(11, trait_playfulness=0.27), now=_at(13)) == []
    new = milestones.on_state(_st(12, trait_playfulness=0.29, trait_boldness=0.43), now=_at(14))
    titles = [m["title"] for m in c.get("/app/milestones").json()["milestones"]]
    assert len(new) == 2 and "Alma se está volviendo más juguetona" in titles and "Alma se está volviendo más prudente" in titles
    assert milestones.on_state(_st(13, trait_playfulness=0.31, trait_boldness=0.43), now=_at(15)) == []   # cuenta desde el último cambio
    assert milestones.on_state(_st(0, trait_playfulness=0.9), now=_at(16)) == []     # robot nuevo: no es un cambio
    assert milestones.on_state(_st(1, trait_playfulness=0.9), now=_at(17)) == []


def test_aprende_una_cara_por_el_enlace(c):  # noqa: F811
    _setup(c)
    milestones.on_robot_message({"t": "event", "ev": "new_face", "name": "Ana"}, now=_at(12))
    milestones.on_robot_message({"t": "event", "ev": "new_face", "name": "Ana"}, now=_at(13))
    assert milestones.learned("truco_saluda", "Alma aprendió a saludar", "…", now=_at(14))
    assert not milestones.learned("truco_saluda", "Alma aprendió a saludar", "…", now=_at(15))
    r = c.get("/app/milestones").json()["milestones"]
    assert [m["title"] for m in r] == ["Alma aprendió a saludar", "Alma aprendió a reconocer a Ana"]
    assert [n["title"] for n in c.get("/app/notifications").json()["notifications"]] == [
        "💡 Alma aprendió a saludar", "👤 Alma aprendió a reconocer a Ana"]
    c.post("/app/logout")
    assert c.get("/app/milestones").status_code == 401
