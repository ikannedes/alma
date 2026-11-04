"""Voz por el enlace del robot (voice.py; dueño, 2026-10-30). Groq y Haiku son dobles: sin red."""

import base64

from alma_relay import settings, stt
from tests.test_web import LINK_KEY, _robot, _setup, c  # noqa: F401


def _send_clip(ws, sess, seconds=1.0, chunk=2400, skip=None):
    pcm = b"\x00\x01" * int(16000 * seconds)
    parts = [pcm[i:i + chunk] for i in range(0, len(pcm), chunk)]
    for n, p in enumerate(parts):
        if n == skip:
            continue
        ws.send_bytes(sess.seal({"t": "voice", "seq": n, "last": int(n == len(parts) - 1), "rate": 16000,
                                 "pcm": base64.b64encode(p).decode()}))


def test_voice_rule_path(c, monkeypatch):  # noqa: F811
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex(), "groq_key": "gsk_prueba"})
    heard = []
    monkeypatch.setattr(stt, "transcribe", lambda wav, lang: heard.append(len(wav)) or "Alma, baila")
    ws, sess = _robot(c)
    assert sess.open(ws.receive_bytes())["t"] == "welcome"
    _send_clip(ws, sess, 1.0)
    r = sess.open(ws.receive_bytes())
    assert r["t"] == "voice_result" and r["intent"] == "action" and r["action_id"] == "dance" and r["source"] == "rule"
    assert heard == [44 + 32000]                                          # WAV de 1 s, 16 kHz, 16 bits
    ev = c.get("/app/state").json()["events"][-1]
    assert ev["ev"] == "voice" and ev["transcript"] == "Alma, baila"
    ws.__exit__(None, None, None)


def test_voice_errors(c, monkeypatch):  # noqa: F811
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex()})
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    ws, sess = _robot(c)
    sess.open(ws.receive_bytes())
    _send_clip(ws, sess, 1.0)
    assert sess.open(ws.receive_bytes())["error"] == "falta la llave de Groq en la app"
    settings.update(groq_key="gsk_prueba")
    monkeypatch.setattr(stt, "transcribe", lambda wav, lang: "baila")
    _send_clip(ws, sess, 1.0, skip=3)
    assert sess.open(ws.receive_bytes())["error"] == "audio incompleto"     # se perdió un trozo
    _send_clip(ws, sess, 0.1)
    assert sess.open(ws.receive_bytes())["error"] == "audio muy corto"
    ws.__exit__(None, None, None)
