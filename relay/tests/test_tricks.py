"""Trucos de Alma (tricks.py; dueño, 2026-11-01): enseñar, pedir, practicar y olvidar."""

import asyncio
import time
import random

import pytest

from alma_relay import milestones, notify, tricks, web
from tests.test_web import _setup, c  # noqa: F401

ST = {"state": "ST_AWAKE", "simple_mood": "SM_HAPPY",
      "traits": {"trait_playfulness": 0.6, "trait_sociability": 0.5, "trait_impulsivity": 0.0}}
DAY = 86400
T0 = 1_800_000_000


@pytest.fixture(autouse=True)
def _sin_fijos(monkeypatch, request):
    """Las pruebas de enseñar cuentan solo lo enseñado; los trucos fijos tienen la suya."""
    if "fijo" not in request.node.name:
        monkeypatch.setattr(tricks, "FIJOS", {})


def test_truco_fijo_darth_vader():
    """Dueño, 2026-11-03: "que ya exista, que ya esté entrenado"."""
    tricks.rng = random.Random(9)
    v = [t for t in tricks.listing(T0)["tricks"] if t["name"] == "darth vader"][0]
    assert v["status"] == "dominado" and v["mot"] == "vader" and "marcha imperial" in v["move"]
    grumpy = ST | {"simple_mood": "SM_GRUMPY"}
    assert {tricks.perform("Darth Vader", grumpy, T0)["outcome"] for _ in range(50)} == {"bien"}
    assert tricks.perform("darth vader", ST, T0)["mot"] == "vader"
    assert tricks.perform("darth vader", ST | {"state": "ST_SLEEPING"}, T0)["error"] == "ahora no: está dormida"
    assert tricks.forget_due(T0 + 400 * DAY) == [] and tricks.listing(T0 + 400 * DAY)["tricks"][0]["strength"] == 1.0
    assert tricks.remove("Darth Vader") is False
    assert tricks.lesson_start("darth vader", T0) == {"error": "ese truco ya lo sabe"}
    tricks.lesson_start("rana", T0)
    for _ in range(40):                       # en las clases nunca lo intenta: no es del catálogo
        assert tricks.lesson_try(ST, T0)["mot"] != "vader"


def _teach(name="Gatito", now=T0):
    """Como el dueño: 👍 solo cuando hace el movimiento que quiere (el primero que intentó), 👎 a lo demás."""
    tricks.lesson_start(name, now)
    target, r = None, None
    for _ in range(60):
        t = tricks.lesson_try(ST, now)
        target = target or t["mot"]
        tricks.lesson_did(t["mot"], now)
        r = tricks.lesson_answer("si" if t["mot"] == target else "no", ST, now=now)
        if r.get("learned"):
            return r
    return r


def test_aprende_con_aciertos_y_queda_el_hito(c):  # noqa: F811
    _setup(c)
    tricks.rng = random.Random(1)
    tricks.lesson_start("Gatito", T0)
    first = tricks.lesson_try(ST, T0)["mot"]
    tricks.lesson_did(first, T0)
    r = tricks.lesson_answer("no", ST, now=T0)                       # 👎: prueba otra cosa
    assert r["trick"] is None
    second = tricks.lesson_try(ST, T0)["mot"]
    assert second != first
    tricks.lesson_did(second, T0)
    r = tricks.lesson_answer("si", ST, now=T0)
    assert not r["learned"] and r["trick"]["mot"] == second and r["trick"]["status"] == "aprendiendo"
    learned = False
    for _ in range(4):                                               # con lo que sabe, casi siempre repite el bueno
        t = tricks.lesson_try(ST, T0)
        tricks.lesson_did(t["mot"], T0)
        learned = learned or tricks.lesson_answer("si", ST, now=T0).get("learned")
        if learned:
            break
    assert learned
    lst = tricks.listing(T0)
    assert lst["lesson"] is None and lst["tricks"][0]["label"] == "Gatito" and lst["tricks"][0]["status"] == "aprendido"
    assert "Alma aprendió «Gatito»" in [m["title"] for m in milestones.listing()["milestones"]]


def test_premio_aprende_mas_rapido():
    tricks.rng = random.Random(2)
    got = {}
    for name, ans, ok in (("a", "si", False), ("b", "premio", True), ("c", "premio", False)):
        tricks.lesson_start(name, T0)
        tricks.lesson_did(tricks.lesson_try(ST, T0)["mot"], T0)
        got[name] = tricks.lesson_answer(ans, ST, treat_ok=ok, now=T0)["trick"]["strength"]
    assert got["b"] > got["a"] == got["c"]   # si no se comió la galleta, cuenta como un 👍 normal


def test_obedece_segun_lo_que_sabe_y_el_animo():
    tricks.rng = random.Random(3)
    _teach("gatito")
    assert tricks.perform("Gatito", ST, T0)["outcome"] in ("bien", "equivocada", "no_quiere")
    outs = [tricks.perform("gatito", ST, T0)["outcome"] for _ in range(200)]
    grumpy = [tricks.perform("gatito", ST | {"simple_mood": "SM_GRUMPY"}, T0)["outcome"] for _ in range(200)]
    assert outs.count("bien") > grumpy.count("bien") + 40
    assert tricks.perform("gatito", ST | {"state": "ST_SLEEPING"}, T0)["error"] == "ahora no: está dormida"
    assert tricks.perform("perrito", ST, T0)["error"] == "ese truco todavía no lo sabe"


