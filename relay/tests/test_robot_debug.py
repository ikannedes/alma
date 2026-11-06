"""Depuración del robot por Wi-Fi (robot_debug.py; dueño, 2026-11-02)."""

import os

from alma_relay import robot_debug, settings


def test_registro_y_ordenes(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    robot_debug.append("[ 1.000] casa: buscando\n[ 1.100] casa: cerca\n", now=0)
    lines = open(os.path.join(tmp_path, "robot_log.txt"), encoding="utf-8").read().splitlines()
    assert len(lines) == 2 and lines[0].endswith("| [ 1.000] casa: buscando")
    assert robot_debug.take_cmds() == []
    with open(os.path.join(tmp_path, "robot_cmd.txt"), "w", encoding="utf-8") as f:
        f.write("log on\nkey C\nkey Z\nkey CC\nrm -rf\nkey 0\nlog off\n")
    assert robot_debug.take_cmds() == [{"t": "rlog", "on": True}, {"t": "key", "k": "C"}, {"t": "key", "k": "0"},
                                       {"t": "rlog", "on": False}]
    assert not os.path.exists(os.path.join(tmp_path, "robot_cmd.txt"))


def test_rota_el_registro(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    monkeypatch.setattr(robot_debug, "LOG_MAX", 10)
    robot_debug.append("una línea larga del robot")
    robot_debug.append("otra")
    assert os.path.exists(os.path.join(tmp_path, "robot_log.1.txt"))
    assert open(os.path.join(tmp_path, "robot_log.txt"), encoding="utf-8").read().endswith("| otra\n")


def test_ota_orden_y_trozos(tmp_path, monkeypatch):
    import base64
    import hashlib
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    os.makedirs(tmp_path / "ota")
    data = bytes((i * 7 + 3) % 256 for i in range(20000))
    (tmp_path / "ota" / "alma.bin").write_bytes(data)
    sha = hashlib.sha256(data).hexdigest()
    with open(os.path.join(tmp_path, "robot_cmd.txt"), "w", encoding="utf-8") as f:
        f.write(f"ota alma.bin {sha}\nota alma.bin {'0' * 64}\nota ../settings.json {sha}\nota reboot\n")
    cmds = robot_debug.take_cmds()
    assert [c["t"] for c in cmds] == ["_ota", "ota_reboot"]           # SHA que no coincide y rutas fuera: no
    assert cmds[0]["size"] == 20000 and cmds[0]["sha256"] == sha
    assert "no es el que dice la orden" in open(os.path.join(tmp_path, "robot_log.txt"), encoding="utf-8").read()
    monkeypatch.setattr(robot_debug, "OTA_CHUNK", 9000)
    ch = robot_debug.ota_chunks(data)
    assert [c["seq"] for c in ch] == [0, 1, 2] and [c["last"] for c in ch] == [False, False, True]
    assert b"".join(base64.b64decode(c["b64"]) for c in ch) == data


def test_ota_envio(tmp_path, monkeypatch):
    import asyncio
    import hashlib
    from alma_relay import web
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    os.makedirs(tmp_path / "ota")
    data = bytes(range(256)) * 80
    (tmp_path / "ota" / "alma.bin").write_bytes(data)
    m = robot_debug.ota_cmd(["alma.bin", hashlib.sha256(data).hexdigest()])
    sent = []

    async def fake_send(msg):
        sent.append(msg)
        if msg["t"] == "ota_begin":   # el robot contesta ota_ready
            asyncio.get_running_loop().call_soon(lambda: web.hub.ota_ready.set_result(True))
        return True
    monkeypatch.setattr(web.hub, "send", fake_send)
    monkeypatch.setattr(web, "OTA_PAUSE_S", 0)
    monkeypatch.setattr(robot_debug, "OTA_CHUNK", 9000)
    asyncio.run(web._ota_send(m))
    assert sent[0]["t"] == "ota_begin" and sent[0]["size"] == len(data)
    assert [x["seq"] for x in sent[1:]] == [0, 1, 2] and sent[-1]["last"]


def test_bateria(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    with open(os.path.join(tmp_path, "robot_cmd.txt"), "w", encoding="utf-8") as f:
        f.write("bateria on\nbateria si\nbateria off\nusb on\nusb off\npatas on\n")
    assert robot_debug.take_cmds() == [{"t": "prueba_bateria", "on": True}, {"t": "prueba_bateria", "on": False},
                                       {"t": "usb_mueve", "on": True}, {"t": "usb_mueve", "on": False},
                                       {"t": "patas", "on": True}]
    robot_debug.bateria({"t": "event", "ev": "bateria", "pct": 87, "mv": 3990, "carga": 0, "estado": 2, "sin_alma": 0,
                         "servo_s": 120, "prueba": 1}, now=0)
    robot_debug.bateria({"t": "event", "ev": "bateria", "pct": 86}, now=300)
    lines = open(os.path.join(tmp_path, "bateria.csv"), encoding="utf-8").read().splitlines()
    assert lines[0] == "hora,pct,mv,carga,estado,sin_alma,servo_s,prueba"
    assert lines[1].endswith(",87,3990,0,2,0,120,1") and lines[2].endswith(",86,,,,,,")


def test_subir_archivo(tmp_path, monkeypatch):
    from alma_relay import fiestas
    monkeypatch.setattr(settings, "data_dir", lambda: str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "caras"))
    with open(os.path.join(tmp_path, "caras", "vader_marcha.mp3"), "wb") as f:
        f.write(b"\xff\xfb" * 6000)
    with open(os.path.join(tmp_path, "robot_cmd.txt"), "w", encoding="utf-8") as f:
        f.write("subir vader_marcha.mp3\nsubir ../x.mp3\nsubir Vader.avi\nsubir no_hay.avi\nsubir vader.txt\n")
    out = robot_debug.take_cmds()
    assert out == [{"t": "_subir", "file": os.path.join(tmp_path, "caras", "vader_marcha.mp3"), "nombre": "vader_marcha",
                    "ext": "mp3"}]
    ch = fiestas.trozos(b"\xff\xfb" * 6000, "vader_marcha", "mp3")
    assert len(ch) == 2 and all(c["ext"] == "mp3" and c["nombre"] == "vader_marcha" for c in ch) and ch[1]["last"]
    assert ch[0]["size"] == 12000 and "size" not in ch[1]
    assert "ext" not in fiestas.trozos(b"x", "muertos")[0]


def test_media_prueba(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMA_RELAY_DATA", str(tmp_path))
    (tmp_path / "robot_cmd.txt").write_text("media sings1_1 sings1_1_000\nmedia sings1_1\nmedia ../x y\nmedia a b c\n")
    assert robot_debug.take_cmds() == [{"t": "prueba_media", "avi": "sings1_1", "mp3": "sings1_1_000"},
                                       {"t": "prueba_media", "avi": "sings1_1", "mp3": ""}]
