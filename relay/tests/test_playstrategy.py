"""Alma como bot de PlayStrategy (playstrategy.py, backgammon.py, oware.py; dueño, 2026-10-31).

Las reglas se comprueban con partidas de las pruebas de strategygames (el código de PlayStrategy); el bot, contra un
PlayStrategy falso (httpx.MockTransport) que guarda las jugadas y las devuelve por el stream como el de verdad.
"""

import asyncio
import json
import types

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alma_relay import backgammon as bg
from alma_relay import games, oware, playstrategy, settings, web

# strategygames: src/test/scala/backgammon/BackgammonReplayTest.scala (una partida completa; gana el jugador 1)
BG_GAME = "endturn 3/1,e2h2,g2h2,endturn 5/3,e1j1,l2i2,endturn 4/4,e2i2,e2i2,a1d2,a1d2,endturn 3/1,s@j2,g1h1,endturn 1/6,g2h2,l1f1,endturn 5/5,g1l1,j2e2,a2e1,a2e1,endturn 1/2,s@l1,l1j1,endturn 6/5,endturn 5/1,f1a1,j1i1,endturn 5/3,s@j2,endturn 2/4,a1b2,b2f2,endturn 1/3,s@j2,e1f1,endturn 3/1,i1f1,d2e2,endturn 1/3,s@j2,s@l2,endturn 5/4,f2k2,g2k2,endturn 2/5,l2j2,e1j1,endturn 4/1,e2i2,d2e2,endturn 6/6,j2d2,j2d2,j2d2,d2c1,endturn 1/3,f1c1,c1b1,endturn 6/6,endturn 5/2,a1e2,a1b2,endturn 4/2,endturn 2/5,h2j2,e2j2,endturn 1/5,s@l2,endturn 6/4,b2h2,b1c2,endturn 2/6,endturn 3/6,a1c2,e2k2,endturn 6/3,endturn 5/6,c2h2,c2i2,endturn 4/3,endturn 6/4,^g2,g2k2,endturn 3/5,endturn 3/1,h2k2,i2j2,endturn 4/5,endturn 1/4,^i2,h2i2,endturn 2/4,endturn 5/6,^h2,^h2,endturn 6/4,s@g2,l2h2,endturn 4/5,^i2,^i2,endturn 5/3,e1j1,l2i2,endturn 4/2,s@i1,j2l2,endturn 6/4,e1i1,h2b2,endturn 6/6,endturn 1/1,g1h1,h1i1,a2a1,a2a1,endturn 5/3,s@h1,h1e1,endturn 6/2,s@g2,d2b2,endturn 1/6,e1d1,d1c2,endturn 2/2,g2e2,e2c2,a1c1,a1c1,endturn 2/6,s@k1,k1e1,endturn 1/5,a2e1,g2f2,endturn 4/6,endturn 1/4,b2a2,b2c1,endturn 1/1,s@l1,k2l2,l1k1,k2l2,endturn 1/6,e1k1,c1d1,endturn 6/4,endturn 6/4,a2f1,f1j1,endturn 1/5,s@h1,k2l2,endturn 3/5,c1h1,h1k1,endturn 4/6,endturn 4/4,c2b1,d2a1,f2b2,b2c1,endturn 3/6,endturn 5/4,c1h1,d1h1,endturn 5/1,s@l1,endturn 2/1,a1c1,i2h2,endturn 5/5,endturn 2/5,h2f2,b1g1,endturn 2/6,l1f1,f1d1,endturn 1/1,c1d1,c1d1,f2e2,e2d2,endturn 5/1,s@l1,endturn 1/1,d1e1,d1e1,e1f1,e1f1,endturn 3/3,endturn 1/4,d2c2,c2b1,endturn 4/5,endturn 2/4,b1d1,d1h1,endturn 2/4,j2l2,endturn 2/3,f1h1,f1i1,endturn 1/4,j2k2,endturn 6/3,^g1,^j1,endturn 4/3,endturn 1/6,g1h1,^g1,endturn 3/4,endturn 6/3,^h1,i1l1,endturn 4/2,endturn 1/5,^l1,^h1,endturn 6/2,s@g1,g1e1,endturn 6/1,^h1,k1l1,endturn 2/3,e1c1,c1a2,endturn 1/4,^l1,^i1,endturn 1/5,a2b2,b2g2,endturn 5/6,^h1,^h1,endturn 3/6,^g2,^k2,endturn 1/4,k1l1,^i1,endturn 6/3,^k2,^k2,endturn 4/1,^j1,^l1,endturn 3/6,^l2,^l2,endturn 3/1,^j1"

