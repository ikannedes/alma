"""Backgammon dentro de la app: Alma frente a bgammon (bgammon_alma.py). Sin servidor: eventos como los manda bgammon
(capturados del servidor real con los parches de third_party/bgammon) y los comandos que ella contesta."""

import asyncio
import types

import pytest

from alma_relay import backgammon as bg
from alma_relay import bgammon_alma as ba
from alma_relay import games, web

START = [0, -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2, 0, 0, 0]


def board_ev(turn, r1=0, r2=0, board=START, avail=None, moves=None, winner=0, started=1700000000, owner="dueno"):
    return {"Type": "board", "Player1": {"Name": "alma"}, "Player2": {"Name": owner}, "Turn": turn,
            "Roll1": r1, "Roll2": r2, "Board": list(board), "Available": avail, "Moves": moves or [],
            "Winner": winner, "Started": started, "PlayerNumber": 1, "DoubleOffered": False, "DoublePlayer": 0}


@pytest.fixture
def bgm(tmp_path, monkeypatch, haiku_double):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    web.hub = web.Hub()
    haiku_double.tool_input = {"move": 0, "comment": "¡Ahí te voy!"}
    sent: list[str] = []
    m = ba.Match(sent.append)
    m.in_game, m.game_id = True, 7
    return m, sent


def run(coro):
    async def main():
        r = await coro
        await asyncio.sleep(0.01)   # deja salir el remote_play
        return r
    return asyncio.run(main())


def test_tablero_de_bgammon_es_la_salida_normal():
    b = ba.to_board({"Board": START, "Roll1": 6, "Roll2": 5})
    s = bg.Board()
    assert (b.owner, b.count, b.bar, b.off) == (s.owner, s.count, s.bar, s.off)
    assert b.player == 0 and sorted(b.dice) == [5, 6]
    assert ba.to_board({"Board": START, "Roll1": 3, "Roll2": 3}).dice == [3, 3, 3, 3]


def test_pasos_en_casillas_de_bgammon():
    assert ba.spaces(("move", 23, 17, 6)) == (24, 18)
    assert ba.spaces(("drop", None, 20, 4)) == (26, 21)
    assert ba.spaces(("lift", 2, None, 3)) == (3, 0)
    assert ba.space(26) == "bar" and ba.space(0) == "off" and ba.space(13) == "13"


def test_tirada_inicial_y_turno_paso_a_paso_con_chat(bgm):
    m, sent = bgm
    run(m.on_board(board_ev(0)))
    assert sent == ["roll"]
    run(m.on_board(board_ev(0)))           # el mismo tablero otra vez: no vuelve a tirar
    assert sent == ["roll"]
    # le toca con 6-5: elige el turno (Haiku, opción 0) y manda el primer paso que bgammon permite
    ev = board_ev(1, 6, 5, avail=[[24, 18], [24, 19], [13, 7], [13, 8], [8, 2], [8, 3], [6, 1]])
    run(m.on_board(ev))
    assert sent[1] == "say ¡Ahí te voy!" and sent[2].startswith("move ")
    first = tuple(int(x) for x in sent[2][5:].split("/"))
    assert list(first) in ev["Available"] and len(m.plan) == 1
    # bgammon aplica el paso y manda el tablero con lo que queda: el segundo paso, luego "ok"
    nxt = m.plan[0]
    run(m.on_board(board_ev(1, 6, 5, board=[1] + START[1:], avail=[list(nxt)], moves=[list(first)])))
    assert sent[3] == f"move {nxt[0]}/{nxt[1]}"
    run(m.on_board(board_ev(1, 6, 5, board=[2] + START[1:], avail=[], moves=[list(first), list(nxt)])))
    assert sent[4] == "ok"


def test_si_el_plan_no_esta_en_la_lista_juega_lo_que_bgammon_permite(bgm, monkeypatch):
    m, sent = bgm
    monkeypatch.setattr(ba, "choose_turn", lambda st, lo: ([(13, 7), (13, 8)], "", "respaldo"))
    run(m.on_board(board_ev(1, 6, 5, avail=[[24, 18], [24, 19]])))
    assert sent == ["move 24/18"] and m.plan == []


def test_rechazo_no_la_deja_trabada(bgm, monkeypatch):
    m, sent = bgm
    monkeypatch.setattr(ba, "choose_turn", lambda st, lo: ([(13, 7), (13, 8)], "", "respaldo"))
    run(m.on_board(board_ev(1, 6, 5, avail=[[13, 7], [24, 18]])))
    assert sent == ["move 13/7"]
    run(m.rejected("failedmove"))
    assert sent[-1] == "move 13/7" and ba.STATUS["error"]   # vuelve a intentar con la lista de bgammon


def test_tiempo_del_duenio_diario_y_partida_nueva(bgm, monkeypatch):
    m, sent = bgm
    now = [1000.0]
    monkeypatch.setattr(ba, "time", types.SimpleNamespace(time=lambda: now[0]))
    plays = []
    monkeypatch.setattr(ba.playstrategy, "_send_play", plays.append)
    run(m.on_board(board_ev(2, 6, 5, avail=[[1, 7]])))      # turno del dueño: empieza a contar
    now[0] = 1100.0
    run(m.on_board(board_ev(1, 0, 0)))                      # le toca a Alma: el dueño jugó 100 s
    assert sent == ["roll"] and plays == [100]
    d = games.load()
    assert d["ps"]["bg-7-1700000000"]["owner_seconds"] == 100 and d["ps"]["bg-7-1700000000"]["where"] == "la app"
    later = []

    async def finish():
        loop = asyncio.get_running_loop()
        loop.call_later = lambda s, f, *a: later.append((s, f, a))
        await m.on_board(board_ev(1, 2, 1, winner=1))
        await m.on_board(board_ev(1, 2, 1, winner=1))       # repetido: se anota una sola vez
        del loop.call_later
    run(finish())
    log = games.load()["log"]
    assert [(e["game"], e["winner"]) for e in log] == [("backgammon", "alma")]
    assert len(later) == 1 and later[0][2] == ("leave",)   # al rato deja la partida y abre otra


def test_sin_rival_no_juega(bgm):
    m, sent = bgm
    run(m.on_board(board_ev(0, owner="")))
    assert sent == [] and ba.STATUS["playing"] is False


def test_app_estado_y_puerta_para_caddy(bgm):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from alma_relay import settings
    app = FastAPI()
    app.include_router(web.router)
    c = TestClient(app)
    assert c.get("/app/auth").status_code == 401 and c.get("/app/bg").status_code == 401
    c.get("/app/status")
    c.post("/app/setup", json={"code": settings.setup_code(), "password": "una-clave-larga"})
    c.post("/app/login", json={"password": "una-clave-larga"})
    assert c.get("/app/auth").status_code == 200
    assert c.get("/app/bg").json()["url"] == "/bg/?u=dueno&j=alma"
    settings.update(ps_owner="Ikannedes")
    assert c.get("/app/bg").json()["url"] == "/bg/?u=ikannedes&j=alma"
