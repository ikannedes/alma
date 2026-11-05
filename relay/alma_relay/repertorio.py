"""Los movimientos propios de Alma (dueño, 2026-11-05: "¿podría el robot inventar sus propios movimientos?", las tres
vías juntas; firmware: app/repertorio.h).

- Trucos (vía 3): cada noche Haiku propone 1–2 según cómo fue el día (haiku.propose_moves); aquí se validan (rango
  observado de cada servo, pies cerca de 90 para no caerse, duraciones) y se guardan como "nuevo". El robot los enseña
  (bhv_new_trick) y avisa tu reacción ({"t":"event","ev":"truco_res","id","res"}): "gusta" → aprendido; "regaño" →
  olvidado; "nada" tres veces → olvidado.
- Inventos (vía 2): el robot inventa combinaciones, se queda con las estables y las manda ({"t":"event","ev":"invento"});
  aquí se respaldan para devolvérselas si reinicia.

Al conectar, el robot recibe lo vigente: {"t":"truco",…} y {"t":"invento",…} (mensajes_robot). Solo si su firmware lo
sabe ("rep_v" en el estado).
"""

import json
import os
import threading
import time
import uuid

from . import settings

# R10: rango observado de cada servo en los 317 .mot (firmware motion_player.c)
S_MIN, S_MAX = (40, 53, 0, 30), (160, 130, 150, 180)
FOOT_DEV = 25          # pies (S2, S3) a no más de 25° de 90: inclinan todo el cuerpo
MS_MIN, MS_MAX = 150, 1500
MAX_FRAMES = 16
PASOS = ("adelante", "atras", "izquierda", "derecha")
MAX_INVENTOS = 12
TRIES = 3

_lock = threading.Lock()


def _path() -> str:
    return os.path.join(settings.data_dir(), "repertorio.json")


def _load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    d.setdefault("trucos", [])
    d.setdefault("inventos", [])
    return d


def _save(d: dict) -> None:
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path())


def validate(cuadros) -> list | None:
    """Cuadros alma-anim/1 seguros, o None. Termina en la pose neutra (se agrega si falta)."""
    if not isinstance(cuadros, list) or not 1 <= len(cuadros) <= MAX_FRAMES:
        return None
    out = []
    for c in cuadros:
        if not isinstance(c, dict):
            return None
        if "paso" in c:
            if c["paso"] not in PASOS:
                return None
            out.append({"paso": c["paso"]})
            continue
        pose, ms = c.get("pose"), c.get("ms")
        if not (isinstance(pose, list) and len(pose) == 4 and all(isinstance(v, (int, float)) for v in pose)
                and isinstance(ms, (int, float))):
            return None
        p = [int(round(v)) for v in pose]
        if any(not S_MIN[i] <= p[i] <= S_MAX[i] for i in range(4)) or any(abs(p[i] - 90) > FOOT_DEV for i in (2, 3)):
            return None
        if not MS_MIN <= ms <= MS_MAX:
            return None
        out.append({"pose": p, "ms": int(ms)})
    if sum("pose" in c for c in out) < 2:
        return None
    if out[-1].get("pose") != [90, 90, 90, 90]:
        out.append({"pose": [90, 90, 90, 90], "ms": 400})
    return out[:MAX_FRAMES + 1]


def add_tricks(propuestas: list, now: float | None = None) -> list[dict]:
    """Guarda las propuestas válidas de Haiku como "nuevo"; devuelve las guardadas."""
    now = now or time.time()
    nuevos = []
    with _lock:
        d = _load()
        for p in propuestas or []:
            cuadros = validate(p.get("cuadros")) if isinstance(p, dict) else None
            if not cuadros:
                continue
            t = {"id": uuid.uuid4().hex[:12], "nombre": str(p.get("nombre") or "truco")[:23], "cuadros": cuadros,
                 "estado": "nuevo", "creado": now, "intentos": 0, "por_que": str(p.get("por_que") or "")[:200]}
            d["trucos"].append(t)
            nuevos.append(t)
        _save(d)
    return nuevos


def on_result(msg: dict, now: float | None = None) -> str | None:
    """{"ev":"truco_res","id","res"} del robot: actualiza el truco. Devuelve su estado nuevo."""
    with _lock:
        d = _load()
        for t in d["trucos"]:
            if t["id"] != msg.get("id"):
                continue
            t["intentos"] = int(msg.get("intento") or t["intentos"] + 1)
            res = msg.get("res")
            if res == "gusta":
                t["estado"], t["aprendido"] = "aprendido", now or time.time()
            elif res == "regaño" or t["intentos"] >= TRIES:
                t["estado"] = "olvidado"
            _save(d)
            return t["estado"]
    return None


def on_invention(msg: dict, now: float | None = None) -> bool:
    """{"ev":"invento","nombre","cuadros"} del robot: se respalda (los más nuevos, hasta MAX_INVENTOS)."""
    cuadros = msg.get("cuadros")
    if not isinstance(cuadros, list) or not cuadros:
        return False
    with _lock:
        d = _load()
        d["inventos"] = [i for i in d["inventos"] if i["nombre"] != msg.get("nombre")]
        d["inventos"].append({"nombre": str(msg.get("nombre"))[:23], "cuadros": cuadros, "at": now or time.time()})
        d["inventos"] = d["inventos"][-MAX_INVENTOS:]
        _save(d)
    return True


def mensajes_robot() -> list[dict]:
    """Lo vigente para el robot al conectar: trucos nuevos y aprendidos, e inventos."""
    with _lock:
        d = _load()
    out = [{"t": "truco", "id": t["id"], "nombre": t["nombre"], "estado": t["estado"], "cuadros": t["cuadros"]}
           for t in d["trucos"] if t["estado"] in ("nuevo", "aprendido")]
    out += [{"t": "invento", "nombre": i["nombre"], "cuadros": i["cuadros"]} for i in d["inventos"]]
    return out


def today_summary(now: float | None = None) -> dict | None:
    """Para el pase nocturno: qué trucos tiene y cuáles aprendió hoy (Haiku propone sobre eso)."""
    now = now or time.time()
    with _lock:
        d = _load()
    aprendidos = [t["nombre"] for t in d["trucos"] if t["estado"] == "aprendido"]
    hoy = [t["nombre"] for t in d["trucos"] if t.get("aprendido", 0) > now - 24 * 3600]
    pendientes = [t["nombre"] for t in d["trucos"] if t["estado"] == "nuevo"]
    if not (aprendidos or pendientes or d["inventos"]):
        return None
    return {"aprendidos": aprendidos, "aprendidos_hoy": hoy, "por_ensenar": pendientes, "inventos": len(d["inventos"])}


def pending_count() -> int:
    with _lock:
        return sum(t["estado"] == "nuevo" for t in _load()["trucos"])
