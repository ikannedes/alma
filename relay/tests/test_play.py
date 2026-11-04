"""Jugar con Alma: base común (play.py, web_play.py; PLAN-JUEGOS del dueño, 2026-10-31)."""

import random
import time

import pytest
from anthropic.types import Message, TextBlock, ToolUseBlock, Usage
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alma_relay import care, haiku, play, settings, web, web_play

ROBOT = {"t": "state", "simple_mood": "SM_PLAYFUL", "valence": 0.3, "wellbeing": 200,
         "traits": {"trait_boldness": 0.8, "trait_impulsivity": 0.7}, "needs": {"need_play": 0.6},
         "people_present": [{"person_id": 0, "attachment": 0.74}]}


class FakeHaiku:
    """Elige al azar de la lista que manda el juego (el enum de la herramienta), o falla si se le pide."""

    def __init__(self, seed=1):
        self.rng = random.Random(seed)
        self.calls = []
        self.fail = 0          # cuántas llamadas siguientes fallan
        self.force = None      # jugada fija (para probar una fuera de la lista)
        self.text = "siempre abre cuando subo a cuatro"
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        if self.fail:
            self.fail -= 1
            raise RuntimeError("sin red")
        usage = Usage(input_tokens=900, output_tokens=40)
        if "tools" not in kw:
            return Message(id="m", type="message", role="assistant", model=kw["model"], stop_reason="end_turn",
                           stop_sequence=None, usage=usage, content=[TextBlock(type="text", text=self.text)])
        enum = kw["tools"][0]["input_schema"]["properties"]["jugada"]["enum"]
        mv = self.force or self.rng.choice(enum)
        return Message(id="m", type="message", role="assistant", model=kw["model"], stop_reason="tool_use",
                       stop_sequence=None, usage=usage,
                       content=[ToolUseBlock(type="tool_use", id="t", name="elegir_jugada",
                                             input={"jugada": mv, "reaccion": self.rng.choice(play.REACTIONS),
                                                    "pensamiento": "A ver qué haces con esto, jeje."})])


