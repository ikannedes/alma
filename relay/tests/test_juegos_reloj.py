"""Juegos del reloj y Preguntas (juegos_reloj.py): banco de preguntas, nivel de Alma, API y el robot."""

import os
import random

import pytest
from fastapi.testclient import TestClient

from alma_relay import app as app_module
from alma_relay import juegos_reloj as jr
from alma_relay import notify, reloj, web


class FakeHub(web.Hub):
    def __init__(self):
        super().__init__()
        self.sent = []

    async def send(self, obj):
        self.sent.append(obj)
        return True


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    web._fails.clear()
    web.hub = FakeHub()
    reloj.reset_for_tests()
    notify._last.clear()
    notify.sender = lambda sub, payload: True
    client = TestClient(app_module.app)
    client.get("/app/status")
    code = open(os.path.join(str(tmp_path), "setup_code.txt")).read().strip()
    client.post("/app/setup", json={"code": code, "password": "una-contraseña"})
    yield client
    notify.sender = None


def llave_reloj(c):
    code = c.post("/app/reloj/vincular").json()["code"]
    return {"Authorization": "Bearer " + c.post("/v1/vincular", json={"code": code}).json()["reloj"]}


def test_banco_completo_y_valido():
    b = jr.banco()
    assert len(b) >= 500
    assert len({q["id"] for q in b}) == len(b)
    assert len({q["q"].lower() for q in b}) == len(b)                 # sin preguntas repetidas
    cats = {q["cat"] for q in b}
    assert cats <= set(jr.CATEGORIAS) and {"tecnologia", "programacion", "cultura_general"} <= cats
    assert all("¿" in q["q"] and q["q"].endswith("?") for q in b)


def test_lote_revuelve_y_no_repite(c):
    r = jr.lote(10, rng=random.Random(1))
    qs = r["preguntas"]
    assert len(qs) == 10 and r["total"] == len(jr.banco())
    orig = {q["id"]: q for q in jr.banco()}
    for q in qs:
        assert q["ops"][q["ok"]] == orig[q["id"]]["ops"][orig[q["id"]]["ok"]]   # la correcta sigue siendo la correcta
        assert "acierta" in q["alma"]
    r2 = jr.lote(10, rng=random.Random(2))
    assert not ({q["id"] for q in qs} & {q["id"] for q in r2["preguntas"]})   # no se repiten en 30 días


def test_mas_dificil_con_el_nivel():
    p0, p1 = jr._pesos(0.0), jr._pesos(1.0)
    assert p0[1] > p0[3] and p1[3] > p1[1]
    rnd = random.Random(3)
    q = {"dif": 2}
    fac = sum(jr.alma_responde(q, 0.0, rnd)["acierta"] for _ in range(2000))
    exp = sum(jr.alma_responde(q, 1.0, rnd)["acierta"] for _ in range(2000))
    assert exp > fac + 600


def test_api_y_nivel_que_sube(c):
    h = llave_reloj(c)
    assert TestClient(app_module.app).get("/v1/juegos").status_code == 401
    lista = c.get("/v1/juegos", headers=h).json()
    assert {j["id"] for j in lista["juegos"]} == set(jr.JUEGOS) and lista["preguntas"] >= 500
    ini = c.post("/v1/juegos/gato/empezar", headers=h).json()
    assert ini["ok"] and ini["nivel"] == "principiante"
    for _ in range(30):
        r = c.post("/v1/juegos/gato/evento", headers=h, json={"ganador": "owner", "segundos": 40}).json()
    assert r["nivel"]["partidas"] == 30 and r["nivel"]["skill"] > 0.3 and r["nivel"]["nivel"] != "principiante"
    assert c.post("/v1/juegos/gato/evento", headers=h, json={"ganador": "nadie"}).status_code == 400
    assert c.post("/v1/juegos/tetris/empezar", headers=h).status_code == 404
    # la app web juega Preguntas con la sesión
    assert c.get("/app/juegos/preguntas?n=5").json()["preguntas"]
    assert c.post("/app/juegos/preguntas/respuesta", json={"id": "cie-001", "acerto": True}).json() == {"ok": True}
    assert jr.today_summary()[0]["partidas"] == 30


def test_el_robot_reacciona_solo_si_alma_vive_en_el(c):
    h = llave_reloj(c)
    c.post("/v1/juegos/mosqueta/evento", headers=h, json={"ganador": "alma", "segundos": 60})
    tipos = [m.get("t") for m in web.hub.sent]
    assert "game_event" in tipos and "remote_play" in tipos
    web.hub.sent.clear()
    reloj.arb().s["holder"] = "reloj"                                  # Alma se fue al reloj
    c.post("/v1/juegos/mosqueta/evento", headers=h, json={"ganador": "owner", "segundos": 60})
    assert web.hub.sent == []                                         # el reloj lo aplica a su núcleo


def test_alma_puede_no_querer(c, monkeypatch):
    from alma_relay import play
    h = llave_reloj(c)
    monkeypatch.setattr(play, "refuse_reason", lambda st: "Alma está enferma y no tiene ganas de jugar ahorita.")
    r = c.post("/v1/juegos/pingpong/empezar", headers=h).json()
    assert not r["ok"] and "enferma" in r["razon"]
