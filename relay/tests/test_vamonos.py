"""'EMO, vámonos' (dueño, 2026-11-06): Alma se muda al reloj por voz, como el botón 'Llévame contigo'."""

import asyncio

from alma_relay import reloj, rules, voice, web


def test_frases():
    for f in ("EMO, vámonos", "vámonos", "nos vamos", "vente conmigo", "Alma, al reloj"):
        assert rules.is_move(rules.normalize(f)), f
    for f in ("vamos a jugar", "baila", "no nos vamos"):
        assert not rules.is_move(rules.normalize(f)), f


def _run(monkeypatch, transcript, cuerpo):
    sent, moves = [], []
    monkeypatch.setattr(voice, "understand", lambda clip: {"transcript": transcript, "intent": "none", "confidence": 0.3})
    monkeypatch.setattr(reloj, "where", lambda: {"cuerpo": cuerpo})

    async def move(mid, to, reason):
        moves.append((to, reason))
        return {"ok": True}

    async def send(m):
        sent.append(m)
        return True

    monkeypatch.setattr(reloj, "_move", move)
    monkeypatch.setattr(web.hub, "send", send)
    asyncio.run(web._voice(None))
    return sent, moves


def test_vamonos_se_muda_y_se_despide(monkeypatch):
    sent, moves = _run(monkeypatch, "EMO, vámonos", "robot")
    assert moves == [("reloj", "boton")]
    assert sent[-1]["t"] == "voice_result" and sent[-1]["action_id"] == "greet", "se despide saludando"


def test_si_ya_esta_en_el_reloj_no_pide(monkeypatch):
    sent, moves = _run(monkeypatch, "vámonos", "reloj")
    assert moves == [] and sent[-1]["intent"] == "none"
