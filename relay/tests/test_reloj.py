"""Alma en el reloj: vinculación, API del reloj y de la APK, y mensajes body_* del robot (reloj.py)."""

import asyncio
import base64
import json
import os
import struct
import zlib

import pytest
from fastapi.testclient import TestClient

from alma_relay import app as app_module
from alma_relay import body, notify, reloj, settings, web


def almx(tag: bytes) -> bytes:
    raw = b"ALMX" + b"\x01\x00\x00\x00" + tag.ljust(24, b"\0")
    return raw + struct.pack("<I", zlib.crc32(raw) & 0xFFFFFFFF)


P_ROBOT, P_RELOJ = almx(b"robot"), almx(b"reloj")


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
    pushes = []
    notify.sender = lambda sub, payload: pushes.append(payload) or True
    client = TestClient(app_module.app)
    client.pushes = pushes
    c0 = client.get("/app/status")
    code = open(os.path.join(str(tmp_path), "setup_code.txt")).read().strip()
    assert client.post("/app/setup", json={"code": code, "password": "una-contraseña"}).status_code == 200
    assert c0.status_code == 200
    yield client
    notify.sender = None


def run(coro):
    return asyncio.run(coro)


def pair(c):
    code = c.post("/app/reloj/vincular").json()["code"]
    toks = c.post("/v1/vincular", json={"code": code}).json()
    return {"Authorization": f"Bearer {toks['reloj']}"}, {"Authorization": f"Bearer {toks['celular']}"}


def robot_send_pkg(kind, pkg, rpkg, **head):
    """El robot manda un paquete en trozos (como mem_backup)."""
    parts = [pkg[i:i + 10] for i in range(0, len(pkg), 10)]
    out = []
    for k, p in enumerate(parts):
        m = {"t": "body_pkg", "kind": kind, "seq": k, "last": int(k == len(parts) - 1),
             "data": base64.b64encode(p).decode()} | head
        out += run(reloj.on_robot(m, rpkg))
    return out


def test_vinculacion(c):
    anon = TestClient(app_module.app)
    assert anon.post("/app/reloj/vincular").status_code == 401
    assert c.post("/v1/vincular", json={"code": "12345678"}).status_code == 403
    code = c.post("/app/reloj/vincular").json()["code"]
    toks = c.post("/v1/vincular", json={"code": code}).json()
    assert set(toks) == {"reloj", "celular"}
    assert c.post("/v1/vincular", json={"code": code}).status_code == 403          # un solo uso
    h = {"Authorization": f"Bearer {toks['reloj']}"}
    assert c.get("/v1/reloj/comidas", headers=h).status_code == 200
    assert c.get("/v1/reloj/comidas", headers={"Authorization": "Bearer otra"}).status_code == 401
    raw = open(os.path.join(os.environ["ALMA_RELAY_DATA"], "settings.json"), encoding="utf-8").read()
    assert toks["reloj"] not in raw and toks["celular"] not in raw                 # solo hashes
    code2 = c.post("/app/reloj/vincular").json()["code"]
    solo = c.post("/v1/vincular", json={"code": code2, "solo": "reloj"}).json()
    assert set(solo) == {"reloj"}
    assert c.get("/v1/reloj/comidas", headers=h).status_code == 401                # la llave vieja del reloj ya no
    assert c.post("/v1/celular/hello", headers={"Authorization": f"Bearer {toks['celular']}"}).status_code == 200
    h = {"Authorization": f"Bearer {solo['reloj']}"}
    c.post("/app/reloj/desvincular")
    assert c.get("/v1/reloj/comidas", headers=h).status_code == 401


def test_sin_firmware_nuevo_no_hay_mudanzas(c):
    hr, hc = pair(c)
    r = c.post("/v1/mudanza", json={"mid": "m1", "to": "reloj"}, headers=hr).json()
    assert not r["ok"] and "firmware" in r["why"]
    d = c.post("/v1/reloj/hello", json={"n": 0}, headers=hr).json()
    assert d["directive"]["t"] == "absent" and d["where"]["robot_listo"] is False
    assert run(reloj.tick()) is False


