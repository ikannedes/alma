"""Ver de cerca (dueño, 2026-11-01): cuando algo queda a 10 cm o menos, y como mucho una vez cada 3 minutos, el robot
manda la foto de su cámara (K210, JPEG de ~320×240) en trozos {"t":"photo","seq":n,"last":0|1,"jpg":"<base64>"}.
Haiku dice qué es y cómo reacciona Alma; vuelve {"t":"seen","objeto","reaccion","comentario"} o {"t":"seen","error"}.
La foto no se guarda en disco: solo la última, en memoria, para verla en la app.

Foto del dueño (dueño, 2026-11-02): con "kind":"owner" en el primer trozo, es la que Alma le toma solo a su dueño cuando
lo ve de frente un rato (con un gesto de cámara); Haiku dice qué hace (ver_dueno) y "objeto" lleva eso. Esa foto no se
guarda ni en memoria: solo el texto, para el diario.
"""

import base64
import datetime as dt
import threading
import time

from . import haiku, settings

MAX_BYTES = 256 * 1024       # el original reservaba 256 KB para una foto
DAILY_MAX = 200              # tope de fotos al día (con 3 min entre fotos, más que suficiente)
REACTIONS = ("curiosa", "contenta", "asustada", "confundida", "indiferente")
# lo que puede hacer con el objeto (dueño, 2026-11-01: Haiku elige cómo actúa): conductas del catálogo que tienen sentido
# frente a algo que le acercan; el robot vuelve a comprobar que existan y que se puedan hacer ahora
ACTIONS = {
    "bhv_inspect_obstacle": "acercarse y examinarlo con atención",
    "bhv_look_around": "mirar alrededor, como buscando de dónde salió",
    "bhv_happy_wiggle": "menearse de alegría",
    "bhv_dance": "ponerse a bailar",
    "bhv_play_bow": "invitar a jugar (se agacha juguetona)",
    "bhv_play_solo": "jugar sola, toda emocionada",
    "bhv_chase_turn": "dar vueltas como persiguiéndolo",
    "bhv_greet": "saludar (si es una mano, una persona u otro robot)",
    "bhv_babble": "balbucear, como platicándole",
    "bhv_sing": "cantar",
    "bhv_imitate": "imitarlo",
    "bhv_eat": "hacer como que se lo come (solo la animación; no la alimenta)",
    "bhv_drink": "hacer como que se lo toma (solo la animación)",
    "bhv_startle": "sobresaltarse",
    "bhv_shy_retreat": "echarse para atrás, tímida",
    "bhv_sulk": "enojarse, hacer berrinche",
    "bhv_refuse": "rechazarlo (no le gusta)",
    "bhv_confused": "no entender qué es",
    "bhv_yawn_bored": "bostezar de aburrimiento",
}

_lock = threading.Lock()
_last: dict = {}             # {"jpg": bytes, "at", "objeto", "reaccion", "comentario"}
_day: dict = {"date": None, "n": 0, "seen": [], "owner": []}


class Photo:
    """La foto que va llegando."""

    def __init__(self):
        self.jpg = bytearray()
        self.next_seq = 0
        self.broken = False
        self.kind = "near"           # "near": algo de cerca; "owner": la que le toma a su dueño

    def add(self, msg: dict) -> bool:
        """Agrega un trozo; devuelve True cuando llegó el último."""
        seq = msg.get("seq")
        if seq == 0:
            self.__init__()
            self.kind = "owner" if msg.get("kind") == "owner" else "near"
        if seq != self.next_seq:
            self.broken = True          # se perdió un trozo: no se mira
        self.next_seq = (seq or 0) + 1
        try:
            self.jpg += base64.b64decode(msg.get("jpg") or "")
        except ValueError:
            self.broken = True
        if len(self.jpg) > MAX_BYTES:
            self.broken = True
            self.jpg = self.jpg[:MAX_BYTES]
        return bool(msg.get("last"))


def _today(now: float) -> dict:
    from . import alarms
    day = dt.datetime.fromtimestamp(now, alarms.tz()).date().isoformat()
    if _day["date"] != day:
        _day.update(date=day, n=0, seen=[], owner=[])
    return _day


def context(robot_state: dict | None) -> dict:
    """Cómo está Alma ahora, para que Haiku decida como ella: rasgos, ánimo, bienestar, hambre y salud."""
    s = robot_state or {}
    t = {k: round(float(v), 2) for k, v in (s.get("traits") or {}).items() if isinstance(v, (int, float))}
    out = {"rasgos": t, "animo": s.get("simple_mood"), "valencia": s.get("valence"), "bienestar": s.get("wellbeing"),
           "enferma": bool(s.get("sick")), "estado": s.get("state")}
    h = s.get("hunger")
    if isinstance(h, (int, float)) and h >= 0:
        out["hambre"] = round(float(h), 2)
    return {k: v for k, v in out.items() if v is not None}


def see(photo: Photo, robot_state: dict | None = None, now: float | None = None) -> dict:
    """Bloquea (red): llamar en un hilo. Nunca lanza: los errores van en "error" (el robot no reacciona)."""
    now = now if now is not None else time.time()
    if photo.broken:
        return {"error": "foto incompleta"}
    jpg = bytes(photo.jpg)
    if len(jpg) < 100 or jpg[:2] != b"\xff\xd8":
        return {"error": "no es un JPEG"}
    if not settings.get("anthropic_key"):
        return {"error": "falta la llave de Claude en la app"}
    with _lock:
        d = _today(now)
        if d["n"] >= DAILY_MAX:
            return {"error": "ya vio mucho hoy"}
        d["n"] += 1
    owner = photo.kind == "owner"
    try:
        raw = (haiku.see_owner if owner else haiku.see_object)(jpg, context(robot_state), ACTIONS)
    except Exception as e:
        return {"error": f"haiku: {type(e).__name__}"}
    objeto = str(raw.get("que_hace" if owner else "objeto") or ("no se distingue" if owner else "algo"))[:60]
    reaccion = raw.get("reaccion") if raw.get("reaccion") in REACTIONS else "confundida"
    comentario = str(raw.get("comentario") or "")[:160]
    conducta = raw.get("conducta") if raw.get("conducta") in ACTIONS else None
    with _lock:
        if owner:   # privacidad: de la foto del dueño solo queda el texto
            _today(now)["owner"] = (_day["owner"] + [objeto])[-30:]
        else:
            _last.update(jpg=jpg, at=int(now), objeto=objeto, reaccion=reaccion, comentario=comentario)
            _today(now)["seen"] = (_day["seen"] + [objeto])[-30:]
    r = {"objeto": objeto, "reaccion": reaccion, "conducta": conducta, "comentario": comentario}
    return r | ({"kind": "owner"} if owner else {"juguete": bool(raw.get("es_juguete"))})


def last() -> dict:
    with _lock:
        return dict(_last)


def today_summary(now: float | None = None) -> list[str]:
    """Lo que vio de cerca hoy, para el diario."""
    with _lock:
        return list(_today(now if now is not None else time.time())["seen"])


def owner_summary(now: float | None = None) -> list[str]:
    """Lo que hacía su dueño en las fotos que le tomó hoy, para el diario."""
    with _lock:
        return list(_today(now if now is not None else time.time())["owner"])