@pytest.fixture
def fake(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    f = FakeHaiku()
    monkeypatch.setattr(haiku, "_client", f)
    monkeypatch.setattr(play, "_rng", random.Random(3))
    return f


LEGAL = [{"id": f"m{i}", "label": f"jugada {i}"} for i in range(12)]


def test_haiku_elige_de_la_lista_con_contexto_de_alma(fake):
    play.remember_robot(ROBOT)
    c = play.choose("dados", "Tus dados: 2 3 3 5 6. Apuesta: 3 treses.", LEGAL, ["Dueño: 3 treses"], ROBOT)
    assert c["id"] in {m["id"] for m in LEGAL} and c["reaccion"] in play.REACTIONS and len(c["pensamiento"]) <= 80
    kw = fake.calls[-1]
    assert kw["tool_choice"] == {"type": "tool", "name": "elegir_jugada"}
    enum = kw["tools"][0]["input_schema"]["properties"]["jugada"]["enum"]
    assert enum[0] == "m0" and set(enum) <= {m["id"] for m in LEGAL} and len(enum) == 3   # principiante: ve pocas
    assert kw["system"][1]["cache_control"] == {"type": "ephemeral"} and "Dados mentirosos" in kw["system"][1]["text"]
    text = kw["messages"][0]["content"]
    assert "juguetona" in text and "Apego con tu dueño" in text and "0.74" in text and "principiante" in text
    assert play.used_today(play.load(), __import__("time").time()) == 940


def test_cien_partidas_simuladas_sin_jugadas_invalidas(fake):
    for g in range(100):
        legal = [{"id": f"g{g}-{k}"} for k in range(1 + g % 30)]
        assert play.choose("timbiriche", "tablero", legal, [], ROBOT)["id"] in {m["id"] for m in legal}


def test_sin_red_no_juega_un_sustituto(fake):
    fake.fail = 1
    assert play.choose("dados", "s", LEGAL, [], ROBOT)["id"]          # un reintento basta
    fake.fail = 2
    with pytest.raises(play.Paused, match="pensando"):
        play.choose("dados", "s", LEGAL, [], ROBOT)
    fake.force = "inventada"
    with pytest.raises(play.Paused):                                    # fuera de la lista: no se inventa nada
        play.choose("dados", "s", LEGAL, [], ROBOT)


def test_tope_de_gasto(fake):
    settings.update(play_budget_tokens=20_000)
    for _ in range(40):
        try:
            play.choose("dados", "s", LEGAL, [], ROBOT)
        except play.Paused as e:
            assert str(e) == "cansada"
            break
    else:
        pytest.fail("el tope no cortó")
    assert play.start("muros", ROBOT)["refused"] == play.PAUSE_TEXT["cansada"]


def test_enferma_no_quiere_jugar(fake):
    d = care.load()
    d["sick"] = {"since": 1.0, "cause": "resfriado", "until": 9e12, "what": "una gripita"}
    care._save(d)
    r = play.start("dados", ROBOT | {"care_v": 2})
    assert not r["ok"] and "enferma" in r["refused"]
    assert play.start("dados", ROBOT)["ok"]   # con firmware viejo no hay salud en el servidor


def test_memoria_de_partidas_y_habitos(fake):
    for w in ("alma", "alma", "owner"):
        m = play.start("dados", ROBOT, force_new=True)["match"]
        play.finish("dados", m["id"], w)
    assert play.note_habit("dados", ["Dueño: 4 cincos", "Alma: abre"]) == fake.text
    ctx = play.alma_context(ROBOT, "dados", play.load())
    assert "ganaste 2, perdiste 1" in ctx and fake.text in ctx
    fake.text = "nada"
    assert play.note_habit("dados", ["x"]) == ""


def _client(sent):
    class Hub(web.Hub):
        async def send(self, obj):
            sent.append(obj)
            return True
    web.hub = Hub()
    web.hub.ws = object()
    web.hub.state = dict(ROBOT)
    app = FastAPI()
    app.include_router(web.router)
    app.include_router(web_play.router)
    c = TestClient(app)
    c.get("/app/status")
    c.post("/app/setup", json={"code": settings.setup_code(), "password": "una-clave-larga"})
    c.post("/app/login", json={"password": "una-clave-larga"})
    return c


def test_api_partida_rapida_completa(fake, monkeypatch):
    sent, plays = [], []
    monkeypatch.setattr(web_play.notify, "push", lambda *a, **k: 1)
    from alma_relay import playstrategy
    monkeypatch.setattr(playstrategy, "_send_play", plays.append)
    c = _client(sent)
    assert c.get("/app/play").status_code == 200
    m = c.post("/app/play/dados/start", json={}).json()["match"]
    assert sent[-1] == {"t": "game_event", "juego": "dados", "tipo": "empieza", "reaccion": ""}
    r = c.post("/app/play/dados/move", json={"match": m["id"], "state": "Tus dados: 1 1 4", "legal": LEGAL,
                                             "history": ["Dueño: 2 cuatros"], "snapshot": {"turno": 3}}).json()
    assert r["move"]["id"] in {x["id"] for x in LEGAL}
    g = c.get("/app/play/dados").json()["match"]
    assert g["snapshot"] == {"turno": 3} and g["pending"]["id"] == r["move"]["id"]
    c.post("/app/play/dados/seen", json={"match": m["id"]})
    assert c.get("/app/play/dados").json()["match"]["pending"]["seen"]
    e = c.post("/app/play/dados/event", json={"match": m["id"], "type": "farol_descubierto", "reaccion": "nerviosa"}).json()
    assert e["robot"] and sent[-1]["tipo"] == "farol_descubierto"
    e = c.post("/app/play/dados/event", json={"match": m["id"], "type": "gana_alma", "history": ["a", "b"]}).json()
    assert e["result"]["winner"] == "alma" and c.get("/app/play/dados").json()["match"] is None
    assert c.post("/app/play/dados/event", json={"type": "trampa"}).status_code == 400
    assert c.post("/app/play/dados/move", json={"match": "otra", "legal": LEGAL}).status_code == 409
    fake.fail = 2
    m = c.post("/app/play/dados/start", json={}).json()["match"]
    r = c.post("/app/play/dados/move", json={"match": m["id"], "state": "s", "legal": LEGAL}).json()
    assert r["paused"] == "pensando" and "pensando" in r["text"]


def test_api_partida_lenta_con_aviso(fake, monkeypatch):
    sent, pushed = [], []
    monkeypatch.setattr(web_play.notify, "push", lambda *a, **k: pushed.append(a) or 1)
    monkeypatch.setattr(play, "think_delay", lambda rs: 0)
    with _client(sent) as c:     # con "with", el bucle del servidor sigue vivo mientras Alma piensa
        m = c.post("/app/play/muros/start", json={}).json()["match"]
        r = c.post("/app/play/muros/move", json={"match": m["id"], "state": "s", "legal": LEGAL}).json()
        assert r == {"pending": True}
        for _ in range(100):
            g = c.get("/app/play/muros").json()["match"]
            if g["pending"]:
                break
            time.sleep(0.02)
    assert g["pending"] and g["turn"] == "owner" and pushed and "Ya jugué en Muros" in pushed[-1][1]


def test_tiempo_real_tarde_no_juega(fake, monkeypatch):
    c = _client([])
    m = c.post("/app/play/torres/start", json={}).json()["match"]
    fake.fail = 5
    r = c.post("/app/play/torres/move", json={"match": m["id"], "state": "s", "legal": LEGAL}).json()
    assert r["late"] is True and "move" not in r


def test_recordatorio_una_vez_a_las_24_h(fake):
    m = play.start("muros", ROBOT, now=1000.0)["match"]
    assert play.due_reminders(now=1000.0 + 3600) == []
    assert play.due_reminders(now=1000.0 + play.REMIND_AFTER_S + 1) == ["muros"]
    assert play.due_reminders(now=1000.0 + 2 * play.REMIND_AFTER_S) == []
    assert m["id"]


def test_alma_mejora_con_las_partidas(fake):
    d = play.load()
    assert play.skill(d, "naval") == 0 and play.level_name(0) == "principiante"
    legal = [{"id": f"c{i}"} for i in range(64)]
    seen0 = play.considered(legal, 0.0, random.Random(1))
    assert len(seen0) == 16 and seen0[0]["id"] == "c0"
    assert play.considered(legal, 1.0, random.Random(1)) == legal
    for i in range(60):   # 60 partidas, 30 que ganó el dueño: ya avanzada
        d["log"].append({"game": "naval", "id": str(i), "winner": "owner" if i % 2 else "alma", "date": "2026-11-01"})
    play._save(d)
    sk = play.skill(play.load(), "naval")
    assert 0.7 <= sk < 0.9 and play.level_name(sk) == "avanzada" and play.skill(play.load(), "dados") == 0
    play.choose("naval", "s", legal, [], ROBOT)
    enum = fake.calls[-1]["tools"][0]["input_schema"]["properties"]["jugada"]["enum"]
    assert len(enum) > 50 and "avanzada" in fake.calls[-1]["messages"][0]["content"]
    for i in range(60, 120):
        d["log"].append({"game": "naval", "id": str(i), "winner": "alma", "date": "2026-11-02"})
    play._save(d)
    assert play.level_name(play.skill(play.load(), "naval")) == "experta"


def test_no_delata_lo_oculto_ni_el_farol(fake):
    # caso real (2026-10-31): Haiku dijo sus dados en dados mentirosos
    assert play.clean_thought("dados", "Tengo tres dados buenos, dos seises. Subo.", "concentrada") == play.CANNED["concentrada"]
    assert play.clean_thought("dados", "Es un farol, jeje", "farol") == play.CANNED["farol"]
    assert play.clean_thought("dados", "No me lo creo. ¡Abro!", "picada") == "No me lo creo. ¡Abro!"
    assert play.clean_thought("naval", "Mi portaaviones está en B3", "contenta") == play.CANNED["contenta"]
    assert play.clean_thought("muros", "", "dudosa") == play.CANNED["dudosa"]
    assert play.clean_thought("muros", "Tengo 3 muros, ¡cuidado!", "presumida") == "Tengo 3 muros, ¡cuidado!"


def test_principiante_puede_elegir_otra_legal_que_vio_en_el_tablero(fake):
    legal = [{"id": f"c{i}"} for i in range(64)]
    fake.force = "c63"   # quizá no estaba en las que "vio", pero el juego la permite
    assert play.choose("naval", "Tocado en c62", legal, [], ROBOT)["id"] == "c63"
    fake.force = "z99"
    with pytest.raises(play.Paused):
        play.choose("naval", "s", legal, [], ROBOT)


def test_avisos_y_tiempo_en_tiempo_real(fake, monkeypatch):
    from alma_relay import notify, playstrategy
    pushed, plays = [], []
    monkeypatch.setattr(notify, "_send", lambda sub, payload: pushed.append(payload) or 1)
    settings.update(subscriptions=[{"endpoint": "x"}])
    notify._last.clear()
    assert notify.push("game", "t", "b", url="/play/muros/") == 1 and pushed[-1]["url"] == "/play/muros/"
    assert notify.on_robot_message({"t": "event", "ev": "forgot_face", "person_id": 3}) == ["forgot_face"]
    monkeypatch.setattr(playstrategy, "_send_play", plays.append)
    c = _client([])
    m = c.post("/app/play/torres/start", json={}).json()["match"]
    d = play.load()
    d["matches"]["torres"]["started"] -= 200   # la partida duró ~200 s
    play._save(d)
    c.post("/app/play/torres/event", json={"match": m["id"], "type": "gana_alma"})
    assert plays and 195 <= plays[-1] <= 210
    assert "8×8" in play.GAMES["naval"]["rules"]