# strategygames: src/test/scala/samurai/OwareLongGameTest.scala (https://playstrategy.org/ARQRYUmL), casas 0–11
OWARE_GAME = [0, 11, 0, 8, 0, 11, 0, 6, 5, 8, 4, 10, 1, 10, 3, 10, 0, 6, 2, 8, 3, 7, 4, 9, 4, 7, 3, 11, 1, 6, 2, 8, 3,
              7, 4, 8, 0, 10, 3, 11, 1, 9, 4, 6, 1, 7, 2, 8, 3, 9, 4, 6, 5, 10, 2, 8, 3, 9, 4, 11, 0, 10, 1, 11, 5, 6,
              2, 7, 4, 9, 5, 7, 0, 8, 1, 11, 0, 9, 1, 10, 0, 11, 0, 6, 3, 6, 4, 7, 2, 8, 1, 10, 2, 9, 3, 10, 5, 7, 4,
              8, 5, 11, 0, 7, 1, 10, 2, 9, 3, 8, 4, 11, 0, 10, 1, 9, 5, 7, 2, 8, 3, 11, 0, 10, 4, 9, 1, 6, 2, 9, 3,
              11, 1, 8, 4, 7, 2, 9, 3, 8, 4, 9, 0, 10, 0, 11, 5, 8, 0, 7, 1, 6, 3, 7, 2, 9, 3, 8, 5, 6, 4, 6, 5, 10,
              0, 7, 1, 8, 2, 6, 3, 7, 4, 8, 5, 11, 0, 9, 0, 6, 1, 7, 2, 8, 3, 11, 4, 10, 0, 9, 1, 11, 0, 10, 1, 11, 5,
              6, 2, 7, 0, 8, 5, 9, 1, 6, 2, 7, 4, 8, 3, 10, 4, 6, 5, 11, 0, 9, 1, 7, 2, 6, 3, 8, 4, 7, 5, 10, 0, 8, 1,
              9, 2, 6, 3, 7, 4, 8, 5, 6, 0, 11, 0, 10, 1, 9, 2, 7, 3, 8, 4, 11, 5]


# ---- reglas ----

def test_oware_partida_real():
    b = oware.Board()
    for m in OWARE_GAME + [10, 0, 11, 1, 6]:
        assert m in b.legal()
        b.play(m)
    assert b.store == [20, 24]


def test_oware_notacion_y_tablero():
    assert [oware.Board().uci(i) for i in range(6)] == ["a1e1", "b1f1", "c1f2", "d1e2", "e1d2", "f1c2"]
    b = oware.replay(["a1e1", "f2b2", "d1d2", "e2b1", "e1b2"])   # OwareApiTest: casas 0, 6, 3, 7, 4
    assert [b.pits[i] for i in range(11, 5, -1)] == [5, 7, 7, 8, 1, 2]
    assert b.pits[:6] == [1, 6, 5, 0, 0, 6]
    with pytest.raises(ValueError):
        oware.replay(["a1f1"])   # a1 con 4 semillas cae en e1


def test_oware_hay_que_alimentar_y_gran_slam():
    b = oware.Board()
    b.pits = [0, 0, 0, 0, 1, 1] + [0] * 6
    b.pits[11] = 0
    b.turn = 0
    assert b.legal() == [5]          # solo f1 llega al rival
    b = oware.Board()
    b.pits = [0, 0, 0, 0, 0, 2] + [1, 1, 0, 0, 0, 0]
    assert b.play(5) == 0            # dejaría al rival sin nada: no captura
    assert b.pits[6:8] == [2, 2]


def test_backgammon_partida_real():
    b = bg.replay(BG_GAME)
    assert b.off == [15, 12] and b.ended()


def test_backgammon_obliga_dados_como_playstrategy():
    # BackgammonVariantTest: "forces use of dice for moves that enables both dice to be used"
    b = bg.replay("3/6,a2f1,e1h1,endturn 3/6,a1f2,a1c2,endturn 6/6,a2f1,a2f1,a2f1,a2f1,endturn 2/1,c2e2,e2f2,endturn "
                  "2/1,e1g1,g1h1,endturn 2/1,g2h2,h2j2,endturn 6/4")
    assert {bg.Board.uci(a) for a in b.valid_moves()} == {"l2h2", "e1k1", "f1j1", "g1k1"}


