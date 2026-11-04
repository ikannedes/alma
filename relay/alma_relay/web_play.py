"""API de "Jugar con Alma" para los juegos nuevos (play.py; PLAN-JUEGOS del dueño, 2026-10-31).

Los juegos (en /play/<juego>/, servidos por Caddy solo con la sesión del dueño) usan el puente /play/_alma/alma.js:
  GET  /app/play                       lista de juegos, récord contra Alma, su ánimo y el presupuesto del día
  POST /app/play/{juego}/start         empieza (o retoma) la partida; Alma puede no querer (enferma, triste, cansada)
  GET  /app/play/{juego}               la partida abierta, con la jugada de Alma pendiente de aplicar
  POST /app/play/{juego}/move          turno de Alma: estado, jugadas legales, historial y snapshot del juego
  POST /app/play/{juego}/save          guardar la partida (snapshot del juego) sin turno de Alma
  POST /app/play/{juego}/seen          el juego ya aplicó la jugada de Alma
  POST /app/play/{juego}/event         empieza, buena/mala jugada, gana/pierde, farol descubierto → robot (game_event)
  POST /app/play/{juego}/resume        reintenta si la partida quedó pausada ("Alma se quedó pensando")
"""

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import notify, play

router = APIRouter()
REMIND_EVERY_S = 1800
_loop_task: asyncio.Task | None = None


def _web():
    from . import web
    return web


def _guard(request: Request):
    w = _web()
    return None if w._logged(request) else w._need_login()


def _bad(msg: str, code: int = 400):
    return JSONResponse({"error": msg}, status_code=code)


async def _robot(game: str, tipo: str, reaccion: str = "") -> bool:
    return await _web().hub.send({"t": "game_event", "juego": game, "tipo": tipo, "reaccion": reaccion})


@router.get("/app/play")
def overview(request: Request):
    if (r := _guard(request)):
        return r
    return play.overview(dict(_web().hub.state))


@router.post("/app/play/{game}/start")
async def start(game: str, request: Request):
    if (r := _guard(request)):
        return r
    if game not in play.GAMES:
        return _bad("juego desconocido", 404)
    body = await request.json() if (await request.body()) else {}
    res = await asyncio.to_thread(play.start, game, dict(_web().hub.state), None, bool(body.get("new")))
    if res.get("ok") and not res.get("resumed"):
        await _robot(game, "empieza")
    return res


@router.get("/app/play/{game}")
def match(game: str, request: Request):
    if (r := _guard(request)):
        return r
    if game not in play.GAMES:
        return _bad("juego desconocido", 404)
    m = play.get(game)
    return {"match": m, "paused_text": play.PAUSE_TEXT.get((m or {}).get("paused") or "")}


def _parse_move(body: dict) -> tuple[dict, str | None]:
    legal = body.get("legal")
    if not isinstance(legal, list) or not legal:
        return {}, "faltan las jugadas legales"
    clean = []
    for m in legal:
        if isinstance(m, dict) and m.get("id") is not None:
            clean.append({"id": str(m["id"])[:40], "label": str(m.get("label", m["id"]))[:80]})
        elif isinstance(m, (str, int)):
            clean.append({"id": str(m)[:40], "label": str(m)[:80]})
    if len(clean) > play.MAX_LEGAL:
        return {}, f"demasiadas jugadas ({len(clean)}): agrúpalas"
    hist = [str(h)[:120] for h in (body.get("history") or [])][-12:]
    return {"state": str(body.get("state") or "")[:4000], "legal": clean, "history": hist}, None


async def _think(game: str, match_id: str, req: dict, delay: float) -> None:
    """Partida lenta: Alma piensa un rato, juega y avisa."""
    try:
        await asyncio.sleep(delay)
        choice = await asyncio.to_thread(play.choose, game, req["state"], req["legal"], req["history"],
                                         dict(_web().hub.state))
        play.alma_moved(game, match_id, choice)
        g = play.GAMES[game]
        notify.push("game", f"{g['emoji']} Ya jugué en {g['title']}", (choice["pensamiento"] or "Te toca.") + " Te toca.",
                    url=f"/play/{game}/")
    except play.Paused as e:
        play.set_request(game, match_id, req, paused=str(e))
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"[alma-relay] jugar {game}: {type(e).__name__}", flush=True)
        play.set_request(game, match_id, req, paused="pensando")
    finally:
        play._tasks.pop(match_id, None)


def _schedule(game: str, match_id: str, req: dict, delay: float) -> None:
    t = play._tasks.get(match_id)
    if t and not t.done():
        return
    play._tasks[match_id] = asyncio.get_running_loop().create_task(_think(game, match_id, req, delay))


