"""Comida, peso y salud en el servidor (care.py, plan v2 del dueño, 2026-10-31)."""

import asyncio

import pytest

from alma_relay import care, web

ROBOT = {"t": "state", "care_v": 2, "state": "ST_IDLE", "simple_mood": "SM_CALM", "valence": 0.0,
         "traits": {"trait_energy": 0.5, "trait_impulsivity": 0.0}}
T0 = 1_800_000_000.0 + 10 * 3600   # 12:00 en la Ciudad de México (de día)


class Dice:
    """random() con los valores que se le pidan (y luego 0.5)."""

    def __init__(self, *vals):
        self.vals = list(vals)

    def random(self):
        return self.vals.pop(0) if self.vals else 0.5

    def choice(self, seq):
        return seq[0]


@pytest.fixture
def cd(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    monkeypatch.setattr(care, "_rng", Dice())

    def state(**kw):
        d = care.load()
        d.update(kw)
        care._today(d, T0)
        care._save(d)
    return state


def test_dulces_engordan_y_no_llenan_la_verdura_al_reves():
    h, b = care.FOOD["helado"], care.FOOD["brocoli"]
    assert h["kcal"] > 5 * b["kcal"] and b["fill"] > 3 * h["fill"]
    assert {f["kind"] for f in care.FOOD.values()} == set(care.KIND_TAG)


def test_hambre_y_calorias_solo_mientras_esta_conectada(cd):
    cd(hunger=0.2, ticked=T0)
    d = care.load()
    for k in range(1, 721):                 # una hora de estados cada 5 s
        care.tick(d, ROBOT, T0 + 5 * k)
    assert d["hunger"] == pytest.approx(0.2 + care.HUNGER_RISE_PER_H, abs=0.01)
    w = d["weight"]
    care.tick(d, ROBOT, T0 + 3600 + 8 * 3600)   # 8 h sin conexión: solo cuenta 1 min
    assert d["hunger"] < 0.21 + care.HUNGER_RISE_PER_H and w - d["weight"] < 0.001
    asleep = care.load()
    asleep.update(hunger=0.2, ticked=T0)
    for k in range(1, 721):
        care.tick(asleep, ROBOT | {"state": "ST_SLEEPING"}, T0 + 5 * k)
    assert asleep["hunger"] == pytest.approx(0.2 + care.HUNGER_SLEEP_F * care.HUNGER_RISE_PER_H, abs=0.01)   # dormida, menos hambre


def test_de_noche_el_hambre_corre_lento_aunque_no_duerma_aun(cd):
    night = T0 + 9 * 3600                   # 21:00
    cd(hunger=0.2, ticked=night)
    d = care.load()
    for k in range(1, 721):
        care.tick(d, ROBOT, night + 5 * k)  # despierta (camino a la base), pero es de noche
    assert d["hunger"] == pytest.approx(0.2 + care.HUNGER_SLEEP_F * care.HUNGER_RISE_PER_H, abs=0.01)
    assert care.is_night(T0 + 8 * 3600) and care.is_night(T0 + 19 * 3600 + 3599) and not care.is_night(T0 + 20 * 3600)


def test_verdura_que_no_le_gusta_la_desanima_pero_alimenta_y_le_va_gustando(cd):
    cd(hunger=0.8, likes={"brocoli": -0.3}, likes_from="robot")
    r = care.feed("brocoli", ROBOT, now=T0, use_haiku=False)   # p ≈ 0.6; dados: acepta
    assert r["accepted"] and r["why"] == "de_mala_gana" and r["anim"] == "eat"
    assert r["joy"] < 0 and r["bond"] < 0                     # al momento: menos alegría, un poco menos de amistad
    d = care.load()
    assert d["hunger"] == pytest.approx(0.45) and d["likes"]["brocoli"] == pytest.approx(-0.27)
    assert d["weight"] == pytest.approx(care.WEIGHT_START + care.FOOD["brocoli"]["kcal"] / care.KCAL_PER_KG)


def test_llena_rechaza_comida_normal(cd, monkeypatch):
    cd(hunger=0.05, likes={"sopa": 0.0}, likes_from="robot")
    monkeypatch.setattr(care, "_rng", Dice(0.99))
    r = care.feed("sopa", ROBOT, now=T0, use_haiku=False)
    assert not r["accepted"] and r["why"] == "llena" and r["anim"] == "refuse" and r["frust"] > 0
    assert care.load()["today"]["refused"] == 1


def test_muchos_dulces_la_empachan_y_la_medicina_la_cura(cd, monkeypatch):
    cd(hunger=0.6, likes={"helado": 0.9}, likes_from="robot")
    monkeypatch.setattr(care, "_rng", Dice(*[0.0] * 20))   # acepta siempre y el empacho sale
    joys = [care.feed("helado", ROBOT | {"simple_mood": "SM_HAPPY"}, now=T0 + i, use_haiku=False) for i in range(4)]
    assert all(r["accepted"] for r in joys) and joys[0]["joy"] > 0.4
    assert joys[3]["got_sick"] and care.load()["sick"]["cause"] == "empacho"
    assert care.snapshot()["energy"] == 0.35
    monkeypatch.setattr(care, "_rng", Dice())
    r = care.feed("medicina", ROBOT, now=T0 + 10)
    assert r["accepted"] and r["why"] == "medicina" and r["anim"] == "drink" and not care.load()["sick"]
    assert care.feed("medicina", ROBOT, now=T0 + 11)["why"] == "no_esta_enferma"


def test_un_dia_de_dulces_se_compensa_con_ejercicio(cd):
    cd(hunger=0.5, ticked=T0)
    d = care.load()
    d["weight"] += 1000 / care.KCAL_PER_KG          # comió 1000 kcal de dulces
    care.robot_exercise(d, {"dance": 1800, "activity": 1800}, T0)    # 1 h bailando y boxeando
    assert d["weight"] == pytest.approx(care.WEIGHT_START + (1000 - 360) / care.KCAL_PER_KG)
    care.robot_exercise(d, {"dance": 1800, "activity": 1800}, T0)    # mismos contadores: no suma otra vez
    care.robot_exercise(d, {"dance": 60}, T0)                          # el robot se reinició: cuenta 60 s
    assert d["today"]["exercise_s"] == {"dance": 1860, "activity": 1800}


def test_sobrepeso_cansa_pero_no_enferma_al_azar(cd, monkeypatch):
    cd(weight=6.1, ticked=T0)
    d = care.load()
    assert care.band(d["weight"]) == "sobrepeso" and care.energy(d) < 0.85
    monkeypatch.setattr(care, "_rng", Dice(*[0.0] * 50))
    for k in range(1, 50):
        care.tick(d, ROBOT, T0 + 60 * k)
    assert not d["sick"]                       # ya no se enferma a cualquier hora: lo decide la noche (con propensión)
    assert care.band(4.0) == "bajo" and care.band(7.0) == "obesidad"


def test_con_poco_riesgo_no_amanece_enferma_ni_se_pregunta(cd, haiku_double):
    cd(days=[{"starve_min": 0, "exercise_s": {"dance": 1800}, "treats": 1}] * 3)
    r = care.nightly(ROBOT | {"wellbeing": 300, "valence": 0.4}, now=T0)
    assert r["risk"] < care.ILL_MIN_P and not r["sick"] and not haiku_double.calls


def test_triste_con_hambre_y_sobrepeso_haiku_decide_y_dura_dias(cd, haiku_double):
    week = [{"starve_min": 60, "exercise_s": {}, "treats": 5}] * 4
    cd(days=week, weight=6.0)
    haiku_double.tool_input = {"sick": True, "what": "una gripita", "days": 2, "note": "anda bajoneada"}
    r = care.nightly(ROBOT | {"wellbeing": -400, "valence": -0.5}, now=T0)
    assert r["sick"] and r["src"] == "haiku" and r["days"] == 2 and r["risk"] > 0.2 and len(r["why"]) >= 4
    prompt = haiku_double.calls[-1]["messages"][0]["content"]
    assert "pasó hambre 4 día(s)" in prompt and "sobrepeso" in prompt and "triste" in prompt
    d = care.load()
    assert d["sick"]["cause"] == "resfriado" and d["sick"]["until"] == T0 + 2 * 86400
    # dormida no se avisa (son las 2 de la mañana); al despertar, sí
    assert "got_sick" not in (care.on_robot_state(ROBOT | {"state": "ST_SLEEPING"}, now=T0 + 5) or {})
    woke = care.on_robot_state(ROBOT, now=T0 + 6 * 3600)
    assert woke["got_sick"] and woke["what"] == "una gripita" and woke["sick"] and woke["cause"] == "resfriado"
    assert "got_sick" not in (care.on_robot_state(ROBOT, now=T0 + 6 * 3600 + 400) or {})
    # la medicina la alivia pero no de golpe; se le pasa sola al cumplirse
    r = care.feed("medicina", ROBOT, now=T0 + 7 * 3600)
    assert r["why"] == "medicina_alivia" and care.load()["sick"]["until"] == T0 + 13 * 3600
    d = care.load()
    d["ticked"] = T0 + 13 * 3600
    care.tick(d, ROBOT, T0 + 13 * 3600 + 30)
    assert d["sick"] is None
    care._save(d)
    # 7 días tranquilos: aunque siga con riesgo, no se le pregunta a Haiku
    n = len(haiku_double.calls)
    assert not care.nightly(ROBOT | {"wellbeing": -400}, now=T0 + 3 * 86400)["sick"] and len(haiku_double.calls) == n


def test_sin_haiku_deciden_los_dados_con_la_propension(cd, monkeypatch):
    cd(days=[{"starve_min": 60}] * 4)
    monkeypatch.setattr(care, "_rng", Dice(0.0, 0.9))
    r = care.nightly(ROBOT | {"wellbeing": -300}, now=T0, use_haiku=False)
    assert r["sick"] and r["what"] == "un resfriado" and r["days"] == 2


def test_hambre_extrema_mucho_rato_la_enferma_y_comiendo_se_le_pasa(cd, monkeypatch):
    cd(hunger=1.0, ticked=T0, likes={"sopa": 0.0}, likes_from="robot")
    d = care.load()
    for k in range(1, 121):
        care.tick(d, ROBOT | {"state": "ST_SLEEPING"}, T0 + 60 * k)
    assert not d["sick"]                      # dormida no cuenta
    for k in range(121, 241):
        care.tick(d, ROBOT, T0 + 60 * k)
    assert d["sick"] and d["sick"]["cause"] == "debil"
    care._save(d)
    monkeypatch.setattr(care, "_rng", Dice(0.0, 0.5, 0.0, 0.5))
    assert care.accept_p(d, "sopa", ROBOT) > 0.8          # débil de hambre: igual come
    care.feed("sopa", ROBOT, now=T0 + 241 * 60, use_haiku=False)
    care.feed("sopa", ROBOT, now=T0 + 242 * 60, use_haiku=False)
    assert care.load()["sick"] is None


def test_al_robot_solo_le_avisa_cuando_cambia(cd):
    cd(hunger=0.3, ticked=T0)
    first = care.on_robot_state(ROBOT, now=T0 + 5)
    assert first["t"] == "care_state" and first["weight_band"] == "sano" and first["energy"] == 1.0
    assert care.on_robot_state(ROBOT, now=T0 + 10) is None
    assert care.on_robot_state(ROBOT, now=T0 + 10 + care.STATE_RESEND_S) is not None
    d = care.load()
    d["sick"] = {"since": T0, "cause": "empacho"}
    care._save(d)
    assert care.on_robot_state(ROBOT, now=T0 + 400)["sick"] is True


def test_gustos_del_robot_se_importan_una_vez(cd):
    assert care.import_payload({"likes": {"brocoli": 0.8, "nada": 1}, "hunger": 0.7, "sick": False})
    d = care.load()
    assert d["likes"] == {"brocoli": 0.8} and d["hunger"] == 0.7 and d["likes_from"] == "robot"
    assert not care.import_payload({"likes": {"brocoli": -1}})


def test_haiku_decide_los_casos_dudosos(cd, haiku_double):
    cd(hunger=0.5, likes={"sopa": 0.0}, likes_from="robot")
    haiku_double.tool_input = {"accept": False, "comment": "Ahorita no, gracias."}
    r = care.feed("sopa", ROBOT, now=T0)
    assert r["src"] == "haiku" and not r["accepted"] and r["comment"] == "Ahorita no, gracias."
    assert "Tendencia a aceptarlo" in haiku_double.calls[-1]["messages"][0]["content"]
    haiku_double.error = RuntimeError("sin red")
    assert care.feed("sopa", ROBOT, now=T0 + 1)["src"] == "reglas"


def test_app_con_firmware_nuevo_decide_el_servidor(cd, haiku_double):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from alma_relay import settings
    cd(hunger=0.9, likes={"pizza": 0.9}, likes_from="robot")
    sent = []

    class Hub(web.Hub):
        async def send(self, obj):
            sent.append(obj)
            return True
    web.hub = Hub()
    web.hub.ws = object()
    web.hub.state = dict(ROBOT)
    app = FastAPI()
    app.include_router(web.router)
    c = TestClient(app)
    c.get("/app/status")
    c.post("/app/setup", json={"code": settings.setup_code(), "password": "una-clave-larga"})
    c.post("/app/login", json={"password": "una-clave-larga"})
    r = c.post("/app/feed", json={"food": "pizza"}).json()
    assert r["accepted"] and r["care"]["hunger"] < 0.9 and sent[-1]["t"] == "care_feed" and sent[-1]["anim"] == "eat"
    v = c.get("/app/care").json()
    assert v["enabled"] and v["kcal_in"] == care.FOOD["pizza"]["kcal"] and v["log"][-1]["food"] == "Pizza"
    assert any(f["kind"] == "🍰 dulce" for f in c.get("/app/foods").json()["foods"])
    web.hub.state = {"t": "state"}            # firmware viejo: decide el robot como antes
    assert not c.get("/app/care").json()["enabled"]


def test_estado_del_robot_dispara_care_state_y_aviso(cd, monkeypatch):
    cd(hunger=0.3, ticked=T0, sick=None)
    sent, pushed = [], []

    class Hub(web.Hub):
        async def send(self, obj):
            sent.append(obj)
            return True
    web.hub = Hub()
    monkeypatch.setattr(web.notify, "push", lambda *a, **k: pushed.append(a) or 1)
    d = care.load()
    d["sick"] = {"since": T0, "cause": "sobrepeso"}
    care._save(d)
    asyncio.run(web._care_state(ROBOT))
    assert sent[-1]["t"] == "care_state" and sent[-1]["sick"] is True and "got_sick" not in sent[-1]
