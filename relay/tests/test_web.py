"""App del dueño (contraseña, llaves, push) y enlace cifrado del robot (2026-10-30)."""

import os

import pytest
from fastapi.testclient import TestClient

from alma_relay import app as app_module
from alma_relay import link, notify, settings, web

LINK_KEY = bytes(range(32))


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    web._fails.clear()
    web.hub = web.Hub()
    notify._last.clear()
    sent = []
    notify.sender = lambda sub, payload: sent.append(payload) or True
    client = TestClient(app_module.app)
    client.sent = sent
    yield client
    notify.sender = None


def _setup(c, pw="una-contraseña"):
    c.get("/app/status")
    code = open(os.path.join(os.environ["ALMA_RELAY_DATA"], "setup_code.txt")).read().strip()
    return c.post("/app/setup", json={"code": code, "password": pw})


def test_setup_needs_the_console_code(c):
    assert c.get("/app/status").json()["setup_needed"]
    assert c.post("/app/setup", json={"code": "adivinado", "password": "12345678"}).status_code == 403
    assert _setup(c).status_code == 200
    assert not c.get("/app/status").json()["setup_needed"]
    assert c.post("/app/setup", json={"code": "x", "password": "12345678"}).status_code == 403   # ya no hay código


def test_everything_needs_login(c):
    _setup(c)
    anon = TestClient(app_module.app)
    for path in ("/app/state", "/app/settings"):
        assert anon.get(path).status_code == 401
    assert anon.post("/app/command", json={"action_id": "dance"}).status_code == 401
    assert anon.post("/app/login", json={"password": "mala"}).status_code == 403
    assert anon.post("/app/login", json={"password": "una-contraseña"}).status_code == 200
    assert anon.get("/app/state").status_code == 200


def test_login_attempts_are_limited(c):
    _setup(c)
    anon = TestClient(app_module.app)
    for _ in range(web.LOGIN_FAILS):
        anon.post("/app/login", json={"password": "mala"})
    assert anon.post("/app/login", json={"password": "una-contraseña"}).status_code == 429


def test_keys_are_never_returned(c):
    _setup(c)
    r = c.post("/app/settings", json={"anthropic_key": "sk-ant-secreta", "link_key": LINK_KEY.hex()})
    assert r.status_code == 200 and "sk-ant-secreta" not in r.text
    s = c.get("/app/settings")
    assert s.json()["anthropic_key"] is True and s.json()["link_key"] is True and "sk-ant" not in s.text
    assert settings.get("anthropic_key") == "sk-ant-secreta"
    assert c.post("/app/settings", json={"link_key": "corta"}).status_code == 400


def _robot(c, key=LINK_KEY):
    ws = c.websocket_connect("/v1/robot").__enter__()
    h = ws.receive_bytes()
    assert h[:1] == b"H"
    ns = h[1:]
    nr, frame = link.make_auth(key, ns, "emo-1")
    ws.send_bytes(frame)
    return ws, link.Session(link.session_key(key, ns, nr), i_am_server=False)


def test_robot_link_state_and_command(c):
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex()})
    c.post("/app/push/subscribe", json={"endpoint": "https://push.example/abc", "keys": {}})
    ws, sess = _robot(c)
    assert sess.open(ws.receive_bytes())["t"] == "welcome"
    ws.send_bytes(sess.seal({"t": "state", "state": "ST_AWAKE", "battery_pct": 80, "wellbeing": 100, "power": "usb"}))
    ws.send_bytes(sess.seal({"t": "event", "ev": "new_face", "name": "amigo_1"}))
    import time
    for _ in range(50):
        if c.get("/app/state").json()["events"]:
            break
        time.sleep(0.02)
    st = c.get("/app/state").json()
    assert st["online"] and st["state"]["state"] == "ST_AWAKE" and st["events"][-1]["ev"] == "new_face"
    assert any(p["kind"] == "new_face" for p in c.sent)
    assert c.post("/app/command", json={"action_id": "dance"}).json() == {"ok": True}
    assert sess.open(ws.receive_bytes()) == {"t": "command", "action_id": "dance"}
    ws.__exit__(None, None, None)


def test_wrong_key_is_rejected(c):
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex()})
    ws = c.websocket_connect("/v1/robot").__enter__()
    ns = ws.receive_bytes()[1:]
    _, frame = link.make_auth(bytes(32), ns, "intruso")
    ws.send_bytes(frame)
    with pytest.raises(Exception):
        ws.receive_bytes()
    assert c.post("/app/command", json={"action_id": "dance"}).status_code == 409


def test_session_rejects_replay_and_tampering():
    k = os.urandom(32)
    robot, server = link.Session(k, False), link.Session(k, True)
    f = robot.seal({"t": "state"})
    assert server.open(f) == {"t": "state"}
    with pytest.raises(link.LinkError):
        server.open(f)   # repetido
    g = bytearray(robot.seal({"t": "x"}))
    g[-1] ^= 1
    with pytest.raises(link.LinkError):
        server.open(bytes(g))   # alterado
    with pytest.raises(link.LinkError):
        link.Session(k, False).open(robot.seal({"t": "y"}))   # mismo sentido: no se acepta su propio frame


