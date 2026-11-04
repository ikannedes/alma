"""POST /v1/voice de punta a punta con dobles de Groq y Haiku."""

import sqlite3

import pytest

from alma_relay import app as app_module
from alma_relay import rules
from tests.conftest import TOKEN, make_wav, post_voice

ACTION_CASES = [(p, a) for a, phrases in rules.ACTION_PHRASES.items() for p in phrases]


@pytest.mark.parametrize("phrase,action_id", ACTION_CASES)
def test_action_phrase_by_rule(client, groq, haiku_double, phrase, action_id):
    groq.text = phrase
    r = post_voice(client)
    assert r.status_code == 200
    body = r.json()
    assert body["intent"] == "action"
    assert body["action_id"] == action_id
    assert body["source"] == "rule"
    assert body["confidence"] == 1.0
    assert body["transcript"] == phrase
    assert haiku_double.calls == []


@pytest.mark.parametrize("phrase", rules.PRAISE_PHRASES)
def test_praise_by_rule(client, groq, haiku_double, phrase):
    groq.text = phrase
    body = post_voice(client).json()
    assert (body["intent"], body["source"]) == ("praise", "rule")
    assert haiku_double.calls == []


@pytest.mark.parametrize("phrase", rules.SCOLD_PHRASES)
def test_scold_by_rule(client, groq, haiku_double, phrase):
    groq.text = phrase
    body = post_voice(client).json()
    assert (body["intent"], body["source"]) == ("scold", "rule")
    assert haiku_double.calls == []


@pytest.mark.parametrize("text", ["no bailes", "deja de bailar", "nunca gires", "ya no juegues"])
def test_negation_goes_to_haiku(client, groq, haiku_double, text):
    groq.text = text
    haiku_double.tool_input = {"intent": "none", "confidence": 0.7}
    body = post_voice(client).json()
    assert body["source"] == "haiku"
    assert body["intent"] == "none"
    assert len(haiku_double.calls) == 1
    assert haiku_double.calls[0]["messages"][0]["content"] == text


@pytest.mark.parametrize("text,action_id", [
    ("Alma, baila", "dance"),
    ("oye alma, gira", "turn_around"),
    ("ven aquí, por favor", "come"),
    ("ya, detente", "stop"),
    ("Oye Alma, por favor, a dormir ya", "sleep"),
    ("Mírame, Alma.", "look_at_me"),
])
def test_fillers_around_phrase_match(client, groq, haiku_double, text, action_id):
    groq.text = text
    body = post_voice(client).json()
    assert (body["source"], body["action_id"]) == ("rule", action_id)
    assert haiku_double.calls == []


@pytest.mark.parametrize("text", ["quiero que bailes", "cuéntame algo"])
def test_unmatched_goes_to_haiku(client, groq, haiku_double, text):
    groq.text = text
    haiku_double.tool_input = {"intent": "action", "action_id": "dance", "confidence": 0.55}
    body = post_voice(client).json()
    assert body == {
        "intent": "action", "action_id": "dance", "confidence": 0.55, "transcript": text, "source": "haiku",
    }
    assert len(haiku_double.calls) == 1


def test_haiku_double_uses_real_messages_api_format(client, groq, haiku_double):
    groq.text = "cuéntame algo"
    haiku_double.tool_input = {"intent": "praise", "confidence": 0.9}
    body = post_voice(client).json()
    assert (body["intent"], body["confidence"], body["source"]) == ("praise", 0.9, "haiku")
    call = haiku_double.calls[0]
    assert call["model"] == "claude-haiku-5-5"
    assert call["max_tokens"] == 100
    assert call["tool_choice"] == {"type": "tool", "name": "decide_intent"}
    assert call["tools"][0]["name"] == "decide_intent"
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"}
    response = haiku_double.create(**call)
    assert response.content[0].type == "tool_use"
    assert response.content[0].input == {"intent": "praise", "confidence": 0.9}


def test_haiku_invalid_action_id_becomes_none(client, groq, haiku_double):
    groq.text = "haz una voltereta"
    haiku_double.tool_input = {"intent": "action", "action_id": "somersault", "confidence": 0.8}
    body = post_voice(client).json()
    assert (body["intent"], body["action_id"], body["source"]) == ("none", None, "haiku")


