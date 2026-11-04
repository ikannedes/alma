"""Álbum de Alma (dueño, 2026-11-01): la app le pide fotos (Navidad, Día de Muertos, sus cumpleaños, antojos suyos) y el
dueño las sube; Haiku la ve como Alma, con su personalidad, su ánimo y sus gustos de nacimiento (disfraces, colores…),
y dice si le gustó, qué hace y qué piensa. La foto queda en el álbum con su comentario. También se puede guardar ahí la
última foto que ella tomó de cerca.

Las fotos se guardan reducidas (lado mayor 1600 px), sin metadatos (se quita la ubicación del teléfono), en
data/album/. A Haiku va una copia de 1024 px.
"""

import datetime as dt
import io
import json
import os
import random
import secrets
import threading
import time

from . import haiku, settings, vision

MAX_UPLOAD = 15 * 1024 * 1024
MAX_TOTAL = 3 * 1024 ** 3        # tope del álbum en disco (quedan ~4.8 GB libres en el droplet)
DAILY_MAX = 30                   # fotos con Haiku al día
SIDE, SIDE_HAIKU, SIDE_THUMB = 1600, 1024, 360
LIKES = ("le encanta", "le gusta", "le da igual", "no le gusta")
GUSTOS = ("sombreros", "gorritos", "lentes", "moños", "coronas", "disfraces y capas", "luces", "cosas brillantes",
          "flores", "cosas impresas en 3D", "peluches", "cosas que le tapan los ojos", "el rojo", "el azul", "el verde",
          "el rosa", "el amarillo", "el morado", "el dorado", "el negro")
# (id, emoji, nombre, desde (mes, día), hasta (mes, día), lo que pide, título de la primera vez)
OCCASIONS = [
    ("halloween", "🎃", "Halloween", (10, 25), (10, 31), "¡Quiero disfrazarme para Halloween!", "Su primer Halloween"),
    ("muertos", "💀", "Día de Muertos", (11, 1), (11, 2), "¿Me pones algo de Día de Muertos? Una flor de cempasúchil, una calaverita…",
     "Su primer Día de Muertos"),
    ("navidad", "🎄", "Navidad", (12, 1), (12, 25), "¿Me pones algo de Navidad? Un gorrito, un arbolito, unas luces…",
     "Su primera Navidad"),
    ("anio_nuevo", "🎆", "Año Nuevo", (12, 31), (1, 1), "¡Tómame una foto de Año Nuevo!", "Su primer Año Nuevo"),
    ("san_valentin", "💝", "San Valentín", (2, 10), (2, 14), "¿Me pones algo de corazones?", "Su primer San Valentín"),
]
WHIMS = [("sombreros", "🎩", "Quiero un sombrero. ¿Me pones uno y me tomas una foto?"),
         ("cosas impresas en 3D", "🖨️", "¿Me haces algo en la impresora 3D? Quiero verlo."),
         ("lentes", "😎", "Quiero unos lentes, como de artista."),
         ("moños", "🎀", "¿Me pones un moño?"),
         ("coronas", "👑", "Hoy me siento reina. ¿Me haces una corona?"),
         ("peluches", "🧸", "Tómame una foto con un peluche."),
         ("flores", "🌼", "¿Me traes una flor? Quiero una foto con ella.")]
WHIM_DAYS = 5                    # un antojo nuevo cada 5 días
_lock = threading.Lock()


def _dir() -> str:
    d = os.path.join(settings.data_dir(), "album")
    os.makedirs(d, exist_ok=True)
    return d


