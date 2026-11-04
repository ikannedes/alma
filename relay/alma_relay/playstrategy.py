"""Alma juega en PlayStrategy como bot (dueño, 2026-10-31: "usa juegos ya existentes, no los crees tú").

El dueño la reta desde playstrategy.org (tablero, animaciones y avisos "It's your turn!" son de PlayStrategy). Este
servicio corre en el servidor con el token de la cuenta de Alma (bot:play, pegado en la app; nunca se muestra):
escucha /api/stream/event, acepta solo los retos del dueño en backgammon u oware, sigue cada partida por
/api/bot/game/stream/{id}, calcula las jugadas legales (backgammon.py, oware.py: la API no las da), Haiku elige en
personaje (games.choose) y su comentario va al chat de la partida. El tiempo que juega el dueño cuenta para el
bienestar (remote_play al robot) y las partidas entran al diario (games.ps_update / ps_finish).
"""

import asyncio
import time

import httpx

from . import backgammon as bg
from . import games, oware, settings

BASE = "https://playstrategy.org"
SUPPORTED = ("backgammon", "oware")
MAX_TRIES = 6          # acciones a probar si PlayStrategy rechaza una (no debería: mismas reglas)
RETRY_MIN_S, RETRY_MAX_S = 5, 300

RULES = {
    "oware": ("Oware (abapa) en PlayStrategy. Cada lado tiene 6 casas. Tomas todas las semillas de una casa tuya y las "
              "siembras una por casa en sentido antihorario (si son 12 o más, te saltas la casa de donde salieron). Si la "
              "última cae en una casa del rival y la deja con 2 o 3, las capturas, y también las casas anteriores seguidas "
              "del rival con 2 o 3; pero si así lo dejarías sin ninguna semilla, no capturas nada. Si el rival se quedó "
              "sin semillas, tienes que darle. Gana quien capture más de 24."),
    "backgammon": ("Backgammon en PlayStrategy. 15 fichas por lado que avanzan en sentidos opuestos; tus puntos se "
                   "cuentan desde tu lado (1 = el más cerca de salir, 24 = el más lejano). Con dos dados mueves una "
                   "ficha por dado (con dobles, cuatro movimientos). Una ficha sola (blot) puede ser golpeada y va a la "
                   "barra; desde la barra hay que entrar antes de mover otra. Con todas en tu casa (puntos 1–6) las "
                   "sacas. Gana quien saque sus 15 primero. Eliges el turno completo de la lista: ya trae solo lo "
                   "que se puede jugar con tus dados."),
}

STATUS: dict = {"state": "sin token", "user": None, "bot": None, "games": {}, "error": None}
_task: asyncio.Task | None = None
_games: dict[str, asyncio.Task] = {}


# ---- HTTP ----

class Api:
    def __init__(self, token: str, transport=None):
        self.c = httpx.AsyncClient(base_url=BASE, headers={"Authorization": f"Bearer {token}"}, transport=transport,
                                   timeout=httpx.Timeout(30.0, read=120.0))   # los streams mandan algo cada 70 s

    async def account(self) -> dict:
        r = await self.c.get("/api/account")
        r.raise_for_status()
        return r.json()

    async def stream(self, path: str):
        import json
        async with self.c.stream("GET", path) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if line.strip():
                    yield json.loads(line)

    async def post(self, path: str, data: dict | None = None) -> httpx.Response:
        return await self.c.post(path, data=data)

    async def close(self) -> None:
        await self.c.aclose()


# ---- elegir la jugada ----

def _mood() -> dict:
    from . import web
    return dict(web.hub.state or {})


def _tokens(moves: str) -> list[str]:
    return [t for turn in (moves or "").split() for t in turn.split(",") if t]


def _oware_plan(moves: str, seat: int) -> tuple[list[str], str, str]:
    """(acciones a probar en orden, comentario, origen de la decisión)."""
    toks = _tokens(moves)
    b = oware.replay(toks)
    if b.turn != seat:
        return [], "", "no es mi turno"
    opts = oware.options(b)
    if not opts:
        return [], "", "sin jugadas"
    best = max(range(len(opts)), key=lambda k: opts[k]["gain"])
    recent = [("Tu dueño" if (len(toks) - 1 - k) % 2 == 0 else "Tú") + " jugó " + toks[k][:2]
              for k in range(max(0, len(toks) - 4), len(toks))]
    side = "Sur (casas a1–f1)" if seat == 0 else "Norte (casas a2–f2)"
    i, comment, src = games.choose({"game": "oware", "where": " (en PlayStrategy)", "seat_name": side,
                                    "view": b.text(seat), "labels": [o["label"] for o in opts], "recent": recent,
                                    "rules": RULES["oware"], "best": best}, _mood())
    order = [i] + sorted((k for k in range(len(opts)) if k != i), key=lambda k: -opts[k]["gain"])
    return [opts[k]["uci"] for k in order], comment, src