def test_sin_tope_y_cada_truco_su_movimiento():
    tricks.rng = random.Random(4)
    for i in range(12):
        _teach(f"truco {i}")
    ts = tricks.listing(T0)["tricks"]
    assert len(ts) == 12 and len({t["mot"] for t in ts}) == 12


def test_se_olvida_sin_practica_y_avisa(c):  # noqa: F811
    _setup(c)
    notify.subscribe({"endpoint": "https://x"})
    tricks.rng = random.Random(5)
    _teach("saluda")
    s0 = tricks.listing(T0)["tricks"][0]["strength"]
    assert tricks.listing(T0 + 6 * DAY)["tricks"][0]["strength"] == s0           # una semana de gracia
    later = tricks.listing(T0 + 12 * DAY)["tricks"][0]
    assert later["strength"] < s0 and later["status"] == "se le está olvidando"
    assert tricks.forget_due(T0 + 12 * DAY) == []
    tricks.praise("saluda", T0 + 12 * DAY)                                         # practicar lo recupera
    assert tricks.listing(T0 + 12 * DAY)["tricks"][0]["status"] == "aprendido"
    assert tricks.forget_due(T0 + 60 * DAY) == ["saluda"]
    assert tricks.listing(T0 + 60 * DAY)["tricks"] == []
    assert [p["title"] for p in c.sent] == ["Alma olvidó un truco 🍂"]


def test_dominado_olvida_mas_lento():
    tricks.rng = random.Random(6)
    _teach("baila")
    for k in range(1, 4):
        r = tricks.praise("baila", T0 + k * DAY)
        for _ in range(3):
            r = tricks.praise("baila", T0 + k * DAY)
    assert r["trick"]["status"] == "dominado"
    t = T0 + 3 * DAY + 40 * DAY
    assert tricks.forget_due(t) == [] and tricks.listing(t)["tricks"][0]["strength"] > tricks.FORGET


def test_rutas_con_el_robot(c, monkeypatch):  # noqa: F811
    _setup(c)
    tricks.rng = random.Random(7)
    web.hub.state = dict(ST)
    sent = []

    class WS:
        pass
    web.hub.ws = WS()

    async def fake_send(m):
        sent.append(m)
        if m.get("t") == "trick":   # el robot contesta que lo hizo
            asyncio.get_running_loop().call_soon(lambda: web.hub.pending.pop(m["req"]).set_result(
                {"t": "trick_result", "req": m["req"], "done": True}))
        return True
    monkeypatch.setattr(web.hub, "send", fake_send)
    r = c.post("/app/tricks/lesson", json={"name": "Gatito"}).json()
    assert r["tried"] and r["lesson"]["current"] == sent[-1]["mot"]
    r = c.post("/app/tricks/answer", json={"answer": "no"}).json()
    assert r["next"]["tried"] and len([m for m in sent if m["t"] == "trick"]) == 2
    r = c.post("/app/tricks/answer", json={"answer": "si"}).json()
    assert r["trick"]["label"] == "Gatito" and not r["learned"]
    assert r["next"]["tried"] and len([m for m in sent if m["t"] == "trick"]) == 3   # 👍 sin aprenderlo: lo intenta otra vez
    r2 = c.post("/app/tricks/answer", json={"answer": "si"})                            # la clase no se traba
    assert r2.status_code == 200
    assert c.post("/app/tricks/answer", json={"answer": "premio"}).status_code == 409   # sin comida nueva
    assert c.post("/app/tricks/gatito/do").status_code == (200 if r2.json()["learned"] else 409)
    c.post("/app/tricks/end")
    web.hub.ws = None
    assert c.post("/app/tricks/lesson", json={"name": "x"}).json()["error"] == "Alma no está conectada"
    assert c.delete("/app/tricks/gatito").json() == {"ok": True}
    c.post("/app/logout")
    assert c.get("/app/tricks").status_code == 401


def test_sin_firmware_el_robot_no_contesta(c, monkeypatch):  # noqa: F811
    _setup(c)
    web.hub.state = dict(ST)
    web.hub.ws = object()
    monkeypatch.setattr(web, "TRICK_WAIT_S", 0.05)

    async def fake_send(m):
        return True
    monkeypatch.setattr(web.hub, "send", fake_send)
    r = c.post("/app/tricks/lesson", json={"name": "Gatito"})
    web.hub.ws = None
    assert r.status_code == 409 and "firmware" in r.json()["error"]


def test_caricia_despues_del_truco_cuenta_como_muy_bien(c):  # noqa: F811
    _setup(c)
    tricks.rng = random.Random(3)
    _teach("Gatito", now=time.time())
    times = lambda: tricks._load()["tricks"]["gatito"]["times"]   # noqa: E731
    t0 = times()
    web.hub.trick_ok = ("gatito", time.time())
    web._pet_after_trick()
    assert times() == t0 + 1 and web.hub.events[-1]["ev"] == "trick_pet"
    web._pet_after_trick()                                          # otra caricia: ya no cuenta
    assert times() == t0 + 1
    web.hub.trick_ok = ("gatito", time.time() - web.TRICK_PET_S - 1)   # muy tarde
    web._pet_after_trick()
    assert times() == t0 + 1