def test_mudanza_completa_robot_reloj_robot(c):
    hr, hc = pair(c)
    rpkg = reloj.RobotPkg()
    out = run(reloj.on_robot({"t": "body_hello", "n": 1, "nonce": 7, "v": 1}, rpkg))
    assert out[0]["t"] == "body" and out[0]["d"] == "keep" and out[0]["nonce"] == 7
    assert out[0]["lease_s"] == body.ROBOT_LEASE_S
    res = robot_send_pkg("backup", P_ROBOT, rpkg, n=1, bseq=1)
    assert res[-1] == {"t": "body_pkg_result", "kind": "backup", "bseq": 1, "ok": True}

    r = c.post("/v1/mudanza", json={"mid": "m1", "to": "reloj"}, headers=hr).json()
    assert r["ok"] and {"t": "body_poke"} in web.hub.sent
    out = run(reloj.on_robot({"t": "body_hello", "n": 1, "nonce": 8}, rpkg))
    assert out[0]["d"] == "release" and out[0]["mid"] == "m1" and out[0]["n"] == 2 and out[0]["nonce"] == 8
    res = robot_send_pkg("release", P_ROBOT, rpkg, mid="m1")
    assert res[-1]["ok"]

    d = c.post("/v1/reloj/hello", json={"n": 0}, headers=hr).json()["directive"]
    assert d["t"] == "deliver" and base64.b64decode(d["pkg"]) == P_ROBOT and d["n"] == 2
    assert c.post("/v1/reloj/ack", json={"mid": "m1", "ok": True}, headers=hr).json()["ok"]
    w = c.get("/app/reloj").json()["where"]
    assert w["cuerpo"] == "reloj" and w["n"] == 2
    assert c.post("/v1/reloj/hello", json={"n": 2}, headers=hr).json()["directive"]["t"] == "keep"
    b64 = base64.b64encode(P_RELOJ).decode()
    assert c.post("/v1/reloj/backup", json={"n": 2, "seq": 1, "pkg": b64}, headers=hr).json()["ok"]
    assert c.post("/v1/reloj/backup", json={"n": 2, "seq": 1, "pkg": "AAAA"}, headers=hr).status_code == 400

    # regreso: el robot reconoce al dueño
    out = run(reloj.on_robot({"t": "body_move", "mid": "cara1"}, rpkg))
    assert out[0]["ok"]
    d = c.post("/v1/reloj/hello", json={"n": 2}, headers=hr).json()["directive"]
    assert d == {"t": "release", "mid": "cara1", "n": 3}
    assert c.post("/v1/reloj/release", json={"mid": "cara1", "pkg": b64}, headers=hr).json()["ok"]
    out = run(reloj.on_robot({"t": "body_hello", "n": 1, "nonce": 9}, rpkg))
    assert out[0]["d"] == "deliver" and out[0]["mid"] == "cara1"
    chunks = [m for m in out if m["t"] == "body_pkg_in"]
    assert b"".join(base64.b64decode(m["data"]) for m in chunks) == P_RELOJ and chunks[-1]["last"] == 1
    run(reloj.on_robot({"t": "body_ack", "mid": "cara1", "ok": True}, rpkg))
    assert c.get("/app/reloj").json()["where"]["cuerpo"] == "robot"


def test_rescate_solo_desde_celular_o_pwa(c):
    hr, hc = pair(c)
    rpkg = reloj.RobotPkg()
    run(reloj.on_robot({"t": "body_hello", "n": 1, "nonce": 1, "v": 1}, rpkg))
    assert c.post("/v1/mudanza", json={"to": "robot", "reason": "rescate"}, headers=hr).status_code == 403
    r = c.post("/v1/mudanza", json={"to": "robot", "reason": "rescate"}, headers=hc).json()
    assert not r["ok"] and r["why"] == "ya_esta"


def test_robot_desconectado_mueve_a_alma(c):
    hr, hc = pair(c)
    rpkg = reloj.RobotPkg()
    run(reloj.on_robot({"t": "body_hello", "n": 1, "nonce": 1, "v": 1}, rpkg, now=1000.0))
    robot_send_pkg("backup", P_ROBOT, rpkg, n=1, bseq=1)
    reloj.arb().s["seen"]["robot"] = 1000.0
    assert run(reloj.tick(now=1000.0 + body.ROBOT_OFFLINE_S + 1))
    d = c.post("/v1/reloj/hello", json={"n": 0}, headers=hr).json()["directive"]
    assert d["t"] == "deliver" and d["reason"] == "desconexion"


def test_robot_sin_alma_no_manda_su_animo(c):
    hr, hc = pair(c)
    web.hub.state = {"t": "state", "state": "ST_AWAKE", "simple_mood": "SM_SCARED", "wellbeing": 0, "age_days": 0,
                     "alma_here": False}
    r = c.post("/v1/reloj/hello", json={"n": 0}, headers=hr).json()["robot"]
    assert "mood" not in r and "wellbeing" not in r and "age_days" not in r and r["state"] == "ST_AWAKE"
    web.hub.state = dict(web.hub.state, alma_here=True, simple_mood="SM_HAPPY")
    assert c.post("/v1/reloj/hello", json={"n": 0}, headers=hr).json()["robot"]["mood"] == "SM_HAPPY"


