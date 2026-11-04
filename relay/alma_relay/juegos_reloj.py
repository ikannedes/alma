"""Juegos del reloj y Preguntas (dueño, 2026-11-01): mosqueta, ping pong, palabras (rueda de letras), gato y preguntas tipo Preguntados.

Mismo principio que los juegos de la app (play.py): Alma empieza principiante y llega a experta con ~100 partidas de
cada juego (un poco antes con las que pierde), puede no querer jugar si está enferma, cansada o triste, y cada partida
cuenta para su bienestar y su ejercicio. La diferencia: aquí no hay Haiku. Alma juega en el reloj con una lógica local
que usa su nivel (la decisión es instantánea y funciona sin conexión), y las preguntas son un banco fijo de 500
(preguntas/parte*.json, escritas para esto; sin Haiku; 680 con Pokémon, cultura pop y geek). Preguntas también se juega desde la app web.

data/juegos_reloj.json guarda el registro de partidas, cuándo salió cada pregunta y cómo le fue al dueño con cada una.
"""

import datetime as dt
import glob
import json
import os
import random
import threading
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import play, settings

router = APIRouter()
_lock = threading.Lock()
_rng = random.SystemRandom()

JUEGOS = {
    "mosqueta": "Mosqueta", "pingpong": "Ping pong", "palabras": "Palabras", "gato": "Gato", "preguntas": "Preguntas",
}
GANADORES = ("alma", "owner", "draw")
TIPOS = ("empieza", "buena_jugada", "mala_jugada")
SKILL_GAMES = play.SKILL_GAMES        # la misma curva de los juegos de la app
NO_REPETIR_S = 30 * 86400             # una pregunta no vuelve a salir en 30 días (si alcanzan)
CATEGORIAS = {"cultura_general": "Cultura general", "ciencia": "Ciencia", "historia": "Historia",
              "geografia": "Geografía", "tecnologia": "Tecnología", "programacion": "Programación",
              "arte": "Arte", "deportes": "Deportes", "pokemon": "Pokémon", "cultura_pop": "Cultura pop",
              "cultura_geek": "Cultura geek"}
KEEP_LOG = 500

_banco: list[dict] | None = None


# ---------- datos ----------
def _path() -> str:
    return os.path.join(settings.data_dir(), "juegos_reloj.json")


def load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    d.setdefault("log", [])
    d.setdefault("vistas", {})
    d.setdefault("stats", {})
    return d


def _save(d: dict) -> None:
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, _path())


def banco() -> list[dict]:
    """Las preguntas válidas de preguntas/parte*.json (las mal formadas se descartan)."""
    global _banco
    if _banco is None:
        todas = []
        for p in sorted(glob.glob(os.path.join(os.path.dirname(__file__), "preguntas", "parte*.json"))):
            with open(p, encoding="utf-8") as f:
                todas += [q for q in json.load(f) if valida(q)]
        # la misma pregunta en dos categorías: se queda la de la categoría específica, no la de cultura general
        todas.sort(key=lambda q: q["cat"] == "cultura_general")
        out, ids, textos = [], set(), set()
        for q in todas:
            t = q["q"].strip().lower()
            if q["id"] not in ids and t not in textos:
                ids.add(q["id"])
                textos.add(t)
                out.append(q)
        _banco = out
    return _banco


def valida(q: dict) -> bool:
    ops = q.get("ops")
    return (isinstance(q.get("id"), str) and q.get("cat") in CATEGORIAS and q.get("dif") in (1, 2, 3)
            and isinstance(q.get("q"), str) and 5 <= len(q["q"]) <= 140 and "¿" in q["q"] and q["q"].endswith("?")
            and isinstance(ops, list) and len(ops) == 4 and len(set(ops)) == 4
            and all(isinstance(o, str) and 0 < len(o) <= 34 for o in ops)
            and q.get("ok") in (0, 1, 2, 3))


# ---------- nivel de Alma ----------
def skill(d: dict, juego: str) -> float:
    log = [e for e in d["log"] if e["juego"] == juego]
    lost = sum(1 for e in log if e["winner"] == "owner")
    return round(min(1.0, (len(log) + 0.5 * lost) / SKILL_GAMES) ** 0.8, 3)


