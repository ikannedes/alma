"""Backgammon dentro de la app (dueño, 2026-10-31: "que los juegos estén embebidos en nuestra app, pero con diseños
hechos por otros").

El tablero es Boxcars y el servidor es bgammon, los dos de Trevor Slocum (AGPL-3.0; los parches para Alma están en
relay/third_party/bgammon/). bgammon corre en este mismo servidor: TCP 127.0.0.1:1337 para Alma y WebSocket
127.0.0.1:1338 detrás de Caddy, que solo deja pasar con la sesión del dueño. Alma entra como el jugador "alma" y
siempre tiene una partida abierta; el dueño entra a ella desde la app (/bg/?u=<dueño>&j=alma). En su turno tira, elige
el turno completo con Haiku (backgammon.py + games.choose), lo manda y lo confirma; su comentario va al chat del tablero.
Si el servidor rechaza algo (no debería: las reglas son las mismas), juega paso a paso lo que bgammon dice que es legal.
"""

import asyncio
import os
import time

from . import backgammon as bg
from . import games, playstrategy, settings

NAME = "alma"
ADDR = os.environ.get("ALMA_BG_ADDR", "127.0.0.1:1337")
PING_S = 30            # bgammon corta a los 40 s sin nada del cliente
NEW_MATCH_S = 15       # tras terminar, Alma deja la partida y abre otra

STATUS: dict = {"state": "apagado", "error": None, "playing": False}
_task: asyncio.Task | None = None


def owner_name() -> str:
    """Nombre del dueño en el tablero (letras, números y _; bgammon lo pasa a minúsculas)."""
    import re
    n = re.sub(r"[^a-z0-9_]", "", (settings.get("ps_owner") or "").lower())[:20]
    return n if n and n != NAME and not n.isdigit() else "dueno"


def to_board(st: dict) -> bg.Board:
    """El estado de bgammon (visto desde el lado de Alma) como Board de backgammon.py.
    bgammon: casillas 1–24, positivas de Alma, que va hacia la 1; 0 y 25 son lo sacado, 26 (suya) y 27 la barra."""
    sp = st["Board"]
    b = bg.Board()
    b.owner, b.count = [-1] * 24, [0] * 24
    for s in range(1, 25):
        if sp[s]:
            b.owner[s - 1], b.count[s - 1] = (0 if sp[s] > 0 else 1), abs(sp[s])
    b.bar = [abs(sp[26]), abs(sp[27])]
    b.off = [abs(sp[0]), abs(sp[25])]
    r1, r2 = st["Roll1"], st["Roll2"]
    b.player, b.dice, b.rolled, b.started = 0, ([r1] * 4 if r1 == r2 else [r1, r2]), True, True
    return b


def spaces(a: tuple) -> tuple[int, int]:
    """Un paso de backgammon.py en casillas de bgammon (26 = barra de Alma, 0 = fuera)."""
    kind, i, j, _ = a
    return (26 if kind == "drop" else i + 1, 0 if kind == "lift" else j + 1)


def space(s: int) -> str:
    return "bar" if s in (26, 27) else "off" if s in (0, 25) else str(s)


def choose_turn(st: dict, last_owner: str) -> tuple[list[tuple[int, int]], str, str]:
    """(pasos del turno en casillas de bgammon, comentario, origen). Mismas opciones que en PlayStrategy."""
    b = to_board(st)
    ts = bg.turns(b)
    opts = sorted((bg.describe(b, t) for t in ts), key=lambda o: -o["score"])[:games.MAX_PROMPT_MOVES]
    if len(opts) > 40:
        opts = opts[:30] + games._rng.sample(opts[30:], 10)
    if not opts or not opts[0]["path"]:
        return [], "", "sin jugadas"
    i, comment, src = games.choose({"game": "backgammon", "where": " (en la app)", "seat_name": "jugador 1",
                                    "view": bg.text(b, 0), "labels": [o["label"] for o in opts],
                                    "recent": [last_owner] if last_owner else [],
                                    "rules": playstrategy.RULES["backgammon"], "best": 0}, playstrategy._mood())
    return [spaces(a) for a in opts[i]["path"]], comment, src