def _bg_step(moves: str, fen: str | None, seat: int, plan: dict) -> tuple[list[str], str, str]:
    """Un paso del turno de backgammon. plan guarda el turno que eligió Haiku entre llamadas."""
    b = bg.replay(moves, fen)
    if b.player != seat:
        return [], "", "no es mi turno"
    steps = [bg.Board.uci(a) for a in b.steps()] if b.dice else []
    if b.offer or b.can_roll() or not steps:
        plan.clear()
    if b.offer:
        return ["cubey"], "", "cubo"
    if b.can_roll():
        return ["roll"], "", "dados"
    if not steps:
        return (["endturn"], "", "fin") if b.can_end_turn() else ([], "", "nada")
    if plan.get("next") and plan["next"][0] in steps:
        nxt = plan["next"].pop(0)
        return [nxt] + [s for s in steps if s != nxt], "", "plan"
    ts = bg.turns(b)
    opts = sorted((bg.describe(b, t) for t in ts), key=lambda o: -o["score"])[:games.MAX_PROMPT_MOVES]
    if len(opts) > 40:   # para Haiku: las 30 mejores y 10 al azar (a veces juega atrevida)
        opts = opts[:30] + games._rng.sample(opts[30:], 10)
    recent = []
    turns = (moves or "").split()
    if turns:
        recent = ["Tu dueño en su último turno: " + turns[-1].replace(",", " ")]
    i, comment, src = games.choose({"game": "backgammon", "where": " (en PlayStrategy)",
                                    "seat_name": "jugador 1" if seat == 0 else "jugador 2", "view": bg.text(b, seat),
                                    "labels": [o["label"] for o in opts], "recent": recent,
                                    "rules": RULES["backgammon"], "best": 0}, _mood())
    path = [bg.Board.uci(a) for a in opts[i]["path"]]
    plan["next"] = path[1:]
    return [path[0]] + [s for s in steps if s != path[0]], comment, src


# ---- partidas ----

def _send_play(add_s: int) -> None:
    """El tiempo que jugó el dueño cuenta en el bienestar del día (remote_play al robot)."""
    if add_s < 1:
        return
    from . import care, web
    try:
        care.add_exercise("juegos", add_s)   # casi no se mueve, pero algo cuenta
    except Exception as e:                 # la comida nunca debe trabar un juego
        print(f"[alma-relay] care: {type(e).__name__}", flush=True)

    async def go():
        if not await web.hub.send({"t": "remote_play", "add_s": add_s}):
            web.hub.unsent_play += add_s
    asyncio.get_running_loop().create_task(go())


async def play_game(api: Api, gid: str, me: str) -> None:
    seat = key = fen = None
    plan: dict = {}
    owner_since: float | None = None
    last_moves = played = None
    async for msg in api.stream(f"/api/bot/game/stream/{gid}"):
        t = msg.get("type")
        if t == "gameFull":
            seat = 0 if (msg.get("p1") or {}).get("id") == me else 1
            key = (msg.get("variant") or {}).get("key")
            fen = msg.get("initialFen")
            state = msg.get("state") or {}
        elif t == "gameState":
            state = msg
        else:
            continue
        if key not in SUPPORTED or seat is None:
            return
        moves, status = state.get("moves", ""), state.get("status")
        n = len(_tokens(moves))
        STATUS["games"][gid] = {"game": key, "status": status, "moves": n, "url": f"{BASE}/{gid}"}
        if status not in ("created", "started"):
            w = state.get("winner")
            winner = "draw" if not w else "alma" if w == ("p1", "p2")[seat] else "owner"
            games.ps_finish(gid, key, winner, status == "resign", n)
            STATUS["games"].pop(gid, None)
            return
        mine = state.get("activeplayer") == ("p1", "p2")[seat]
        now = time.time()
        if not mine:
            if owner_since is None:
                owner_since = now
            if moves != last_moves:
                games.ps_update(gid, key, n)
            last_moves = moves
            continue
        if owner_since is not None:   # el dueño terminó su turno
            add = int(min(now - owner_since, games.MAX_TURN_S))
            games.ps_update(gid, key, n, add)
            _send_play(add)
            owner_since = None
        last_moves = moves
        if moves != played and await _my_turn(api, gid, key, moves, fen, seat, plan):
            played = moves   # otro gameState igual (p. ej. una oferta de tablas) no repite la jugada


