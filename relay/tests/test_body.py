"""Árbitro de cuerpo (PLAN-RELOJ-v2.md, secciones 5–7): casos uno por uno, con paquetes de prueba."""

from alma_relay import body
from alma_relay.body import RELOJ, ROBOT, Arbiter

P1, P2 = b"ALMX-uno", b"ALMX-dos"


def arb(now=0.0):
    a = Arbiter(now=now)
    a.hello(ROBOT, 1, now)
    assert a.backup(ROBOT, 1, P1, now, seq=1)
    return a


def mudar_al_reloj(a, now=10.0, mid="m1"):
    assert a.request(mid, RELOJ, "boton", now)["ok"]
    d = a.hello(ROBOT, 1, now)
    assert d == {"t": "release", "mid": mid, "n": 2}
    assert a.release(ROBOT, mid, P2, now + 1)
    d = a.hello(RELOJ, 0, now + 2)
    assert d["t"] == "deliver" and d["pkg"] == P2 and d["n"] == 2
    assert a.ack(RELOJ, mid, True, now + 3)
    return a


def test_estado_inicial_y_keep():
    a = arb()
    assert a.hello(ROBOT, 1, 1)["t"] == "keep"
    assert a.hello(ROBOT, 1, 1)["lease_s"] == body.ROBOT_LEASE_S
    assert a.hello(RELOJ, 0, 1)["t"] == "absent"


def test_mudanza_con_boton_y_regreso_por_cara():
    a = mudar_al_reloj(arb())
    assert a.holder == RELOJ and a.n == 2
    assert a.hello(ROBOT, 1, 20)["t"] == "absent"
    assert a.hello(RELOJ, 2, 20) ["lease_s"] == body.WATCH_LEASE_S
    assert a.request("m2", ROBOT, "cara", 30)["ok"]
    assert a.hello(RELOJ, 2, 31)["t"] == "release"
    assert a.release(RELOJ, "m2", P1, 32)
    d = a.hello(ROBOT, 1, 33)
    assert d["t"] == "deliver" and d["n"] == 3
    assert a.ack(ROBOT, "m2", True, 34)
    assert a.holder == ROBOT and a.n == 3


def test_numero_sube_solo_al_soltar():
    a = arb()
    a.request("m1", RELOJ, "boton", 5)
    assert a.n == 1 and a.holder == ROBOT          # el robot sigue con Alma hasta que la suelta
    assert a.backup(ROBOT, 1, P2, 6, seq=2)         # y puede seguir respaldando
    assert not a.backup(ROBOT, 1, P1, 6, seq=1)     # un respaldo retrasado no pisa al más nuevo
    a.release(ROBOT, "m1", P2, 7)
    assert a.n == 2 and a.holder is None
    assert not a.backup(ROBOT, 1, P1, 8, seq=3)     # un número viejo ya no se acepta


def test_mensajes_duplicados():
    a = arb()
    a.request("m1", RELOJ, "boton", 5)
    assert a.request("m1", RELOJ, "boton", 5)["why"] == "ya_pedida"
    assert a.release(ROBOT, "m1", P2, 6) and a.release(ROBOT, "m1", P2, 6)
    assert a.n == 2
    assert a.hello(RELOJ, 0, 7)["t"] == "deliver"
    assert a.ack(RELOJ, "m1", True, 8) and a.ack(RELOJ, "m1", True, 9)
    assert a.release(ROBOT, "m1", P2, 10)           # un release tardío no reabre nada
    assert a.holder == RELOJ and a.n == 2


def test_boton_y_cara_a_la_vez():
    a = mudar_al_reloj(arb())
    assert a.request("cara1", ROBOT, "cara", 40)["ok"]
    assert a.request("pwa1", ROBOT, "manual", 40)["why"] == "en_transito"


def test_llegada_por_cara_sin_respuesta_se_cancela():
    a = mudar_al_reloj(arb())
    a.request("cara1", ROBOT, "cara", 100)
    a.tick(100 + body.RELEASE_TIMEOUT_S["cara"] + 1)
    assert a.transit is None and a.holder == RELOJ and a.n == 2
    assert a.hello(RELOJ, 2, 300)["t"] == "keep"    # el reloj nunca quedó con número viejo
    assert not a.release(RELOJ, "cara1", P1, 301)   # un release tardío de la mudanza cancelada no cuenta


def test_llegada_por_cara_espera_al_reloj_dormido():
    a = mudar_al_reloj(arb())
    a.request("cara1", ROBOT, "cara", 100)
    a.hello(ROBOT, 0, 100 + 15 * 60)   # el robot sigue en línea
    a.tick(100 + 15 * 60)              # el reloj con la app cerrada aún no contesta
    assert a.transit and a.transit["mid"] == "cara1"


def test_llegada_por_cara_se_cancela_si_el_robot_se_apaga():
    a = mudar_al_reloj(arb())
    a.request("cara1", ROBOT, "cara", 100)
    a.tick(100 + body.ROBOT_OFFLINE_S + 1)
    assert a.transit is None and a.holder == RELOJ
    assert not a.release(RELOJ, "cara1", P1, 100 + body.ROBOT_OFFLINE_S + 2)


