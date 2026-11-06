"""La Home Station con alma-base (/v1/base; dueño, 2026-11-06): enlace, registro, órdenes y OTA."""

import hashlib
import os
import time

import pytest
from fastapi.testclient import TestClient

from alma_relay import app as app_module
from alma_relay import link, notify, robot_debug, web

LINK_KEY = bytes(range(32))


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    monkeypatch.setattr(web, "OTA_PAUSE_S", 0)
    web._fails.clear()
    web.hub = web.Hub()
    web.base_hub = web.Hub()
    notify.sender = lambda sub, payload: True
    client = TestClient(app_module.app)
    client.get("/app/status")
    code = open(os.path.join(str(tmp_path), "setup_code.txt")).read().strip()
    client.post("/app/setup", json={"code": code, "password": "una-contraseña"})
    client.post("/app/settings", json={"link_key": LINK_KEY.hex()})
    yield client
    notify.sender = None


def _base(c, path="/v1/robot"):
    ws = c.websocket_connect(path).__enter__()
    ns = ws.receive_bytes()[1:]
    nr, frame = link.make_auth(LINK_KEY, ns, "base")
    ws.send_bytes(frame)
    return ws, link.Session(link.session_key(LINK_KEY, ns, nr), i_am_server=False)


def _log(tmp):
    p = os.path.join(os.environ["ALMA_RELAY_DATA"], "base_log.txt")
    return open(p, encoding="utf-8").read() if os.path.exists(p) else ""


def _wait(cond):
    for _ in range(300):   # hasta 6 s: con toda la suite corriendo, el cierre tarda más
        if cond():
            return True
        time.sleep(0.02)
    return False


def test_base_saluda_registra_y_recibe_ordenes(c):
    ws, s = _base(c)
    assert s.open(ws.receive_bytes())["t"] == "welcome"
    ws.send_bytes(s.seal({"t": "log", "s": "[ 1.0] alma-base 0.1.0\n[ 1.1] carga: EMO se está cargando\n"}))
    ws.send_bytes(s.seal({"t": "state", "carga": 1, "toques": 0}))
    assert _wait(lambda: "carga: EMO se está cargando" in _log(c))
    assert "servidor: base conectada (base)" in _log(c)
    assert _wait(lambda: web.base_hub.state.get("carga") == 1)
    with open(os.path.join(os.environ["ALMA_RELAY_DATA"], "base_cmd.txt"), "w") as f:
        f.write("anim prueba\nleds off\nanim ../malo\nkey C\n")
    assert s.open(ws.receive_bytes()) == {"t": "anim", "n": "prueba"}
    assert s.open(ws.receive_bytes()) == {"t": "leds_off"}
    ws.__exit__(None, None, None)
    assert _wait(lambda: "servidor: base desconectada" in _log(c))
    assert web.hub.ws is None   # el robot no se enteró de nada


def test_base_ota_por_trozos(c):
    d = os.environ["ALMA_RELAY_DATA"]
    os.makedirs(os.path.join(d, "ota"))
    data = os.urandom(9000)
    open(os.path.join(d, "ota", "alma-base_x.bin"), "wb").write(data)
    sha = hashlib.sha256(data).hexdigest()
    ws, s = _base(c)
    s.open(ws.receive_bytes())
    open(os.path.join(d, "base_cmd.txt"), "w").write(f"ota alma-base_x.bin {sha}\n")
    m = s.open(ws.receive_bytes())
    assert m["t"] == "ota_begin" and m["size"] == 9000 and m["sha256"] == sha
    ws.send_bytes(s.seal({"t": "ota_ready"}))
    got = b""
    while True:
        m = s.open(ws.receive_bytes())
        import base64
        got += base64.b64decode(m["b64"])
        if m["last"]:
            break
    assert got == data
    assert _wait(lambda: "trozos enviados" in _log(c))
    ws.__exit__(None, None, None)


def test_ordenes_de_la_base_rechazan_lo_raro(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    (tmp_path / "base_cmd.txt").write_text("anim fuegos\nanim nombre_demasiado_largo\nota ../x.bin abc\nanims\n"
                                           "comp 15 0 60\ncomp 1 2\ncomp 0 0 999\ncomp 15 0 120 200\n"
                                           "pong\npong stop\npong ya\nmusica\n")
    assert robot_debug.base_take_cmds() == [{"t": "anim", "n": "fuegos"}, {"t": "anims"},
                                            {"t": "comp", "r": 15, "g": 0, "b": 60},
                                            {"t": "comp", "r": 15, "g": 0, "b": 120, "e": 200},
                                            {"t": "pong"}, {"t": "pong_stop"}, {"t": "musica"}]
    assert not (tmp_path / "base_cmd.txt").exists()


def test_base_tambien_por_su_propia_ruta(c):
    ws, s = _base(c, "/v1/base")
    assert s.open(ws.receive_bytes())["t"] == "welcome"
    assert _wait(lambda: web.base_hub.ws is not None) and web.hub.ws is None
    ws.__exit__(None, None, None)