def test_backgammon_turnos_completos():
    b = bg.replay("endturn 3/1")   # le toca al jugador 2 con 3 y 1
    ts = bg.turns(b)
    assert ts and all(len(t) == 2 for t in ts)
    for t in ts:
        s = b
        for a in t:
            s = s.after(a)
        assert not s.dice and s.can_end_turn()
    assert len({tuple(bg.Board.uci(a) for a in t) for t in ts}) == len(ts)


# ---- PlayStrategy falso ----

class FakePS:
    """Guarda las jugadas de cada partida y manda un gameState por stream después de cada una."""

    def __init__(self, variant: str, alma_seat: int, moves: str = "", rolls=None, reject=()):
        self.variant, self.seat, self.moves = variant, alma_seat, moves
        self.rolls = list(rolls or [])
        self.reject = set(reject)
        self.posted, self.chat, self.rejected = [], [], []
        self.q: asyncio.Queue = asyncio.Queue()
        self.owner_moves: list[str] = []   # lo que "juega" el dueño cuando le toca

    def active(self) -> str:
        if self.variant == "oware":
            return "p1" if len(self.moves.split()) % 2 == 0 else "p2"
        b = bg.replay(self.moves)
        return ("p1", "p2")[b.player]

    def state(self, status="started", winner=None) -> dict:
        return {"type": "gameState", "moves": self.moves, "activeplayer": self.active(), "status": status,
                "winner": winner}

    def full(self) -> dict:
        me, owner = {"id": "alma", "name": "Alma"}, {"id": "dueno", "name": "Dueno"}
        return {"type": "gameFull", "id": "g1", "variant": {"key": self.variant}, "speed": "correspondence",
                "p1": me if self.seat == 0 else owner, "p2": owner if self.seat == 0 else me, "initialFen": "startpos",
                "state": self.state() | {"type": None}}

    def _add(self, tok: str) -> None:
        if self.variant == "oware":
            self.moves = (self.moves + " " + tok).strip()
            return
        turns = self.moves.split()
        if tok == "roll":   # el servidor tira los dados
            tok = self.rolls.pop(0)
        if not turns or turns[-1].endswith("endturn"):
            turns.append(tok)
        else:
            turns[-1] += "," + tok
        self.moves = " ".join(turns)

    async def push_after(self, tok: str) -> None:
        self._add(tok)
        if self.owner_moves and self.active() != ("p1", "p2")[self.seat]:
            for t in self.owner_moves.pop(0).split(","):
                self._add(t)
        await self.q.put(self.state())

    async def stream(self):
        yield (json.dumps(self.full()) + "\n").encode()
        while True:
            msg = await self.q.get()
            if msg is None:
                return
            yield (json.dumps(msg) + "\n").encode()
            if msg.get("status") != "started":
                return

    async def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/api/bot/game/stream/"):
            return httpx.Response(200, stream=_AStream(self.stream()))
        if "/move/" in path:
            tok = path.rsplit("/", 1)[1]
            if tok in self.reject:
                self.rejected.append(tok)
                return httpx.Response(400, json={"error": "Not your turn, or game already over"})
            self.posted.append(tok)
            await self.push_after(tok)
            return httpx.Response(200, json={"ok": True})
        if path.endswith("/chat"):
            self.chat.append(dict(httpx.QueryParams(request.content.decode())))
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)


class _AStream(httpx.AsyncByteStream):
    def __init__(self, gen):
        self.gen = gen

    async def __aiter__(self):
        async for chunk in self.gen:
            yield chunk


@pytest.fixture
def ps(tmp_path, monkeypatch, haiku_double):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    web.hub = web.Hub()
    playstrategy.STATUS.update(games={}, error=None)
    haiku_double.tool_input = {"move": 0, "comment": "¡A ver si me alcanzas!"}
    return haiku_double


def _run(fake: FakePS, after=None):
    async def main():
        api = playstrategy.Api("tok", transport=httpx.MockTransport(fake.handler))
        task = asyncio.create_task(playstrategy.play_game(api, "g1", "alma"))
        if after:
            await after(fake)
        await asyncio.wait_for(task, 5)
        await asyncio.sleep(0.01)   # deja salir el remote_play
        await api.close()
    asyncio.run(main())


def test_oware_alma_contesta_con_jugada_legal_y_chat(ps):
    fake = FakePS("oware", alma_seat=1, moves="d1e2")

    async def after(f):
        while not f.posted:
            await asyncio.sleep(0.01)
        await f.q.put(f.state(status="resign", winner="p2"))
    _run(fake, after)
    b = oware.replay(["d1e2"])
    assert fake.posted[0] in {b.uci(i) for i in b.legal()}
    assert fake.chat == [{"room": "player", "text": "¡A ver si me alcanzas!"}]
    assert ps.calls and "PlayStrategy" in ps.calls[0]["messages"][0]["content"]
    log = games.load()["log"]
    assert log[-1]["game"] == "oware" and log[-1]["winner"] == "alma" and log[-1]["resigned"]
    assert games.load()["ps"] == {}


