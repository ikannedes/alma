"""alma-relay: POST /v1/voice y POST /v1/night (07-nube.md).

El relay solo sugiere: nunca manda movimientos ni toca al robot.
"""

import hmac
import io
import os
import time
import wave
from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.responses import JSONResponse

from . import db, haiku, night, rules, stt

MAX_AUDIO_BYTES = 400 * 1024
MAX_AUDIO_SECONDS = 10.0
VOICE_PER_HOUR = 60
MAX_PREVIOUS_DAYS = 6

@asynccontextmanager
async def _lifespan(_app):
    web.start_background()   # alarmas (las pruebas con TestClient sin "with" no lo arrancan)
    yield


app = FastAPI(title="alma-relay", docs_url=None, redoc_url=None, lifespan=_lifespan)

from . import web  # noqa: E402  (app del dueño y enlace del robot, 2026-10-30)
from . import web_play  # noqa: E402  (jugar con Alma: juegos abiertos + Haiku, PLAN-JUEGOS 2026-10-31)

app.include_router(web.router)
app.include_router(web_play.router)
from . import reloj  # noqa: E402  (Alma en el reloj, PLAN-RELOJ-v2 2026-11-01)
app.include_router(reloj.router)
from . import juegos_reloj  # noqa: E402  (juegos del reloj y Preguntas, 2026-11-01)
app.include_router(juegos_reloj.router)

# Marcas de tiempo de las peticiones de voz por token (en memoria: un solo proceso).
_voice_times: dict[str, deque] = {}


def _token_ok(authorization: str | None) -> bool:
    from . import settings
    expected = settings.get("device_token", "")
    if not expected or not authorization or not authorization.startswith("Bearer "):
        return False
    return hmac.compare_digest(authorization[7:].strip(), expected)


def _rate_limited(token: str, now: float) -> bool:
    times = _voice_times.setdefault(token, deque())
    while times and now - times[0] > 3600:
        times.popleft()
    if len(times) >= VOICE_PER_HOUR:
        return True
    times.append(now)
    return False


def _audio_seconds(data: bytes) -> float | None:
    """Duración del WAV, o None si no es un WAV legible."""
    try:
        with wave.open(io.BytesIO(data)) as w:
            rate = w.getframerate()
            return w.getnframes() / rate if rate else None
    except (wave.Error, EOFError):
        return None


def _ms(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


@app.post("/v1/voice")
def voice(
    audio: UploadFile = File(...),
    person_id: str = Form(""),
    lang: str = Form("es"),
    authorization: str | None = Header(None),
):
    t0 = time.perf_counter()
    log = {"person_id": person_id or None}

    def fail(status: int, error: str, **extra):
        body = {"intent": "none", "error": error}
        db.log_request("/v1/voice", status, body, error=error, total_ms=_ms(t0), **log, **extra)
        return JSONResponse(body, status_code=status)

    if not _token_ok(authorization):
        return fail(401, "unauthorized")
    if _rate_limited(authorization, time.time()):
        return fail(429, "rate_limited")

    data = audio.file.read()
    if len(data) > MAX_AUDIO_BYTES:
        return fail(413, "audio_too_large")
    seconds = _audio_seconds(data)
    if seconds is None:
        return fail(400, "bad_audio")
    if seconds > MAX_AUDIO_SECONDS:
        return fail(413, "audio_too_long")

    t_stt = time.perf_counter()
    try:
        transcript = stt.transcribe(data, lang)
    except Exception as e:  # red, 4xx/5xx de Groq, JSON raro: el ESP32 lo trata como EV_VOICE_FAILED
        return fail(502, f"stt: {type(e).__name__}: {e}", stt_ms=_ms(t_stt))
    stt_ms = _ms(t_stt)
    log["transcript"] = transcript

    normalized = rules.normalize(transcript)
    if not normalized:
        body = {"intent": "none", "action_id": None, "confidence": 1.0, "transcript": transcript, "source": "rule"}
        db.log_request("/v1/voice", 200, body, source="rule", stt_ms=stt_ms, total_ms=_ms(t0), **log)
        return body

    hit = rules.match(normalized)
    if hit:
        body = {**hit, "confidence": 1.0, "transcript": transcript, "source": "rule"}
        db.log_request("/v1/voice", 200, body, source="rule", stt_ms=stt_ms, total_ms=_ms(t0), **log)
        return body

    t_haiku = time.perf_counter()
    try:
        decided = haiku.decide_intent(transcript)
    except Exception as e:
        return fail(502, f"haiku: {type(e).__name__}: {e}", source="haiku", stt_ms=stt_ms, haiku_ms=_ms(t_haiku))
    body = {**decided, "transcript": transcript, "source": "haiku"}
    db.log_request("/v1/voice", 200, body, source="haiku", stt_ms=stt_ms, haiku_ms=_ms(t_haiku), total_ms=_ms(t0), **log)
    return body


@app.post("/v1/night")
def night_pass(payload: dict, authorization: str | None = Header(None)):
    t0 = time.perf_counter()

    def fail(status: int, error: str, **extra):
        body = {"error": error}
        db.log_request("/v1/night", status, body, error=error, total_ms=_ms(t0), **extra)
        return JSONResponse(body, status_code=status)

    if not _token_ok(authorization):
        return fail(401, "unauthorized")
    summary = payload.get("summary")
    if not isinstance(summary, dict):
        return fail(400, "summary_missing")
    previous = payload.get("previous") or []
    if not isinstance(previous, list):
        return fail(400, "previous_invalid")
    previous = previous[-MAX_PREVIOUS_DAYS:]
    assets = payload.get("assets") or []
    if not isinstance(assets, list) or not all(isinstance(a, str) for a in assets):
        return fail(400, "assets_invalid")

    t_haiku = time.perf_counter()
    try:
        raw = haiku.night_report(summary, previous, assets)
    except Exception as e:
        return fail(502, f"haiku: {type(e).__name__}: {e}", source="haiku", haiku_ms=_ms(t_haiku))
    body = night.apply_limits(raw, assets)
    db.log_request("/v1/night", 200, body, source="haiku", haiku_ms=_ms(t_haiku), total_ms=_ms(t0))
    return body