def _load() -> dict:
    try:
        with open(os.path.join(_dir(), "album.json"), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def _save(d: dict) -> None:
    p = os.path.join(_dir(), "album.json")
    with open(p + ".tmp", "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(p + ".tmp", p)


def _likes(d: dict) -> dict:
    """Gustos de nacimiento (−1 a 1); nacen la primera vez que hacen falta."""
    if not d.get("likes"):
        rng = random.Random(secrets.randbits(64))
        d["likes"] = {g: round(rng.uniform(-1, 1), 2) for g in GUSTOS}
        d["likes"]["cosas que le tapan los ojos"] = round(min(d["likes"]["cosas que le tapan los ojos"], -0.3), 2)
    return d["likes"]


def likes_text(likes: dict) -> dict:
    order = sorted(likes.items(), key=lambda kv: -kv[1])
    return {"le_encantan": [g for g, v in order if v >= 0.5], "le_gustan": [g for g, v in order if 0.15 <= v < 0.5],
            "no_le_gustan": [g for g, v in reversed(order) if v <= -0.3]}


def _jpeg(img, side: int, quality: int = 85) -> bytes:
    from PIL import Image
    im = img.copy()
    im.thumbnail((side, side), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=quality, optimize=True)   # sin exif: se va la ubicación
    return out.getvalue()


def _open(data: bytes):
    from PIL import Image, ImageOps
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)                       # la foto del teléfono, derecha
    return im.convert("RGB")


def _local(now: float) -> dt.datetime:
    from . import alarms
    return dt.datetime.fromtimestamp(now, alarms.tz())


def _in(md: tuple, a: tuple, b: tuple) -> bool:
    return a <= md <= b if a <= b else (md >= a or md <= b)


def pedidos(now: float | None = None) -> list[dict]:
    """Lo que Alma pide ahora: fechas especiales, sus cumpleaños recientes y un antojo cada 5 días."""
    from . import milestones
    now = now if now is not None else time.time()
    t = _local(now)
    d = _load()
    year = t.year if t.month != 1 else t.year - 1          # Año Nuevo cruza el año: cuenta el que empezó en diciembre
    out = []
    for oid, emoji, name, a, b, ask, _ in OCCASIONS:
        if _in((t.month, t.day), a, b):
            out.append({"id": f"{oid}_{year if oid == 'anio_nuevo' else t.year}", "occasion": oid, "emoji": emoji,
                        "name": name, "ask": ask})
    bdays = [m for m in milestones.listing()["milestones"] if m["kind"] == "edad" and now - m["at"] < 3 * 86400]
    if bdays:   # si cruzó varios de golpe (respaldo restaurado), solo el mayor
        m = max(bdays, key=lambda m: int(m["key"].split("_")[1]))
        out.append({"id": "cumple_" + m["key"].split("_")[1], "occasion": "cumple", "emoji": m["emoji"],
                    "name": m["title"], "ask": f"{m['title']} ¿Me tomas una foto para el recuerdo?"})
    if not d.get("likes"):
        with _lock:
            d = _load()
            _likes(d)
            _save(d)
    period = int(now // 86400) // WHIM_DAYS
    loved = [w for w in WHIMS if d["likes"].get(w[0], 0) > 0] or WHIMS
    _, emoji, ask = random.Random(period).choice(loved)   # el mismo antojo durante esos 5 días
    out.append({"id": f"antojo_{period}", "occasion": "antojo", "emoji": emoji, "name": "Un antojo", "ask": ask})
    closed = set(d.get("closed", []))
    return [p for p in out if p["id"] not in closed]


def close(pid: str) -> None:
    """Ya se hizo o el dueño dijo "ahora no"."""
    with _lock:
        d = _load()
        d["closed"] = (d.get("closed", []) + [pid])[-200:]
        _save(d)


def to_notify(now: float | None = None) -> list[dict]:
    """Pedidos de fecha y de cumpleaños que aún no se avisaron (el antojo no avisa: se ve en la app)."""
    with _lock:
        d = _load()
        told = set(d.get("told", []))
    return [p for p in pedidos(now) if p["occasion"] != "antojo" and p["id"] not in told]


def mark_told(ids: list[str]) -> None:
    with _lock:
        d = _load()
        d["told"] = (d.get("told", []) + ids)[-200:]
        _save(d)


def _used(d: dict) -> int:
    return sum(x.get("bytes", 0) for x in d.get("items", []))


def _store(d: dict, full: bytes, thumb: bytes, entry: dict) -> dict:
    pid = time.strftime("%Y%m%d-%H%M%S", time.gmtime(entry["at"])) + "-" + secrets.token_hex(3)
    for suffix, b in (("", full), ("_t", thumb)):
        p = os.path.join(_dir(), pid + suffix + ".jpg")
        with open(p + ".tmp", "wb") as f:
            f.write(b)
        os.replace(p + ".tmp", p)
    entry = {"id": pid, "bytes": len(full) + len(thumb)} | entry
    d.setdefault("items", []).append(entry)
    return entry


def upload(data: bytes, pedido: str | None, robot_state: dict | None, now: float | None = None) -> dict:
    """Bloquea (Pillow y Haiku): llamar en un hilo. Devuelve la foto guardada con la reacción, o {"error"}."""
    now = now if now is not None else time.time()
    if not data or len(data) > MAX_UPLOAD:
        return {"error": "la foto pesa demasiado (máximo 15 MB)"}
    try:
        img = _open(data)
    except Exception:
        return {"error": "no es una imagen"}
    if not settings.get("anthropic_key"):
        return {"error": "falta la llave de Claude en la app"}
    day = _local(now).date().isoformat()
    with _lock:
        d = _load()
        if _used(d) > MAX_TOTAL:
            return {"error": "el álbum está lleno (3 GB)"}
        n = d.setdefault("per_day", {})
        if n.get(day, 0) >= DAILY_MAX:
            return {"error": "ya vio muchas fotos hoy; mañana más"}
        d["per_day"] = {day: n.get(day, 0) + 1}
        likes = _likes(d)
        _save(d)
    ped = next((p for p in pedidos(now) if p["id"] == pedido), None)
    ctx = vision.context(robot_state) | {"gustos": likes_text(likes)}
    if ped:
        ctx["ocasion"] = ped["name"] + ": " + ped["ask"]
    try:
        raw = haiku.see_photo(_jpeg(img, SIDE_HAIKU, 80), ctx, vision.ACTIONS)
    except Exception as e:
        return {"error": f"haiku: {type(e).__name__}"}
    entry = {"at": int(now), "source": "app", "age_days": (robot_state or {}).get("age_days"),
             "occasion": ped["occasion"] if ped else None, "occasion_name": ped["name"] if ped else None,
             "pedido": ped["id"] if ped else None,
             "titulo": str(raw.get("titulo") or raw.get("que_es") or "Una foto")[:60],
             "que_es": str(raw.get("que_es") or "")[:80], "sale_alma": bool(raw.get("sale_alma")),
             "le_gusta": raw.get("le_gusta") if raw.get("le_gusta") in LIKES else "le da igual",
             "reaccion": raw.get("reaccion") if raw.get("reaccion") in vision.REACTIONS else "confundida",
             "conducta": raw.get("conducta") if raw.get("conducta") in vision.ACTIONS else None,
             "comentario": str(raw.get("comentario") or "")[:200]}
    with _lock:
        d = _load()
        first = not d.get("items")
        entry = _store(d, _jpeg(img, SIDE), _jpeg(img, SIDE_THUMB, 80), entry)
        if ped:
            d["closed"] = (d.get("closed", []) + [ped["id"]])[-200:]
        _save(d)
    _remember(entry, first)
    return entry


def keep_last_seen(robot_state: dict | None, now: float | None = None) -> dict:
    """Guarda en el álbum la última foto que tomó ella de cerca (sin volver a llamar a Haiku)."""
    now = now if now is not None else time.time()
    v = vision.last()
    if not v.get("jpg"):
        return {"error": "no hay foto reciente"}
    try:
        img = _open(v["jpg"])
    except Exception:
        return {"error": "la foto no se pudo leer"}
    with _lock:
        d = _load()
        if any(x.get("seen_at") == v["at"] for x in d.get("items", [])):
            return {"error": "esa foto ya está en el álbum"}
        first = not d.get("items")
        entry = _store(d, _jpeg(img, SIDE, 90), _jpeg(img, SIDE_THUMB, 80),
                       {"at": int(v["at"]), "seen_at": v["at"], "source": "robot",
                        "age_days": (robot_state or {}).get("age_days"), "occasion": None, "occasion_name": None,
                        "pedido": None, "titulo": "Vio de cerca: " + str(v.get("objeto") or "algo")[:45],
                        "que_es": v.get("objeto"), "sale_alma": False, "le_gusta": None, "reaccion": v.get("reaccion"),
                        "conducta": None, "comentario": v.get("comentario") or ""})
        _save(d)
    _remember(entry, first)
    return entry


def _remember(entry: dict, first: bool) -> None:
    """Hitos: su primera foto y la primera de cada fecha especial."""
    from . import milestones
    if first:
        milestones.learned("album_primera", "Su primera foto en el álbum", entry["titulo"], "📷", kind="recuerdo")
    occ = next((o for o in OCCASIONS if o[0] == entry.get("occasion")), None)
    if occ:
        milestones.learned(f"ocasion_{occ[0]}", occ[6], entry["comentario"] or entry["titulo"], occ[1], kind="recuerdo")


def listing() -> list[dict]:
    """Las fotos, la más nueva primero (sin datos internos)."""
    skip = {"bytes", "seen_at"}
    return [{k: v for k, v in x.items() if k not in skip}
            for x in sorted(_load().get("items", []), key=lambda x: -x["at"])]


def path(pid: str, thumb: bool = False) -> str | None:
    if not all(c.isalnum() or c == "-" for c in pid):
        return None
    p = os.path.join(_dir(), pid + ("_t" if thumb else "") + ".jpg")
    return p if os.path.exists(p) else None


def delete(pid: str) -> bool:
    with _lock:
        d = _load()
        items = [x for x in d.get("items", []) if x["id"] != pid]
        if len(items) == len(d.get("items", [])):
            return False
        d["items"] = items
        _save(d)
    for suffix in ("", "_t"):
        if p := path(pid, suffix == "_t"):
            os.remove(p)
    return True


def today_summary(now: float | None = None) -> list[str]:
    """Para el diario: las fotos que le enseñaron hoy y si le gustaron."""
    day = _local(now if now is not None else time.time()).date()
    return [f"{x['titulo']} ({x['le_gusta']})" if x.get("le_gusta") else x["titulo"]
            for x in _load().get("items", []) if _local(x["at"]).date() == day]