def test_oware_si_rechaza_prueba_otra(ps):
    b = oware.replay(["d1e2"])
    first = b.uci(b.legal()[0])
    ps.tool_input = {"move": 0, "comment": "x"}
    fake = FakePS("oware", alma_seat=1, moves="d1e2", reject={first})

    async def after(f):
        while not f.posted:
            await asyncio.sleep(0.01)
        await f.q.put(None)
    _run(fake, after)
    assert fake.rejected == [first] and fake.posted and fake.posted[0] != first


def test_backgammon_turno_completo(ps):
    # Alma es el jugador 1 y empieza: tira, juega su turno (Haiku elige una vez) y termina el turno
    fake = FakePS("backgammon", alma_seat=0, rolls=["3/1"])

    async def after(f):
        while "endturn" not in f.posted:
            await asyncio.sleep(0.01)
        await f.q.put(f.state(status="mate", winner="p2"))
    _run(fake, after)
    assert fake.posted[0] == "roll" and fake.posted[-1] == "endturn" and len(fake.posted) == 4
    assert len(ps.calls) == 1   # un turno, una decisión de Haiku
    bg.replay(fake.moves)       # todo lo que mandó es legal
    assert games.load()["log"][-1]["winner"] == "owner"


def test_tiempo_del_duenio_cuenta(ps, monkeypatch):
    clock = iter([1000.0])
    monkeypatch.setattr(playstrategy, "time", types.SimpleNamespace(time=lambda: next(clock, 1100.0)))
    fake = FakePS("oware", alma_seat=1, moves="")   # empieza el dueño

    async def after(f):
        await asyncio.sleep(0.05)
        f.moves = "c1f2"
        await f.q.put(f.state())
        while not f.posted:
            await asyncio.sleep(0.01)
        await f.q.put(None)
    _run(fake, after)
    assert web.hub.unsent_play == 100   # sin robot conectado: se guarda para cuando vuelva
    assert games.played_seconds_today() >= 100


def test_retos_solo_del_duenio(ps):
    settings.update(ps_owner="Dueno")
    calls = []

    async def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={"ok": True})

    async def main():
        api = playstrategy.Api("tok", transport=httpx.MockTransport(handler))
        ch = lambda i, who, v: {"type": "challenge", "challenge": {"id": i, "challenger": {"id": who},
                                                                    "variant": {"key": v}}}
        await playstrategy._on_event(api, ch("c1", "dueno", "backgammon"), "alma")
        await playstrategy._on_event(api, ch("c2", "extrano", "oware"), "alma")
        await playstrategy._on_event(api, ch("c3", "dueno", "chess"), "alma")
        await api.close()
    asyncio.run(main())
    assert calls == ["/api/challenge/c1/accept", "/api/challenge/c2/decline", "/api/challenge/c3/decline"]


def test_app_token_y_bot(ps, monkeypatch):
    restarted, upgraded = [], []
    monkeypatch.setattr(playstrategy, "restart", lambda: restarted.append(1))

    async def fake_upgrade():
        upgraded.append(1)
        return True, "ok"
    monkeypatch.setattr(playstrategy, "upgrade", fake_upgrade)
    app = FastAPI()
    app.include_router(web.router)
    c = TestClient(app)
    c.get("/app/status")
    code = settings.setup_code()
    c.post("/app/setup", json={"code": code, "password": "una-clave-larga"})
    c.post("/app/login", json={"password": "una-clave-larga"})
    r = c.post("/app/settings", json={"ps_token": "lip_secreto", "ps_owner": "Dueno"})
    assert r.status_code == 200 and r.json()["ps_token"] is True and "lip_secreto" not in r.text
    assert restarted == [1]
    s = c.get("/app/playstrategy").json()
    assert s["configured"] and s["owner"] == "Dueno" and "lip_secreto" not in json.dumps(s)
    assert c.post("/app/settings", json={"ps_owner": "no vale!"}).status_code == 400
    assert c.post("/app/playstrategy/upgrade", json={}).status_code == 400 and not upgraded
    assert c.post("/app/playstrategy/upgrade", json={"confirm": True}).json() == {"ok": True} and upgraded