class Match:
    """Lo que Alma sabe de su partida mientras está conectada (la crea ella; quien entra puede quedar como jugador 1
    o 2 en el servidor, pero cada uno ve el tablero desde su lado y manda sus movimientos igual)."""

    def __init__(self, send):
        self.send = send
        self.in_game = False
        self.game_id = 0
        self.done_sig = None        # el tablero al que ya respondió (puede llegar repetido)
        self.plan: list | None = None   # lo que falta del turno que eligió; se manda paso a paso
        self.last_st: dict | None = None
        self.owner_since: float | None = None
        self.turns = 0
        self.last_turn = 0
        self.finished: set[str] = set()
        self.last_owner = ""
        self.roll_at = 0.0

    def gid(self, st: dict) -> str:
        return f"bg-{self.game_id}-{st.get('Started', 0)}"

    async def on_board(self, st: dict) -> None:
        # bgammon le manda a cada jugador el tablero visto desde su lado: Alma siempre es el 1 y Turn 1 es su turno
        STATUS["playing"] = bool(st["Player2"]["Name"])
        if not st["Player2"]["Name"]:
            return
        if not st["Turn"]:                        # tirada inicial: cada uno tira un dado (y otra vez si empatan)
            if not st["Roll1"] and time.time() - self.roll_at > 3:
                self.roll_at = time.time()
                self.send("roll")
            return
        gid, now = self.gid(st), time.time()
        if st.get("Winner"):
            if gid not in self.finished:
                self.finished.add(gid)
                self.owner_turn_end(gid, now)
                games.ps_finish(gid, "backgammon", "alma" if st["Winner"] == 1 else "owner", False, self.turns)
                asyncio.get_running_loop().call_later(NEW_MATCH_S, self.send, "leave")
            return
        if st["Turn"] != self.last_turn:
            self.turns += 1
            self.last_turn = st["Turn"]
        if st["Turn"] != 1:                       # turno del dueño
            if self.owner_since is None:
                self.owner_since = now
                games.ps_update(gid, "backgammon", self.turns, where="la app")
            self.plan = None
            if st.get("Moves"):
                self.last_owner = "Tu dueño en su último turno: " + " ".join(f"{space(m[0])}/{space(m[1])}" for m in st["Moves"])
            return
        self.owner_turn_end(gid, now)
        if st.get("DoubleOffered") and st.get("DoublePlayer") != 1:
            self.send("ok")                       # acepta el doble
            return
        if not st["Roll1"]:
            sig = ("roll", gid, self.turns)
            if self.done_sig != sig:
                self.done_sig = sig
                self.send("roll")
            return
        sig = (gid, self.turns, tuple(st["Board"]), len(st.get("Moves") or []))
        if sig == self.done_sig:
            return
        self.done_sig, self.last_st = sig, st
        await self.step(st)

    async def step(self, st: dict) -> None:
        """Un paso: el siguiente del plan si bgammon dice que es legal; si no, lo primero que él permita."""
        avail = [tuple(a) for a in st.get("Available") or []]
        if not avail:
            self.plan = None
            self.send("ok")
            return
        if self.plan is None:                     # empieza el turno (o se retoma a medias al reconectar)
            self.plan, comment, src = await asyncio.to_thread(choose_turn, st, self.last_owner)
            if comment and src == "haiku":
                self.send("say " + " ".join(comment.split())[:200])
        if self.plan and self.plan[0] in avail:
            mv = self.plan.pop(0)
        else:
            if self.plan:
                print(f"[alma-relay] bgammon: {self.plan[0]} no está en {avail}; sigo lo que permite", flush=True)
            self.plan, mv = [], avail[0]
        self.send(f"move {space(mv[0])}/{space(mv[1])}")

    def owner_turn_end(self, gid: str, now: float) -> None:
        if self.owner_since is not None:
            add = int(min(now - self.owner_since, games.MAX_TURN_S))
            games.ps_update(gid, "backgammon", self.turns, add, where="la app")
            playstrategy._send_play(add)
            self.owner_since = None

    async def rejected(self, why: str) -> None:
        """No debería pasar (cada paso sale de la lista de bgammon): se juega lo primero que él permita."""
        print(f"[alma-relay] bgammon: rechazado ({why})", flush=True)
        STATUS["error"] = "el servidor de backgammon rechazó una jugada de Alma"
        self.plan = []
        if self.last_st and why == "failedmove":
            await self.step(self.last_st)


async def session() -> None:
    import json
    host, port = ADDR.rsplit(":", 1)
    reader, writer = await asyncio.open_connection(host, int(port))

    def send(cmd: str) -> None:
        writer.write((cmd.replace("\n", " ") + "\n").encode())

    m = Match(send)
    loop = asyncio.get_running_loop()

    async def keepalive():
        while True:
            await asyncio.sleep(PING_S)
            send("pong alma")
            await writer.drain()

    def ensure_match():
        if not m.in_game:
            send("create public 1 0 Alma")

    ka = loop.create_task(keepalive())
    try:
        send(f"lj alma-relay/es {NAME}")
        while line := await reader.readline():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            t = ev.get("Type")
            if t == "welcome":
                STATUS.update(state="en línea", error=None)
                loop.call_later(2, ensure_match)  # primero llega la partida que se retoma, si la hay
            elif t == "joined" and ev.get("Player") == NAME:
                m.in_game, m.game_id, m.plan, m.turns, m.last_turn = True, ev.get("GameID", 0), None, 0, 0
            elif t == "left" and ev.get("Player") == NAME:
                m.in_game = False
                STATUS["playing"] = False
                loop.call_later(2, ensure_match)
            elif t == "board":
                await m.on_board(ev)
            elif t == "ping":
                send("pong " + str(ev.get("Message", "")))
            elif t in ("failedmove", "failedok"):
                await m.rejected(t)
            await writer.drain()
    finally:
        ka.cancel()
        writer.close()


async def run_forever() -> None:
    wait = playstrategy.RETRY_MIN_S
    while True:
        try:
            await session()
            STATUS.update(state="reconectando", error="se cerró la conexión")
            wait = playstrategy.RETRY_MIN_S
        except asyncio.CancelledError:
            raise
        except Exception as e:
            STATUS.update(state="reconectando", error=type(e).__name__)
        STATUS["playing"] = False
        await asyncio.sleep(wait)
        wait = min(wait * 2, playstrategy.RETRY_MAX_S)


def start() -> None:
    global _task
    _task = asyncio.get_running_loop().create_task(run_forever())


def status() -> dict:
    return {**STATUS, "url": f"/bg/?u={owner_name()}&j={NAME}"}