async def _my_turn(api: Api, gid: str, key: str, moves: str, fen: str | None, seat: int, plan: dict) -> bool:
    try:
        if key == "oware":
            cands, comment, src = await asyncio.to_thread(_oware_plan, moves, seat)
        else:
            cands, comment, src = await asyncio.to_thread(_bg_step, moves, fen, seat, plan)
    except ValueError as e:   # el historial no cuadra con las reglas: mejor no jugar a ciegas
        print(f"[alma-relay] playstrategy {gid}: {e}", flush=True)
        STATUS["error"] = f"partida {gid}: no entendí el historial"
        return False
    for uci in cands[:MAX_TRIES]:
        r = await api.post(f"/api/bot/game/{gid}/move/{uci}")
        if r.status_code == 200:
            if comment and src == "haiku":
                await api.post(f"/api/bot/game/{gid}/chat", {"room": "player", "text": comment[:140]})
            return True
        print(f"[alma-relay] playstrategy {gid}: {uci} rechazada ({r.status_code})", flush=True)
        plan.clear()
    if cands:
        STATUS["error"] = f"partida {gid}: PlayStrategy rechazó mis jugadas"
    return False


async def _on_event(api: Api, ev: dict, me: str) -> None:
    t = ev.get("type")
    if t == "challenge":
        c = ev.get("challenge") or {}
        if c.get("direction") == "out" or (c.get("challenger") or {}).get("id") == me:
            return
        owner = (settings.get("ps_owner") or "").strip().lower()
        who = ((c.get("challenger") or {}).get("id") or "").lower()
        variant = (c.get("variant") or {}).get("key")
        if not owner or who != owner:
            await api.post(f"/api/challenge/{c['id']}/decline", {"reason": "generic"})
        elif variant not in SUPPORTED:
            await api.post(f"/api/challenge/{c['id']}/decline", {"reason": "variant"})
        else:
            await api.post(f"/api/challenge/{c['id']}/accept")
    elif t == "gameStart":
        g = ev.get("game") or {}
        gid = g.get("gameId") or g.get("id")
        if gid and (g.get("variant") or {}).get("key", "backgammon") in SUPPORTED:
            start_game(api, gid, me)


def start_game(api: Api, gid: str, me: str) -> None:
    if gid in _games and not _games[gid].done():
        return

    async def run():
        try:
            await play_game(api, gid, me)
        except Exception as e:   # se corta el stream: el de eventos la vuelve a abrir con gameStart
            print(f"[alma-relay] playstrategy {gid}: {type(e).__name__}", flush=True)
    _games[gid] = asyncio.get_running_loop().create_task(run())


async def run_forever(transport=None) -> None:
    wait = RETRY_MIN_S
    while True:
        token = settings.get("ps_token")
        if not token:
            STATUS.update(state="sin token", user=None, bot=None)
            await asyncio.sleep(30)
            continue
        api = Api(token, transport)
        try:
            acct = await api.account()
            me = acct.get("id") or (acct.get("username") or "").lower()
            STATUS.update(user=acct.get("username"), bot=acct.get("title") == "BOT", error=None)
            if not STATUS["bot"]:
                STATUS["state"] = "falta convertir la cuenta en bot"
                await asyncio.sleep(60)
                continue
            STATUS["state"] = "en línea"
            wait = RETRY_MIN_S
            async for ev in api.stream("/api/stream/event"):
                await _on_event(api, ev, me)
            raise ConnectionError("stream cerrado")
        except asyncio.CancelledError:
            raise
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            STATUS.update(state="token rechazado" if code == 401 else f"error {code}", error=None)
            wait = 300 if code == 401 else wait
        except Exception as e:
            STATUS.update(state="reconectando", error=type(e).__name__)
        finally:
            await api.close()
        await asyncio.sleep(wait)
        wait = min(wait * 2, RETRY_MAX_S)


async def upgrade() -> tuple[bool, str]:
    """Convierte la cuenta de Alma en bot (irreversible; la cuenta no debe tener partidas). Lo pide el dueño en la app."""
    token = settings.get("ps_token")
    if not token:
        return False, "falta el token"
    api = Api(token)
    try:
        r = await api.post("/api/bot/account/upgrade")
        if r.status_code == 200:
            restart()
            return True, "ok"
        try:
            msg = r.json().get("error") or r.text
        except ValueError:
            msg = r.text
        return False, str(msg)[:200]
    finally:
        await api.close()


def start() -> None:
    global _task
    _task = asyncio.get_running_loop().create_task(run_forever())


def restart() -> None:
    """El token cambió: se vuelve a conectar con el nuevo."""
    for t in list(_games.values()):
        t.cancel()
    _games.clear()
    STATUS["games"] = {}
    if _task:
        _task.cancel()
    start()


def status() -> dict:
    owner = settings.get("ps_owner") or ""
    return {"configured": bool(settings.get("ps_token")), "owner": owner, "user": STATUS["user"], "bot": STATUS["bot"],
            "state": STATUS["state"], "error": STATUS["error"], "games": list(STATUS["games"].values()),
            "challenge_url": f"{BASE}/?user={STATUS['user']}#friend" if STATUS["user"] else None}