def test_notification_rules():
    notify._last.clear()
    sent = []
    notify.sender = lambda sub, p: sent.append(p) or True
    settings_subs = [{"endpoint": "https://x"}]
    try:
        notify.settings.load = lambda: {"subscriptions": settings_subs}
        assert notify.on_robot_message({"t": "event", "ev": "home_failed", "battery_pct": 12}, now=1000) == ["home_failed"]
        assert notify.on_robot_message({"t": "event", "ev": "home_failed", "battery_pct": 12}, now=1100) == []   # espera
        assert notify.on_robot_message({"t": "state", "battery_pct": 8, "power": "battery", "wellbeing": -500}, now=2000) == ["battery_critical", "sad"]
        assert notify.on_robot_message({"t": "state", "battery_pct": 8, "power": "home_station"}, now=9000) == []
    finally:
        notify.sender = None
        import importlib
        importlib.reload(settings)
        notify.settings = settings


def test_notifications_history(c):
    """Avisos (dueño, 2026-11-01): la app lista todo lo mandado, aunque el teléfono ya lo haya cerrado."""
    _setup(c)
    notify.subscribe({"endpoint": "https://x"})
    assert notify.on_robot_message({"t": "event", "ev": "falls"}, now=1000) == ["falls"]
    assert notify.on_robot_message({"t": "event", "ev": "falls"}, now=1100) == []          # en espera: no se repite
    notify.push("game", "🎲 Ya jugué", "Te toca.", now=2000, url="/play/x/")
    c.post("/app/push/test")                                                                # la prueba no se guarda
    n = c.get("/app/notifications").json()["notifications"]
    assert [(x["kind"], x["at"]) for x in n] == [("game", 2000), ("falls", 1000)]
    assert n[0]["url"] == "/play/x/" and n[1]["title"] == "Alma tuvo varios sustos" and n[1]["sent"] == 1
    notify.unsubscribe("https://x")
    notify.push("sick", "Alma se enfermó", "…", now=3000)                                   # sin teléfono: igual queda
    assert c.get("/app/notifications").json()["notifications"][0]["sent"] == 0
    for i in range(notify.KEEP + 5):
        notify.push("reminder", f"⏰ {i}", "", now=4000 + i)
    n = c.get("/app/notifications").json()["notifications"]
    assert len(n) == notify.KEEP and n[0]["title"] == f"⏰ {notify.KEEP + 4}"
    c.post("/app/logout")
    assert c.get("/app/notifications").status_code == 401


def test_real_webpush_signs_and_encrypts(c, monkeypatch):
    """Por pywebpush de verdad (sin el doble), con el POST interceptado: la llave VAPID guardada en PEM sirve."""
    import base64

    import requests
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    notify.sender = None
    cli = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": b64(cli), "auth": b64(os.urandom(16))}}
    posts = []

    class Resp:
        status_code, reason, text, headers = 201, "Created", "", {}

    monkeypatch.setattr(requests, "post", lambda url, **kw: posts.append((url, kw)) or Resp())
    _setup(c)
    assert c.post("/app/push/subscribe", json=sub).json() == {"ok": True}
    assert c.post("/app/push/test").json() == {"sent": 1}
    url, kw = posts[0]
    _, pub = notify.vapid_keys()
    assert url == sub["endpoint"] and kw["headers"]["authorization"].startswith("vapid t=")
    assert f"k={pub}" in kw["headers"]["authorization"] and kw["headers"]["content-encoding"] == "aes128gcm"


def test_push_failure_is_not_a_500(c, monkeypatch):
    import requests

    notify.sender = None
    monkeypatch.setattr(requests, "post", lambda url, **kw: (_ for _ in ()).throw(requests.ConnectionError("sin red")))
    _setup(c)
    c.post("/app/push/subscribe", json={"endpoint": "https://push.example/x", "keys": {"p256dh": "x", "auth": "y"}})
    r = c.post("/app/push/test")
    assert r.status_code == 200 and r.json() == {"sent": 0}


def test_session_survives_restart(c):
    """Las sesiones viven en settings.json: un reinicio del servidor no cierra la del dueño (2026-10-30)."""
    _setup(c)
    assert c.get("/app/status").json()["logged_in"]
    raw = open(os.path.join(os.environ["ALMA_RELAY_DATA"], "settings.json")).read()
    assert c.cookies.get("alma_session") not in raw   # solo el hash, no la cookie
    fresh = TestClient(app_module.app, cookies={"alma_session": c.cookies.get("alma_session")})
    assert fresh.get("/app/status").json()["logged_in"]
    c.post("/app/logout")
    assert not fresh.get("/app/status").json()["logged_in"]