def test_empty_transcript_is_none_without_haiku(client, groq, haiku_double):
    groq.text = ""
    body = post_voice(client).json()
    assert (body["intent"], body["source"]) == ("none", "rule")
    assert haiku_double.calls == []


def test_audio_too_long_413(client, groq):
    r = post_voice(client, audio=make_wav(10.5))
    assert r.status_code == 413
    assert r.json()["intent"] == "none"
    assert groq.requests == []


def test_audio_too_big_413(client, groq):
    r = post_voice(client, audio=make_wav(5.0, rate=48000))  # 480 KB
    assert r.status_code == 413
    assert groq.requests == []


def test_bad_token_401(client, groq):
    assert post_voice(client, token="otro").status_code == 401
    assert client.post("/v1/voice", files={"audio": ("a.wav", make_wav(1), "audio/wav")}).status_code == 401
    assert groq.requests == []


def test_rate_limit_429(client, groq, monkeypatch):
    groq.text = "baila"
    for _ in range(app_module.VOICE_PER_HOUR):
        assert post_voice(client).status_code == 200
    r = post_voice(client)
    assert r.status_code == 429
    assert r.json() == {"intent": "none", "error": "rate_limited"}
    # Una hora después vuelve a aceptar.
    monkeypatch.setattr(app_module.time, "time", lambda: 1e12)
    assert post_voice(client).status_code == 200


def test_groq_failure_502(client, groq, haiku_double):
    groq.status = 500
    r = post_voice(client)
    assert r.status_code == 502
    body = r.json()
    assert body["intent"] == "none" and "stt" in body["error"]
    assert haiku_double.calls == []


def test_haiku_failure_502(client, groq, haiku_double):
    groq.text = "cuéntame algo"
    haiku_double.error = RuntimeError("caído")
    r = post_voice(client)
    assert r.status_code == 502
    assert r.json()["intent"] == "none"


def test_groq_request_shape(client, groq):
    groq.text = "baila"
    post_voice(client)
    req = groq.requests[0]
    assert req.url.path == "/openai/v1/audio/transcriptions"
    assert req.headers["Authorization"] == "Bearer groq-falsa"
    raw = req.read()
    assert b'name="model"' in raw and b"whisper-large-v3-turbo" in raw
    assert b'name="language"' in raw and b"\r\nes\r\n" in raw
    assert b'name="prompt"' in raw


def test_sqlite_log(client, groq, haiku_double, tmp_path):
    groq.text = "baila"
    post_voice(client)
    groq.text = "cuéntame algo"
    post_voice(client)
    groq.status = 500
    post_voice(client)
    rows = sqlite3.connect(tmp_path / "relay.db").execute(
        "SELECT route, http_status, transcript, source, error, stt_ms, total_ms FROM requests ORDER BY id"
    ).fetchall()
    assert [(r[0], r[1], r[2], r[3]) for r in rows] == [
        ("/v1/voice", 200, "baila", "rule"),
        ("/v1/voice", 200, "cuéntame algo", "haiku"),
        ("/v1/voice", 502, None, None),
    ]
    assert rows[2][4].startswith("stt:")
    assert all(r[6] is not None for r in rows)


def test_alucinacion_de_whisper_con_audio_corto(monkeypatch):
    """2026-11-03: con 0.5 s casi vacíos Whisper devolvió "Gracias"; es nada, no Haiku. Con audio largo sí cuenta."""
    from alma_relay import settings, stt, voice
    monkeypatch.setattr(settings, "get", lambda k, d=None: "llave" if k in ("groq_key", "anthropic_key") else d)
    monkeypatch.setattr(stt, "transcribe", lambda wav, lang: "¡Gracias!")
    called = []
    monkeypatch.setattr(voice.haiku, "decide_intent", lambda t: called.append(t) or {"intent": "praise", "action_id": None,
                                                                                     "confidence": 0.9})
    corto, largo = voice.Clip(), voice.Clip()
    corto.pcm += bytes(2 * 8000)       # 0.5 s
    largo.pcm += bytes(2 * 16000 * 2)  # 2 s
    assert voice.understand(corto)["intent"] == "none" and called == []
    assert voice.understand(largo)["intent"] != "none" or called == ["¡Gracias!"]
