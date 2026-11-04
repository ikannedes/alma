"""Dobles sin red: Groq por httpx.MockTransport, Haiku por un cliente falso."""

import io
import json
import wave

import anthropic
import httpx
import pytest
from anthropic.types import Message, TextBlock, ToolUseBlock, Usage
from fastapi.testclient import TestClient

from alma_relay import app as app_module
from alma_relay import haiku, stt

TOKEN = "token-de-prueba"


def make_wav(seconds: float, rate: int = 16000) -> bytes:
    """WAV PCM s16le mono de silencio."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()


class GroqDouble:
    """Responde /openai/v1/audio/transcriptions con `text`, o con `status` si se pide un fallo."""

    def __init__(self):
        self.text = ""
        self.status = 200
        self.requests = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"message": "fallo simulado"}})
        return httpx.Response(200, json={"text": self.text})


class HaikuDouble:
    """Imita `client.messages.create` y devuelve un Message real con un bloque tool_use."""

    def __init__(self):
        self.tool_input = {"intent": "none", "confidence": 0.2}
        self.error: Exception | None = None
        self.calls = []
        self.messages = self  # client().messages.create(...)

    def create(self, **kwargs) -> Message:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        name = kwargs["tool_choice"]["name"]
        return Message(
            id="msg_doble",
            type="message",
            role="assistant",
            model=kwargs["model"],
            content=[ToolUseBlock(type="tool_use", id="toolu_doble", name=name, input=dict(self.tool_input))],
            stop_reason="tool_use",
            stop_sequence=None,
            usage=Usage(input_tokens=10, output_tokens=5),
        )


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    monkeypatch.setenv("ALMA_DEVICE_TOKEN", TOKEN)
    monkeypatch.setenv("ALMA_RELAY_DB", str(tmp_path / "relay.db"))
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path / "data"))   # nada de pruebas en data/ (avisos, ajustes)
    monkeypatch.setenv("GROQ_API_KEY", "groq-falsa")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-falsa")
    app_module._voice_times.clear()


@pytest.fixture
def groq(monkeypatch):
    double = GroqDouble()
    monkeypatch.setattr(stt, "_client", httpx.Client(base_url=stt.GROQ_BASE_URL, transport=httpx.MockTransport(double.handler)))
    return double


@pytest.fixture
def haiku_double(monkeypatch):
    double = HaikuDouble()
    monkeypatch.setattr(haiku, "_client", double)
    return double


@pytest.fixture
def client(groq, haiku_double):
    return TestClient(app_module.app)


def post_voice(client: TestClient, audio: bytes | None = None, token: str = TOKEN, person_id: str = "1"):
    return client.post(
        "/v1/voice",
        files={"audio": ("audio.wav", audio if audio is not None else make_wav(1.0), "audio/wav")},
        data={"person_id": person_id, "lang": "es"},
        headers={"Authorization": f"Bearer {token}"},
    )


def post_night(client: TestClient, payload: dict, token: str = TOKEN):
    return client.post("/v1/night", json=payload, headers={"Authorization": f"Bearer {token}"})