def test_push_check_and_unsubscribe(c):
    _setup(c)
    ep = {"endpoint": "https://push.example/telefono"}
    assert c.post("/app/push/check", json=ep).json() == {"subscribed": False}
    c.post("/app/push/subscribe", json=ep | {"keys": {}})
    assert c.post("/app/push/check", json=ep).json() == {"subscribed": True}
    assert c.post("/app/push/unsubscribe", json=ep).json() == {"ok": True}
    assert c.post("/app/push/check", json=ep).json() == {"subscribed": False}
    c.post("/app/logout")
    assert c.post("/app/push/check", json=ep).status_code == 401


def test_offline_notice_once_until_back(c):
    _setup(c)
    c.post("/app/push/subscribe", json={"endpoint": "https://push.example/abc", "keys": {}})
    web.hub.last_seen, web.hub.state = 1000.0, {"battery_pct": 37}
    assert web._offline_check(False, 1000 + 300) is False and not c.sent        # 5 min: nada
    assert web._offline_check(False, 1000 + 700) is True
    assert c.sent[-1]["kind"] == "offline" and "37 %" in c.sent[-1]["body"]
    assert web._offline_check(True, 1000 + 5000) is True and len(c.sent) == 1   # no repite
    web.hub.last_seen = 9000.0
    assert web._offline_check(True, 9010) is False                              # volvió


def test_night_uses_and_keeps_history(c, monkeypatch):
    import asyncio

    from alma_relay import haiku, history
    _setup(c)
    seen = []
    monkeypatch.setattr(haiku, "night_report", lambda s, prev, a: seen.append(prev) or {
        "journal_es": f"día {s['age_days']}", "trait_nudges": {}, "composition": None, "tags": [],
        "wellbeing_adjust": 1, "wellbeing_reason": "bien"})
    from alma_relay import settings as st
    st.update(anthropic_key="x")
    for d in range(1, 9):
        asyncio.run(web._night({"t": "night", "summary": {"age_days": d, "date": f"2026-11-{d:02d}"}}))
    assert [p["age_days"] for p in seen[-1]] == [2, 3, 4, 5, 6, 7]   # los 6 días anteriores
    j = c.get("/app/state").json()["journal"]
    assert [x["journal_es"] for x in j] == ["día 8", "día 7", "día 6"]
    assert len(history.load()) == 8


def test_feed_round_trip(c):
    """Tamagotchi: la app ofrece comida, el robot decide y contesta por el enlace (2026-10-30).
    Con "with": un solo ciclo de eventos para la app y el robot, como en uvicorn."""
    import threading
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex()})
    with TestClient(app_module.app, cookies=c.cookies) as cc:
        assert cc.post("/app/feed", json={"food": "pizza"}).status_code == 409          # sin robot
        assert cc.post("/app/feed", json={"food": "tornillos"}).status_code == 400
        ws, sess = _robot(cc)
        sess.open(ws.receive_bytes())

        def robot_side():
            m = sess.open(ws.receive_bytes())
            assert m["t"] == "feed" and m["food"] == "helado"
            ws.send_bytes(sess.seal({"t": "feed_result", "req": m["req"], "food": "helado", "accepted": True,
                                     "why": "le_encanta", "hunger": 0.2, "sick": 1, "got_sick": 1}))
        th = threading.Thread(target=robot_side)
        th.start()
        resp = cc.post("/app/feed", json={"food": "helado"})
        r = resp.json()
        th.join(5)
        assert resp.status_code == 200, (resp.status_code, r)
        assert r["accepted"] and r["text"].startswith("😋 ¡Le encantó!") and "empachó" in r["text"] and r["emoji"] == "🍦"
        assert cc.get("/app/state").json()["events"][-1]["ev"] == "feed"
        assert len(cc.get("/app/foods").json()["foods"]) == 16
        ws.__exit__(None, None, None)


def test_hungry_and_sick_notices(c):
    _setup(c)
    c.post("/app/push/subscribe", json={"endpoint": "https://push.example/abc", "keys": {}})
    assert notify.on_robot_message({"t": "event", "ev": "hungry", "hunger": 0.71}, now=1000) == ["hungry"]
    assert notify.on_robot_message({"t": "event", "ev": "hungry", "hunger": 0.8}, now=2000) == []   # cada 3 h
    night = 1_800_000_000.0                 # 2:00 en la Ciudad de México: de noche no se avisa
    assert notify.on_robot_message({"t": "event", "ev": "hungry", "hunger": 0.8}, now=night) == []
    assert notify.on_robot_message({"t": "event", "ev": "sick"}, now=1000) == ["sick"]


def test_welcome_lleva_la_hora_local():
    """El robot la usa si el SNTP no contestó (2026-11-01)."""
    m = web.welcome_msg(now=1_800_000_000)
    assert m == {"t": "welcome", "time": 1_800_000_000, "local": 1_800_000_000 - 6 * 3600}   # Ciudad de México