def test_robot_desconectado_5_min_alma_al_reloj():
    a = arb()
    a.hello(ROBOT, 1, 0)
    a.tick(body.ROBOT_OFFLINE_S - 1)
    assert a.holder == ROBOT
    a.tick(body.ROBOT_OFFLINE_S)
    assert a.holder is None and a.n == 2 and a.transit["forced"] and a.transit["reason"] == "desconexion"
    d = a.hello(RELOJ, 0, body.ROBOT_OFFLINE_S + 5)
    assert d["t"] == "deliver" and d["pkg"] == P1 and d["reason"] == "desconexion"
    a.ack(RELOJ, d["mid"], True, body.ROBOT_OFFLINE_S + 6)
    assert a.hello(ROBOT, 1, 400)["t"] == "absent"  # al reconectar, el robot ve que ya no es suya


def test_boton_con_robot_apagado_espera_a_los_5_min():
    a = arb()
    a.hello(ROBOT, 1, 0)
    a.request("m1", RELOJ, "boton", 60)
    a.tick(200)
    assert a.transit["pkg"] is None                 # el lease del robot podría seguir vivo
    a.tick(body.ROBOT_OFFLINE_S)
    assert a.transit["forced"] and a.n == 2
    assert a.hello(RELOJ, 0, 310)["pkg"] == P1


def test_invariante_lease_robot():
    assert body.ROBOT_LEASE_S < body.ROBOT_OFFLINE_S


def test_rescate_forzado_y_reloj_que_vuelve():
    a = mudar_al_reloj(arb())
    assert a.backup(RELOJ, 2, b"ALMX-reloj", 50)
    r = a.request("rescate1", ROBOT, "rescate", 60)
    assert r["ok"] and a.n == 3 and a.transit["forced"]
    d = a.hello(ROBOT, 1, 61)
    assert d["pkg"] == b"ALMX-reloj" and d["at"] == 50
    a.ack(ROBOT, "rescate1", True, 62)
    d = a.hello(RELOJ, 2, 500, events=[{"id": "r-1", "kind": "truco", "data": {"nombre": "baila"}}])
    assert d["t"] == "absent"
    ev = a.hello(ROBOT, 3, 501)["events"]
    assert [e["id"] for e in ev] == ["r-1"] and ev[0]["recuerdo_de"] == RELOJ


def test_rescate_sin_copia_no_procede():
    a = Arbiter()
    assert a.request("x", RELOJ, "rescate", 1) == {"ok": False, "why": "sin_copia"}
    assert a.transit is None


def test_eventos_en_transito_se_encolan_y_no_se_duplican():
    a = arb()
    a.request("m1", RELOJ, "boton", 5)
    a.release(ROBOT, "m1", P2, 6)
    assert a.event({"id": "pwa-1", "kind": "comida", "data": {"food": "manzana"}}, 7)
    assert not a.event({"id": "pwa-1", "kind": "comida"}, 8)
    d = a.hello(RELOJ, 0, 9)
    a.ack(RELOJ, d["mid"], True, 10)
    k = a.hello(RELOJ, 2, 11)
    assert [e["id"] for e in k["events"]] == ["pwa-1"]
    assert a.hello(RELOJ, 2, 12, acked=["pwa-1"])["events"] == []


def test_recuperacion_de_eventos_sin_duplicados():
    a = arb()
    a.tick(body.ROBOT_OFFLINE_S + 1)
    d = a.hello(RELOJ, 0, 310)
    a.ack(RELOJ, d["mid"], True, 311)
    evs = [{"id": "rb-7", "kind": "comida"}, {"id": "rb-8", "kind": "hito"}]
    assert a.hello(ROBOT, 1, 400, events=evs)["t"] == "absent"
    assert a.hello(ROBOT, 1, 401, events=evs)["t"] == "absent"      # reenvío: no se duplica
    assert [e["id"] for e in a.hello(RELOJ, 2, 402)["events"]] == ["rb-7", "rb-8"]


def test_candado_pase_nocturno():
    a = arb()
    a.lock("noche_robot", True, 10)
    assert a.request("m1", RELOJ, "boton", 11)["why"] == "espera_candado"
    a.tick(12)
    assert a.transit is None
    a.lock("noche_robot", False, 20)
    a.tick(21)
    assert a.transit and a.transit["mid"] == "m1"


def test_candado_olvidado_caduca():
    a = arb()
    a.lock("ota", True, 0)
    a.request("m1", RELOJ, "boton", 1)
    a.tick(body.LOCK_MAX_S + 2)
    assert a.transit and a.transit["mid"] == "m1"


def test_paquete_incompatible_regresa_al_origen():
    a = arb()
    a.request("m1", RELOJ, "boton", 5)
    a.release(ROBOT, "m1", P2, 6)
    assert not a.ack(RELOJ, "m1", False, 7, why="esquema 3 > 2")
    d = a.hello(ROBOT, 1, 8)
    assert d["t"] == "deliver" and d["pkg"] == P2 and d["n"] == 2
    a.ack(ROBOT, "m1", True, 9)
    assert a.holder == ROBOT and a.n == 2
    assert a.s["notices"][-1]["kind"] == "mudanza_rechazada"


def test_reloj_reseteado_recibe_su_ultima_copia():
    a = mudar_al_reloj(arb())
    a.backup(RELOJ, 2, b"ALMX-reloj", 40)
    d = a.hello(RELOJ, 0, 41)                          # app reinstalada: número 0
    assert d["t"] == "deliver" and d["pkg"] == b"ALMX-reloj" and d["mid"] == "reenvio-2"


def test_persistencia(tmp_path):
    a = mudar_al_reloj(arb())
    p = str(tmp_path / "body.json")
    body.save(a, p)
    b = body.load(p)
    assert b.holder == RELOJ and b.n == 2 and b.hello(RELOJ, 2, 50)["t"] == "keep"
