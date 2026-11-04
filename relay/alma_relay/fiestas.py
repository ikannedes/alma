"""Caras de festividades en el robot (dueño, 2026-11-02: "el 14 de febrero, que salga unas 10, 15 veces en la pantalla,
como sus actividades normales, recordando que hoy es ese día").

El calendario dice qué cara toca hoy (zona del dueño); si el robot no la tiene en su SD, se le manda en trozos
{"t":"cara","nombre","seq","last","b64"} y luego {"t":"fiesta","nombre"}; él contesta cara_ok / cara_error. Las
veces que sale en el día las decide el robot (fiesta.c). Las caras son los AVI de alma/tools/caras (generar_cara.py y
fiestas.py), copiados a <data_dir>/caras/<nombre>.avi.
"""

import base64
import datetime as dt
import json
import os
import threading
import time

from . import settings

CHUNK = 9000          # bytes por trozo (en base64 ~12 KB: cabe en UPLINK_MAX del robot, 16 KB)

FIJAS = {(1, 1): "ano_nuevo", (1, 6): "reyes", (2, 2): "candelaria", (2, 14): "san_valentin", (2, 24): "bandera",
         (3, 17): "san_patricio", (3, 21): "primavera", (4, 22): "dia_tierra", (4, 30): "dia_nino",
         (5, 10): "dia_madres", (5, 15): "dia_maestro", (6, 21): "verano", (9, 15): "independencia",
         (9, 16): "independencia", (10, 31): "halloween", (11, 1): "muertos", (11, 2): "muertos",
         (12, 24): "navidad", (12, 25): "navidad"}
FIJAS.update({(12, d): "posadas" for d in range(16, 24)})
# Año Nuevo Chino (primer día del año lunar)
CHINO = {2026: (2, 17), 2027: (2, 6), 2028: (1, 26), 2029: (2, 13), 2030: (2, 3), 2031: (1, 23), 2032: (2, 11),
         2033: (1, 31), 2034: (2, 19), 2035: (2, 8)}

_lock = threading.Lock()


