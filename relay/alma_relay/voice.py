"""Voz por el enlace del robot (07; dueño, 2026-10-30): el robot manda el PCM del micrófono en trozos
{"t":"voice","seq":n,"last":0|1,"rate":16000,"pcm":"<base64>"}; al último, Whisper (Groq) → reglas de 05 → Haiku,
y vuelve {"t":"voice_result", "intent", "action_id", "confidence", "transcript", "source"} o {"error"}.
"""

import base64
import io
import wave

from . import haiku, rules, settings, stt

MAX_SECONDS = 12            # el original corta a 12 s
MIN_SECONDS = 0.3
# lo que Whisper suele inventar con audio casi vacío (2026-11-03: "Gracias" con 0.5 s, sin que nadie lo dijera)
ALUCINACIONES = {"gracias", "muchas gracias", "gracias por ver", "gracias por ver el video", "suscribete",
                 "subtitulos realizados por la comunidad de amara org"}
ALUCINACION_MAX_S = 1.5


class Clip:
    """El audio que va llegando de una escucha."""

    def __init__(self):
        self.pcm = bytearray()
        self.rate = 16000
        self.next_seq = 0
        self.broken = False

    def add(self, msg: dict) -> bool:
        """Agrega un trozo; devuelve True cuando llegó el último."""
        seq = msg.get("seq")
        if seq == 0:
            self.__init__()
        if seq != self.next_seq:
            self.broken = True          # se perdió un trozo: se descarta la escucha
        self.next_seq = (seq or 0) + 1
        self.rate = int(msg.get("rate") or 16000)
        try:
            self.pcm += base64.b64decode(msg.get("pcm") or "")
        except ValueError:
            self.broken = True
        if len(self.pcm) > MAX_SECONDS * self.rate * 2:
            self.pcm = self.pcm[: MAX_SECONDS * self.rate * 2]
        return bool(msg.get("last"))

    def wav(self) -> bytes:
        b = io.BytesIO()
        with wave.open(b, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.rate)
            w.writeframes(bytes(self.pcm))
        return b.getvalue()

    def seconds(self) -> float:
        return len(self.pcm) / (2 * self.rate)


def understand(clip: Clip) -> dict:
    """Bloquea (red): llamar en un hilo. Nunca lanza: los errores van en "error" (el robot hace EV_VOICE_FAILED)."""
    if clip.broken:
        return {"error": "audio incompleto"}
    if clip.seconds() < MIN_SECONDS:
        return {"error": "audio muy corto"}
    if not settings.get("groq_key"):
        return {"error": "falta la llave de Groq en la app"}
    try:
        transcript = stt.transcribe(clip.wav(), "es")
    except Exception as e:
        return {"error": f"stt: {type(e).__name__}"}
    normalized = rules.normalize(transcript)
    if clip.seconds() < ALUCINACION_MAX_S and normalized in ALUCINACIONES:
        normalized = ""
    if not normalized:
        return {"intent": "none", "action_id": None, "confidence": 1.0, "transcript": transcript, "source": "rule"}
    hit = rules.match(normalized)
    if hit:
        return {**hit, "confidence": 1.0, "transcript": transcript, "source": "rule"}
    if not settings.get("anthropic_key"):
        return {"intent": "none", "action_id": None, "confidence": 0.0, "transcript": transcript, "source": "rule"}
    try:
        return {**haiku.decide_intent(transcript), "transcript": transcript, "source": "haiku"}
    except Exception as e:
        return {"error": f"haiku: {type(e).__name__}", "transcript": transcript}
