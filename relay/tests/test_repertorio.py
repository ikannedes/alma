"""Movimientos propios de Alma (repertorio.py; dueño, 2026-11-05): trucos de Haiku que el dueño elige e inventos."""

from alma_relay import haiku, repertorio

BIEN = [{"pose": [110, 70, 95, 85], "ms": 300}, {"paso": "izquierda"}, {"pose": [70, 110, 85, 95], "ms": 300}]


def test_validar_rango_pies_y_duracion():
    assert repertorio.validate(BIEN)[-1] == {"pose": [90, 90, 90, 90], "ms": 400}, "termina en neutro (se agrega)"
    assert repertorio.validate([{"pose": [200, 90, 90, 90], "ms": 300}] + BIEN) is None, "S0 fuera del rango observado"
    assert repertorio.validate([{"pose": [90, 90, 130, 90], "ms": 300}] + BIEN) is None, "pie a 40° de 90: se puede caer"
    assert repertorio.validate([{"pose": [90, 90, 90, 90], "ms": 50}] + BIEN) is None, "demasiado rápido"
    assert repertorio.validate([{"paso": "volar"}] + BIEN) is None
    assert repertorio.validate([{"paso": "adelante"}]) is None, "al menos dos poses"
    assert repertorio.validate("nada") is None


def test_truco_gusta_se_queda_y_regano_lo_borra():
    t1, t2 = repertorio.add_tricks([{"nombre": "meneo", "cuadros": BIEN}, {"nombre": "giro", "cuadros": BIEN},
                                    {"nombre": "malo", "cuadros": [{"pose": [0, 0, 0, 0], "ms": 1}]}])
    assert repertorio.pending_count() == 2, "el inválido no se guarda"
    msgs = repertorio.mensajes_robot()
    assert {m["nombre"] for m in msgs if m["t"] == "truco"} == {"meneo", "giro"}
    assert repertorio.on_result({"id": t1["id"], "res": "gusta", "intento": 1}) == "aprendido"
    assert repertorio.on_result({"id": t2["id"], "res": "regaño", "intento": 1}) == "olvidado"
    msgs = repertorio.mensajes_robot()
    assert [m["estado"] for m in msgs if m["t"] == "truco"] == ["aprendido"], "el olvidado ya no se le manda"
    assert repertorio.today_summary()["aprendidos_hoy"] == ["meneo"]


def test_tres_sin_reaccion_se_olvida():
    (t,) = repertorio.add_tricks([{"nombre": "saludo", "cuadros": BIEN}])
    assert repertorio.on_result({"id": t["id"], "res": "nada", "intento": 1}) == "nuevo"
    assert repertorio.on_result({"id": t["id"], "res": "nada", "intento": 2}) == "nuevo"
    assert repertorio.on_result({"id": t["id"], "res": "nada", "intento": 3}) == "olvidado"
    assert repertorio.pending_count() == 0


def test_inventos_se_respaldan_los_mas_nuevos():
    for k in range(repertorio.MAX_INVENTOS + 3):
        assert repertorio.on_invention({"nombre": f"invento_{k}", "cuadros": BIEN}, now=1000 + k)
    inv = [m for m in repertorio.mensajes_robot() if m["t"] == "invento"]
    assert len(inv) == repertorio.MAX_INVENTOS and inv[0]["nombre"] == "invento_3" and inv[-1]["nombre"] == f"invento_{repertorio.MAX_INVENTOS + 2}"
    assert not repertorio.on_invention({"nombre": "vacío", "cuadros": []})


def test_haiku_propone_y_se_valida(haiku_double):
    haiku_double.tool_input = {"trucos": [{"nombre": "ta-da", "por_que": "hoy estuvo juguetona", "cuadros": BIEN}]}
    props = haiku.propose_moves({"mood": "feliz"}, None)
    call = haiku_double.calls[-1]
    assert call["tool_choice"]["name"] == "proponer_trucos" and "S0 cadera izquierda" in call["system"][0]["text"]
    (t,) = repertorio.add_tricks(props)
    assert t["nombre"] == "ta-da" and t["estado"] == "nuevo" and t["cuadros"][-1]["pose"] == [90, 90, 90, 90]