def test_eventos_del_reloj_con_alma_en_el_robot(c):
    hr, hc = pair(c)
    r = c.post("/v1/reloj/evento", json={"id": "e1", "kind": "orden", "data": {"action_id": "dance"}}, headers=hr)
    assert r.json() == {"ok": True}
    assert {"t": "command", "action_id": "dance"} in web.hub.sent
    c.post("/v1/reloj/evento", json={"id": "e2", "kind": "caricia", "data": {"zona": "cabeza"}}, headers=hr)
    assert web.hub.sent[-1]["t"] == "remote" and web.hub.sent[-1]["kind"] == "caricia"
    assert c.post("/v1/reloj/evento", json={"id": "e3", "kind": "raro"}, headers=hr).status_code == 400


def test_voz_por_texto(c):
    hr, hc = pair(c)
    r = c.post("/v1/reloj/voz", json={"texto": "Alma, baila"}, headers=hr).json()
    assert r["action_id"] == "dance" and r["source"] == "rule" and r["robot"] is True
    t = c.get("/v1/reloj/ordenes", headers=hr).json()
    assert "baila" in t["actions"]["dance"] and "alma" in t["fillers"]


def test_celular_hello_y_apk(c):
    hr, hc = pair(c)
    assert c.post("/v1/celular/hello", headers=hc).json()["where"]["cuerpo"] == "robot"
    assert c.post("/v1/celular/hello", headers=hr).status_code == 401
    assert c.get("/app/apk").status_code == 404
    d = os.path.join(os.environ["ALMA_RELAY_DATA"], "apk")
    os.makedirs(d)
    open(os.path.join(d, "alma-celular.apk"), "wb").write(b"PK")
    assert c.get("/app/apk").status_code == 200
    assert TestClient(app_module.app).get("/app/apk").status_code == 401


def test_paseo_pasos_hitos_y_recuerdos(c):
    from alma_relay import care, milestones
    hr, hc = pair(c)
    rpkg = reloj.RobotPkg()
    run(reloj.on_robot({"t": "body_hello", "n": 1, "nonce": 1, "v": 1}, rpkg))
    robot_send_pkg("backup", P_ROBOT, rpkg, n=1, bseq=1)
    c.post("/v1/reloj/hello", json={"n": 0, "salud": {"pasos": 500}}, headers=hr)     # antes de salir: no cuenta
    c.post("/v1/mudanza", json={"mid": "m1", "to": "reloj"}, headers=hr)
    run(reloj.on_robot({"t": "body_hello", "n": 1, "nonce": 2}, rpkg))
    robot_send_pkg("release", P_ROBOT, rpkg, mid="m1")
    c.post("/v1/reloj/hello", json={"n": 0}, headers=hr)
    c.post("/v1/reloj/ack", json={"mid": "m1", "ok": True}, headers=hr)
    keys = [m["key"] for m in milestones.listing()["milestones"]]
    assert any("primer_paseo" in k for k in keys)
    c.post("/v1/reloj/hello", json={"n": 2, "salud": {"pasos": 1700, "pulso_alto": 1}}, headers=hr)
    keys = [m["key"] for m in milestones.listing()["milestones"]]
    assert any("mil_pasos" in k for k in keys)
    assert care.snapshot()["exercise"].get("pasear contigo", 0) >= 10                 # 1200 pasos ≈ 12 min
    s = reloj.today_summary()
    assert s["pasos_juntos"] == 1200 and s["salidas_en_el_reloj"] == 1 and s["el_dueño_se_agitó"]
    # regreso al robot: el robot recibe lo que vivió afuera
    run(reloj.on_robot({"t": "body_move", "mid": "cara1"}, rpkg))
    c.post("/v1/reloj/hello", json={"n": 2}, headers=hr)
    c.post("/v1/reloj/release", json={"mid": "cara1", "pkg": base64.b64encode(P_RELOJ).decode()}, headers=hr)
    run(reloj.on_robot({"t": "body_hello", "n": 1, "nonce": 3}, rpkg))
    out = run(reloj.on_robot({"t": "body_ack", "mid": "cara1", "ok": True}, rpkg))
    paseo = [m for m in out if m["t"] == "paseo"]
    assert paseo and paseo[0]["pasos"] == 1200 and paseo[0]["cansada"] is False


def test_mensajes_al_robot_no_pasan_de_48_eventos():
    d = {"t": "deliver", "mid": "m", "n": 2, "pkg": P_RELOJ, "meta": [{"id": f"e{i}"} for i in range(300)],
         "at": 0, "now": 0, "reason": "boton"}
    head = reloj.robot_out(d)[0]
    assert len(head["meta"]) == reloj.ROBOT_MAX_EVENTOS and head["meta"][-1]["id"] == "e299"
    k = reloj.robot_out({"t": "keep", "n": 2, "lease_s": 180, "events": [{"id": f"p{i}"} for i in range(100)]})[0]
    assert len(k["events"]) == reloj.ROBOT_MAX_EVENTOS and k["events"][0]["id"] == "p0"
    assert len(json.dumps(head)) < 16384