def pascua(year: int) -> dt.date:
    """Domingo de Resurrección (computus gregoriano anónimo)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month = (h + l_ - 7 * m + 114) // 31
    day = (h + l_ - 7 * m + 114) % 31 + 1
    return dt.date(year, month, day)


def dia_padre(year: int) -> dt.date:
    """Tercer domingo de junio."""
    d = dt.date(year, 6, 1)
    return d + dt.timedelta(days=(6 - d.weekday()) % 7 + 14)


def _cumple(day: dt.date) -> bool:
    """Un hito de edad de Alma (1 semana, 1 mes, 6 meses, cada año) que se cumplió hoy."""
    from . import alarms, milestones
    for m in milestones.listing()["milestones"]:
        if m.get("kind") == "edad" and dt.datetime.fromtimestamp(m["at"], alarms.tz()).date() == day:
            return True
    return False


def hoy(now: float | None = None) -> str:
    """La cara de hoy ("" si no hay). Primero su cumpleaños, luego las móviles y luego las de fecha fija."""
    from . import alarms
    day = dt.datetime.fromtimestamp(now if now is not None else time.time(), alarms.tz()).date()
    try:
        if _cumple(day):
            return "cumpleanos"
    except Exception:   # sin hitos todavía
        pass
    p = pascua(day.year)
    if day == p:
        return "pascua"
    if p - dt.timedelta(days=49) <= day <= p - dt.timedelta(days=47):   # sábado a martes de carnaval
        return "carnaval"
    if day == dia_padre(day.year):
        return "dia_padre"
    if CHINO.get(day.year) == (day.month, day.day):
        return "ano_nuevo_chino"
    return FIJAS.get((day.month, day.day), "")


def _path(name: str) -> str:
    return os.path.join(settings.data_dir(), name)


def cara_path(nombre: str) -> str:
    return os.path.join(settings.data_dir(), "caras", nombre + ".avi")


def _load() -> dict:
    try:
        with open(_path("fiestas.json"), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def _save(d: dict) -> None:
    with open(_path("fiestas.json") + ".tmp", "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(_path("fiestas.json") + ".tmp", _path("fiestas.json"))


def en_robot() -> list[str]:
    return list(_load().get("en_robot", []))


def _trozos(nombre: str) -> list[dict]:
    with open(cara_path(nombre), "rb") as f:
        return trozos(f.read(), nombre)


def trozos(data: bytes, nombre: str, ext: str = "avi") -> list[dict]:
    """El archivo en trozos {"t":"cara"}; con ext "mp3" el robot lo guarda como /test/<nombre>.mp3 (fiesta.h). El primero
    lleva "size": el robot reserva justo eso."""
    n = (len(data) + CHUNK - 1) // CHUNK
    return [{"t": "cara", "nombre": nombre, **({"ext": ext} if ext != "avi" else {}), **({"size": len(data)} if seq == 0 else {}),
             "seq": seq, "last": seq == n - 1,
             "b64": base64.b64encode(data[seq * CHUNK:(seq + 1) * CHUNK]).decode()} for seq in range(n)]


def mensajes(nombre: str, now: float | None = None) -> list[dict]:
    """Lo que hay que mandarle al robot para la fiesta `nombre`: la cara en trozos si no la tiene (y no se le mandó
    hace menos de 10 min) y luego la fiesta. Sin fiesta: {"t":"fiesta","nombre":""}."""
    now = now if now is not None else time.time()
    if not nombre:
        return [{"t": "fiesta", "nombre": ""}]
    out = []
    with _lock:
        d = _load()
        sent = d.get("enviando", {})
        if nombre not in d.get("en_robot", []) and now - sent.get(nombre, 0) > 600 and os.path.exists(cara_path(nombre)):
            out += _trozos(nombre)
            sent[nombre] = now
            d["enviando"] = sent
            _save(d)
    out.append({"t": "fiesta", "nombre": nombre})
    return out


PRECARGA_CADA_S = 15 * 60


def precarga(dormida: bool, now: float | None = None) -> list[dict]:
    """Todas las caras a su SD con tiempo (dueño, 2026-11-02: "tienes que pasarle todas esas animaciones"). Mientras
    sube una, la pantalla muestra "Updating": solo de noche (20:00–8:00) y con Alma dormida, una cada 15 min, la
    primera que le falte y que no esté en camino."""
    from . import alarms
    now = now if now is not None else time.time()
    hora = dt.datetime.fromtimestamp(now, alarms.tz()).hour
    if not dormida or 8 <= hora < 20:
        return []
    try:
        todas = sorted(f[:-4] for f in os.listdir(_path("caras")) if f.endswith(".avi"))
    except FileNotFoundError:
        return []
    with _lock:
        d = _load()
        if now - d.get("precarga_at", 0) < PRECARGA_CADA_S:
            return []
        sent = d.get("enviando", {})
        falta = [n for n in todas if n not in d.get("en_robot", []) and now - sent.get(n, 0) > 3600]
        if not falta:
            return []
        nombre = falta[0]
        out = _trozos(nombre)
        sent[nombre] = now
        d["enviando"], d["precarga_at"] = sent, now
        _save(d)
    return out


def on_result(msg: dict) -> None:
    """cara_ok: el robot ya la tiene en su SD; cara_error: se puede volver a mandar."""
    nombre = str(msg.get("nombre", ""))
    with _lock:
        d = _load()
        d.setdefault("enviando", {}).pop(nombre, None)
        if msg.get("t") == "cara_ok" and nombre and nombre not in d.setdefault("en_robot", []):
            d["en_robot"].append(nombre)
        _save(d)
    print(f"[alma-relay] fiesta: {msg.get('t')} {nombre}", flush=True)