@router.post("/app/play/{game}/move")
async def move(game: str, request: Request):
    if (r := _guard(request)):
        return r
    if game not in play.GAMES:
        return _bad("juego desconocido", 404)
    body = await request.json()
    mid = str(body.get("match") or "")
    m = play.get(game)
    if not m or m["id"] != mid:
        return _bad("no hay esa partida abierta", 409)
    req, err = _parse_move(body)
    if err:
        return _bad(err)
    if "snapshot" in body:
        play.save_snapshot(game, mid, body.get("snapshot"))
    if body.get("owner_moved", True):
        add = play.owner_moved(game, mid)
        if add:
            from . import playstrategy
            playstrategy._send_play(add)   # bienestar del día y un poquito de ejercicio (como los otros juegos)
    g = play.GAMES[game]
    rs = dict(_web().hub.state)
    if g["realtime"]:
        try:
            choice = await asyncio.wait_for(asyncio.to_thread(play.choose, game, req["state"], req["legal"],
                                                              req["history"], rs, None, play.REALTIME_TIMEOUT_S, 1),
                                            timeout=play.REALTIME_TIMEOUT_S + 0.5)
            return {"move": choice}
        except (asyncio.TimeoutError, play.Paused) as e:
            return {"late": True, "reason": str(e) if isinstance(e, play.Paused) else "tarde"}
    if g["async"] and body.get("async", True):
        play.set_request(game, mid, req)
        _schedule(game, mid, req, play.think_delay(rs))
        return {"pending": True}
    try:
        choice = await asyncio.to_thread(play.choose, game, req["state"], req["legal"], req["history"], rs)
    except play.Paused as e:
        play.set_request(game, mid, req, paused=str(e))
        return {"paused": str(e), "text": play.PAUSE_TEXT.get(str(e), "")}
    play.alma_moved(game, mid, choice)
    return {"move": choice}


@router.post("/app/play/{game}/resume")
async def resume(game: str, request: Request):
    if (r := _guard(request)):
        return r
    m = play.load()["matches"].get(game)
    if not m or not m.get("request"):
        return {"ok": False}
    play.set_request(game, m["id"], m["request"])
    _schedule(game, m["id"], m["request"], 0)
    return {"ok": True, "pending": True}


@router.post("/app/play/{game}/save")
async def save(game: str, request: Request):
    """Guardar la partida sin pedirle jugada a Alma (p. ej. después de aplicar la suya o de colocar barcos)."""
    if (r := _guard(request)):
        return r
    body = await request.json()
    return {"ok": play.save_snapshot(game, str(body.get("match") or ""), body.get("snapshot"))}


@router.post("/app/play/{game}/seen")
async def seen(game: str, request: Request):
    if (r := _guard(request)):
        return r
    body = await request.json()
    play.mark_seen(game, str(body.get("match") or ""))
    return {"ok": True}


@router.post("/app/play/{game}/event")
async def event(game: str, request: Request):
    if (r := _guard(request)):
        return r
    if game not in play.GAMES:
        return _bad("juego desconocido", 404)
    body = await request.json()
    tipo = body.get("type")
    if tipo not in play.EVENT_TYPES:
        return _bad("tipo de evento desconocido")
    mid = str(body.get("match") or "")
    reac = body.get("reaccion") if body.get("reaccion") in play.REACTIONS else ""
    robot = await _robot(game, tipo, reac)
    out = {"ok": True, "robot": robot}
    if tipo in play.END_TYPES:
        e = play.finish(game, mid, play.END_TYPES[tipo])
        out["result"] = e
        if e and play.GAMES[game]["realtime"]:   # sin turnos: cuenta lo que duró la partida (tope 10 min)
            from . import playstrategy
            playstrategy._send_play(int(min(e["seconds"], 600)))
        hist = [str(h)[:120] for h in (body.get("history") or [])][-40:]
        if e and hist:
            asyncio.get_running_loop().create_task(asyncio.to_thread(play.note_habit, game, hist))
        t = play._tasks.pop(mid, None)
        if t:
            t.cancel()
    return out


async def _loop() -> None:
    """Retoma lo que Alma estaba pensando antes de un reinicio y recuerda (una vez) las partidas lentas olvidadas."""
    for g, m in play.load()["matches"].items():
        if m.get("request") and not m.get("paused"):
            _schedule(g, m["id"], m["request"], 5)
    while True:
        try:
            for g in play.due_reminders():
                info = play.GAMES[g]
                notify.push("game", f"{info['emoji']} Alma te espera en {info['title']}", "Te toca desde ayer. Cuando quieras.",
                            url=f"/play/{g}/")
        except Exception as e:
            print(f"[alma-relay] jugar: recordatorios ({type(e).__name__})", flush=True)
        await asyncio.sleep(REMIND_EVERY_S)


def start_background() -> None:
    global _loop_task
    _loop_task = asyncio.get_running_loop().create_task(_loop())