def nivel(juego: str) -> dict:
    d = load()
    sk = skill(d, juego)
    log = [e for e in d["log"] if e["juego"] == juego]
    return {"skill": sk, "nivel": play.level_name(sk), "partidas": len(log),
            "record": {w: sum(1 for e in log if e["winner"] == w) for w in GANADORES}}


def _hoy(now: float) -> str:
    from . import alarms
    return dt.datetime.fromtimestamp(now, alarms.tz()).strftime("%Y-%m-%d")


def terminar(juego: str, ganador: str, segundos: int, puntos: dict | None, now: float | None = None) -> dict:
    now = now or time.time()
    e = {"juego": juego, "winner": ganador, "seconds": int(max(0, min(segundos, 3600))), "ended": now,
         "date": _hoy(now), "puntos": puntos or {}}
    with _lock:
        d = load()
        d["log"] = (d["log"] + [e])[-KEEP_LOG:]
        _save(d)
    return e


def today_summary(now: float | None = None) -> list[dict]:
    """Para el diario nocturno: qué se jugó hoy en el reloj y en Preguntas."""
    now = now or time.time()
    hoy = _hoy(now)
    out: dict[str, dict] = {}
    for e in load()["log"]:
        if e["date"] != hoy:
            continue
        o = out.setdefault(e["juego"], {"juego": JUEGOS.get(e["juego"], e["juego"]), "partidas": 0, "gano_alma": 0,
                                        "gano_dueño": 0})
        o["partidas"] += 1
        o["gano_alma"] += e["winner"] == "alma"
        o["gano_dueño"] += e["winner"] == "owner"
    return list(out.values())


# ---------- preguntas ----------
def _pesos(sk: float) -> dict[int, float]:
    """De principiante salen sobre todo fáciles; de experta, más difíciles (dueño: "mientras más juego, más difícil")."""
    return {1: 1.0 - 0.7 * sk, 2: 0.6 + 0.2 * sk, 3: 0.1 + 0.9 * sk}


def alma_responde(q: dict, sk: float, rng: random.Random = _rng) -> dict:
    """Alma también contesta: acierta más con su nivel y menos con las difíciles."""
    p = max(0.15, min(0.95, 0.35 + 0.55 * sk - 0.12 * (q["dif"] - 1)))
    ok = rng.random() < p
    return {"acierta": ok, "ms": int(rng.uniform(2500, 9000) * (1.2 - 0.5 * sk))}


def lote(n: int = 10, cat: str | None = None, now: float | None = None, rng: random.Random = _rng) -> dict:
    """n preguntas que no hayan salido en 30 días (si alcanzan), con las opciones revueltas y la respuesta de Alma."""
    now = now or time.time()
    n = max(1, min(int(n), 20))
    d = load()
    sk = skill(d, "preguntas")
    pool = [q for q in banco() if not cat or q["cat"] == cat]
    frescas = [q for q in pool if now - d["vistas"].get(q["id"], 0) > NO_REPETIR_S]
    if len(frescas) < n:                                   # ya salieron casi todas: las menos recientes
        frescas = sorted(pool, key=lambda q: d["vistas"].get(q["id"], 0))[:max(n * 3, len(frescas))]
    pesos = _pesos(sk)
    elegidas: list[dict] = []
    cand = list(frescas)
    while cand and len(elegidas) < n:
        q = rng.choices(cand, weights=[pesos[c["dif"]] for c in cand])[0]
        cand.remove(q)
        elegidas.append(q)
    out = []
    for q in elegidas:
        orden = list(range(4))
        rng.shuffle(orden)
        out.append({"id": q["id"], "cat": q["cat"], "categoria": CATEGORIAS[q["cat"]], "dif": q["dif"], "q": q["q"],
                    "ops": [q["ops"][i] for i in orden], "ok": orden.index(q["ok"]), "dato": q.get("dato", ""),
                    "alma": alma_responde(q, sk, rng)})
    with _lock:
        d = load()
        for q in out:
            d["vistas"][q["id"]] = now
        _save(d)
    return {"preguntas": out, "nivel": play.level_name(sk), "skill": sk, "total": len(banco())}


