"""Transcripción con Groq (Whisper), endpoint compatible con OpenAI."""

import os

import httpx

GROQ_BASE_URL = "https://api.groq.com"
GROQ_PATH = "/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3-turbo"
# Vocabulario esperado (07, "Transcripción").
VOCAB_PROMPT = "Alma, ven, baila, alócate, gira, detente, mírame, a dormir, muy bien, no"
TIMEOUT_S = 3.0   # el robot espera 6 s en total por la voz (Groq + Haiku + red)

_client: httpx.Client | None = None  # las pruebas lo sustituyen por uno con MockTransport


def client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(base_url=GROQ_BASE_URL, timeout=TIMEOUT_S)
    return _client


def transcribe(audio: bytes, lang: str = "es") -> str:
    """Devuelve el texto transcrito (puede ser vacío). Lanza httpx.HTTPError si falla."""
    from . import settings
    key = settings.get("groq_key", "")
    r = client().post(
        GROQ_PATH,
        headers={"Authorization": f"Bearer {key}"},
        files={"file": ("audio.wav", audio, "audio/wav")},
        data={
            "model": MODEL,
            "language": lang,
            "prompt": VOCAB_PROMPT,
            "response_format": "json",
        },
    )
    r.raise_for_status()
    return (r.json().get("text") or "").strip()
