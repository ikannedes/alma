"""El enlace del firmware (alma/firmware/f2/app/uplink.c, ws.c, link.c) contra este servidor de verdad (uvicorn), en la PC.

El binario lo compila alma/firmware/f2/test/build.sh (test/build/uplink_pc). Si no está, la prueba se salta.
"""

import os
import socket
import subprocess
import threading
import time

import httpx
import pytest
import uvicorn

from alma_relay import app as app_module
from alma_relay import haiku, notify, settings, web

F2 = os.path.join(os.path.dirname(__file__), "..", "..", "firmware", "f2")
EXE = os.path.join(F2, "test", "build", "uplink_pc" + (".exe" if os.name == "nt" else ""))
LINK_KEY = bytes(range(32, 64)).hex()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    web._fails.clear()
    web.hub = web.Hub()
    notify._last.clear()
    sent = []
    notify.sender = lambda sub, payload: sent.append(payload) or True
    monkeypatch.setattr(haiku, "night_report", lambda summary, previous, assets: {
        "journal_es": f"Día {summary.get('age_days')}: me acariciaron {summary['counts']['pets']} veces.",
        "trait_nudges": {"trait_energy": 0.005}, "composition": None, "tags": ["tranquilo"],
        "wellbeing_adjust": 4, "wellbeing_reason": "buen día"})
    port = _free_port()
    srv = uvicorn.Server(uvicorn.Config(app_module.app, host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    c = httpx.Client(base_url=f"http://127.0.0.1:{port}")
    c.get("/app/status")
    code = open(os.path.join(str(tmp_path), "setup_code.txt")).read().strip()
    assert c.post("/app/setup", json={"code": code, "password": "una-contraseña"}).status_code == 200
    c.post("/app/settings", json={"link_key": LINK_KEY})
    settings.update(anthropic_key="llave-de-prueba")   # night_report es un doble: no sale a la red
    c.post("/app/push/subscribe", json={"endpoint": "https://push.example/abc", "keys": {}})
    c.port, c.sent = port, sent
    yield c
    srv.should_exit = True
    th.join(5)
    notify.sender = None


@pytest.mark.skipif(not os.path.exists(EXE), reason="falta uplink_pc (alma/firmware/f2/test/build.sh)")
def test_firmware_link_end_to_end(server, monkeypatch):
    from alma_relay import care
    monkeypatch.setattr(care, "is_night", lambda now: False)   # los hitos no avisan de noche: la prueba no depende de la hora
    p = subprocess.Popen([EXE, "127.0.0.1", str(server.port), LINK_KEY, "6"], stdout=subprocess.PIPE, text=True,
                         encoding="utf-8")
    for _ in range(100):
        st = server.get("/app/state").json()
        if st.get("online") and st.get("state"):
            break
        time.sleep(0.05)
    assert st["online"] and st["state"]["state"] == "ST_AWAKE" and web.hub.robot_id == "alma-pc"
    assert server.post("/app/command", json={"action_id": "dance"}).json() == {"ok": True}
    out, _ = p.communicate(timeout=20)
    assert p.returncode == 0, out
    assert '<< {"t":"welcome"' in out
    assert '<< {"t":"command","action_id":"dance"}' in out
    assert '"t":"night_result"' in out and '"wellbeing_adjust":4' in out and "me acariciaron 4 veces" in out
    assert "fin: cerrada por el robot (autenticado 1)" in out
    evs = [e["ev"] for e in server.get("/app/state").json()["events"]]
    assert evs == ["new_face", "home_failed"]
    kinds = {x["kind"] for x in server.sent}
    assert kinds == {"new_face", "home_failed", "battery_critical", "sad", "milestone"}   # la cara nueva también es un hito


@pytest.mark.skipif(not os.path.exists(EXE), reason="falta uplink_pc (alma/firmware/f2/test/build.sh)")
def test_night_without_claude_key(server, monkeypatch):
    settings.update(anthropic_key="")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    p = subprocess.run([EXE, "127.0.0.1", str(server.port), LINK_KEY, "3"], capture_output=True, text=True,
                       encoding="utf-8", timeout=20)
    assert '<< {"t":"night_result","error":"falta la llave de Claude en la app"}' in p.stdout, p.stdout


@pytest.mark.skipif(not os.path.exists(EXE), reason="falta uplink_pc (alma/firmware/f2/test/build.sh)")
def test_firmware_link_wrong_key(server):
    p = subprocess.run([EXE, "127.0.0.1", str(server.port), bytes(32).hex(), "3"], capture_output=True, text=True,
                       encoding="utf-8", timeout=20)
    assert "fin: el servidor cerró (¿llave del enlace?) (autenticado 0)" in p.stdout, p.stdout
    assert p.returncode == 1 and not server.get("/app/state").json().get("online")


@pytest.mark.skipif(not os.path.exists(EXE), reason="falta uplink_pc (alma/firmware/f2/test/build.sh)")
def test_firmware_link_trozos_seguidos(server, monkeypatch, tmp_path):
    """Trozos de 9 KB sin pausa (la OTA y "subir", 2026-11-03): dos juntos en el búfer del robot no cortan el enlace."""
    monkeypatch.setattr(web, "OTA_PAUSE_S", 0)
    os.makedirs(os.path.join(str(tmp_path), "caras"), exist_ok=True)
    with open(os.path.join(str(tmp_path), "caras", "prueba.avi"), "wb") as f:
        f.write(os.urandom(5 * 9000))
    p = subprocess.Popen([EXE, "127.0.0.1", str(server.port), LINK_KEY, "6"], stdout=subprocess.PIPE, text=True,
                         encoding="utf-8")
    for _ in range(100):
        if server.get("/app/state").json().get("online"):
            break
        time.sleep(0.05)
    with open(os.path.join(str(tmp_path), "robot_cmd.txt"), "w", encoding="utf-8") as f:
        f.write("subir prueba.avi\n")
    out, _ = p.communicate(timeout=20)
    assert "frame demasiado grande" not in out, out[-500:]
    assert out.count('<< {"t":"cara","nombre":"prueba"') == 5
    assert "fin: cerrada por el robot (autenticado 1)" in out