def responder(qid: str, acerto: bool) -> None:
    with _lock:
        d = load()
        s = d["stats"].setdefault(qid, [0, 0])
        s[0] += bool(acerto)
        s[1] += 1
        _save(d)


# ---------- con el robot y el cuidado ----------
def _cuerpo() -> str:
    from . import reloj
    return reloj.arb().where()["cuerpo"]


async def _al_robot(msg: dict) -> bool:
    """El robot reacciona solo si Alma vive en él (si está en el reloj, el reloj lo aplica a su núcleo)."""
    from . import web
    if _cuerpo() != "robot":
        return False
    return await web.hub.send(msg)


async def evento(juego: str, tipo: str, ganador: str | None, segundos: int, puntos: dict | None) -> dict:
    from . import care
    out: dict = {"ok": True}
    if ganador:
        e = terminar(juego, ganador, segundos, puntos)
        out["nivel"] = nivel(juego)
        try:
            care.add_exercise("juegos", e["seconds"])
        except Exception:
            pass
        if _cuerpo() == "robot" and e["seconds"] >= 1:
            from . import web
            await web.hub.send({"t": "remote_play", "add_s": int(min(e["seconds"], 600))})
        tipo = {"alma": "gana_alma", "owner": "pierde_alma", "draw": "empate"}[ganador]
    out["robot"] = await _al_robot({"t": "game_event", "juego": juego, "tipo": tipo, "reaccion": ""})
    return out


def empezar(juego: str) -> dict:
    from . import web
    razon = play.refuse_reason(web.hub.state or {})
    return {"ok": razon is None, "razon": razon} | nivel(juego)


# ---------- API (reloj y celular con su llave; app web con la sesión) ----------
def _quien(request: Request) -> str | None:
    from . import reloj, web
    if web._logged(request):
        return "app"
    return reloj.device(request)


def _deny():
    return JSONResponse({"error": "sin permiso"}, status_code=401)


@router.get("/v1/juegos")
@router.get("/app/juegos")
def juegos(request: Request):
    if not _quien(request):
        return _deny()
    return {"juegos": [{"id": k, "titulo": v} | nivel(k) for k, v in JUEGOS.items()], "categorias": CATEGORIAS,
            "preguntas": len(banco())}


@router.post("/v1/juegos/{juego}/empezar")
@router.post("/app/juegos/{juego}/empezar")
async def juegos_empezar(juego: str, request: Request):
    if not _quien(request):
        return _deny()
    if juego not in JUEGOS:
        return JSONResponse({"error": "juego desconocido"}, status_code=404)
    r = empezar(juego)
    if r["ok"]:
        r["robot"] = await _al_robot({"t": "game_event", "juego": juego, "tipo": "empieza", "reaccion": ""})
    return r


@router.post("/v1/juegos/{juego}/evento")
@router.post("/app/juegos/{juego}/evento")
async def juegos_evento(juego: str, request: Request):
    if not _quien(request):
        return _deny()
    if juego not in JUEGOS:
        return JSONResponse({"error": "juego desconocido"}, status_code=404)
    b = await request.json()
    ganador = b.get("ganador")
    tipo = b.get("tipo")
    if ganador not in GANADORES + (None,) or (ganador is None and tipo not in TIPOS):
        return JSONResponse({"error": "evento inválido"}, status_code=400)
    return await evento(juego, tipo, ganador, int(b.get("segundos") or 0), b.get("puntos"))


@router.get("/v1/juegos/preguntas")
@router.get("/app/juegos/preguntas")
def juegos_preguntas(request: Request, n: int = 10, cat: str | None = None):
    if not _quien(request):
        return _deny()
    if cat and cat not in CATEGORIAS:
        return JSONResponse({"error": "categoría desconocida"}, status_code=400)
    return lote(n, cat)


@router.post("/v1/juegos/preguntas/respuesta")
@router.post("/app/juegos/preguntas/respuesta")
async def juegos_respuesta(request: Request):
    if not _quien(request):
        return _deny()
    b = await request.json()
    if not isinstance(b.get("id"), str):
        return JSONResponse({"error": "id"}, status_code=400)
    responder(b["id"], bool(b.get("acerto")))
    return {"ok": True}
