"""Caras de festividades (fiestas.py; dueño, 2026-11-02): calendario y envío al robot."""

import base64
import datetime as dt
import os

from alma_relay import alarms, fiestas, milestones, settings


def _ts(y, m, d, h=12):
    return dt.datetime(y, m, d, h, tzinfo=alarms.tz()).timestamp()


def _sin_hitos(monkeypatch):
    monkeypatch.setattr(milestones, "listing", lambda: {"milestones": []})


def test_calendario(monkeypatch):
    _sin_hitos(monkeypatch)
    assert fiestas.pascua(2027) == dt.date(2027, 3, 28)
    assert fiestas.pascua(2026) == dt.date(2026, 4, 5)
    assert fiestas.dia_padre(2027) == dt.date(2027, 6, 20)
    assert fiestas.hoy(_ts(2027, 3, 28)) == "pascua"
    assert [fiestas.hoy(_ts(2027, 2, d)) for d in (6, 7, 8, 9, 10)] == ["ano_nuevo_chino", "carnaval", "carnaval", "carnaval", ""]
    assert fiestas.hoy(_ts(2027, 6, 20)) == "dia_padre"
    assert fiestas.hoy(_ts(2027, 2, 14)) == "san_valentin"
    assert fiestas.hoy(_ts(2027, 12, 20)) == "posadas"
    assert fiestas.hoy(_ts(2027, 12, 24)) == "navidad"
    assert fiestas.hoy(_ts(2027, 9, 16)) == "independencia"
    assert fiestas.hoy(_ts(2027, 8, 3)) == ""


def test_su_cumpleanos_va_primero(monkeypatch):
    t = _ts(2027, 2, 14)
    monkeypatch.setattr(milestones, "listing", lambda: {"milestones": [{"kind": "edad", "at": t - 3600}]})
    assert fiestas.hoy(t) == "cumpleanos"


def test_envio_por_trozos_y_no_reenvia(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    os.makedirs(tmp_path / "caras")
    data = bytes((i * 7 + 3) % 256 for i in range(20000))
    (tmp_path / "caras" / "san_valentin.avi").write_bytes(data)
    m = fiestas.mensajes("san_valentin", now=1000)
    caras = [x for x in m if x["t"] == "cara"]
    assert len(caras) == 3 and [x["seq"] for x in caras] == [0, 1, 2] and [x["last"] for x in caras] == [False, False, True]
    assert b"".join(base64.b64decode(x["b64"]) for x in caras) == data
    assert all(len(x["b64"]) < 13000 for x in caras)
    assert m[-1] == {"t": "fiesta", "nombre": "san_valentin"}
    assert fiestas.mensajes("san_valentin", now=1100) == [{"t": "fiesta", "nombre": "san_valentin"}]   # ya va en camino
    fiestas.on_result({"t": "cara_ok", "nombre": "san_valentin"})
    assert fiestas.en_robot() == ["san_valentin"]
    assert fiestas.mensajes("san_valentin", now=5000) == [{"t": "fiesta", "nombre": "san_valentin"}]   # ya la tiene
    assert fiestas.mensajes("", now=5000) == [{"t": "fiesta", "nombre": ""}]


def test_error_se_vuelve_a_mandar(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    os.makedirs(tmp_path / "caras")
    (tmp_path / "caras" / "reyes.avi").write_bytes(b"x" * 100)
    assert len(fiestas.mensajes("reyes", now=1000)) == 2
    fiestas.on_result({"t": "cara_error", "nombre": "reyes"})
    assert len(fiestas.mensajes("reyes", now=1010)) == 2   # sin esperar los 10 min
    assert fiestas.mensajes("halloween", now=1010) == [{"t": "fiesta", "nombre": "halloween"}]   # sin el AVI: solo la fiesta


def test_precarga_de_noche_y_dormida(tmp_path, monkeypatch):
    """Todas las caras van a su SD con tiempo, de noche y dormida, una cada 15 min (dueño, 2026-11-02)."""
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    os.makedirs(tmp_path / "caras")
    for n in ("halloween", "navidad", "reyes"):
        (tmp_path / "caras" / f"{n}.avi").write_bytes(n.encode() * 100)
    noche = _ts(2027, 8, 3, 23)
    assert fiestas.precarga(True, _ts(2027, 8, 3, 12)) == []                        # de día, no
    assert fiestas.precarga(False, noche) == []                                     # despierta, no
    m = fiestas.precarga(True, noche)
    assert m and all(x["t"] == "cara" and x["nombre"] == "halloween" for x in m) and m[-1]["last"]
    assert fiestas.precarga(True, noche + 60) == []                                 # una cada 15 min
    assert fiestas.precarga(True, noche + 16 * 60)[0]["nombre"] == "navidad"       # la siguiente que falta
    fiestas.on_result({"t": "cara_ok", "nombre": "reyes"})
    assert fiestas.precarga(True, noche + 32 * 60) == []                            # halloween y navidad en camino, reyes ya


def test_no_manda_caras_a_un_firmware_que_no_las_sabe(tmp_path, monkeypatch):
    """Solo con "fiesta_v" en el estado del robot (fiesta.c): el firmware anterior no recibe caras."""
    import asyncio
    from alma_relay import web
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    sent = []

    async def fake_send(m):
        sent.append(m)
        return True
    monkeypatch.setattr(web.hub, "send", fake_send)
    monkeypatch.setattr(web.hub, "ws", object())
    monkeypatch.setattr(fiestas, "hoy", lambda t=None: "navidad")
    now = dt.datetime(2027, 12, 25, 12, tzinfo=dt.timezone.utc)
    web.hub.state, web.hub.fiesta = {"state": "ST_AWAKE"}, None
    asyncio.run(web._fiestas_tick(now))
    assert sent == []
    web.hub.state = {"state": "ST_AWAKE", "fiesta_v": 1}
    asyncio.run(web._fiestas_tick(now))
    assert sent and sent[-1] == {"t": "fiesta", "nombre": "navidad"}
    monkeypatch.setattr(web.hub, "ws", None)
