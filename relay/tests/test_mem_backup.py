"""Respaldo de la memoria de Alma en el servidor (mem_backup.py; dueño, 2026-11-01)."""

import base64
import struct
import zlib

from alma_relay import mem_backup
from tests.test_web import LINK_KEY, _robot, _setup, c  # noqa: F401


def _export(body: bytes = b"\x01" * 3000) -> bytes:
    """Una exportación con el formato del robot: ALMX, formato, bloques… y el CRC al final."""
    d = b"ALMX" + struct.pack("<HH", 1, 1) + b"\0" * 16 + body
    return d + struct.pack("<I", zlib.crc32(d) & 0xFFFFFFFF)


def _send(ws, sess, data, age=7, chunk=2400, skip=None):
    parts = [data[i:i + chunk] for i in range(0, len(data), chunk)]
    for n, p in enumerate(parts):
        if n != skip:
            ws.send_bytes(sess.seal({"t": "mem_backup", "seq": n, "last": int(n == len(parts) - 1), "age": age,
                                     "data": base64.b64encode(p).decode()}))


def test_guarda_y_devuelve_la_ultima(c):  # noqa: F811
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex()})
    ws, sess = _robot(c)
    sess.open(ws.receive_bytes())
    ws.send_bytes(sess.seal({"t": "mem_restore_req"}))
    assert sess.open(ws.receive_bytes()) == {"t": "mem_restore", "none": 1}          # aún no hay copias
    old, new = _export(b"\x01" * 3000), _export(b"\x02" * 3000)
    _send(ws, sess, old, age=6)
    _send(ws, sess, new, age=7)
    _send(ws, sess, _export(b"\x03" * 3000), age=8, skip=1)                          # incompleta: no se guarda
    bad = bytearray(_export(b"\x04" * 100))
    bad[30] ^= 0xFF
    _send(ws, sess, bytes(bad), age=9)                                                # CRC malo: no se guarda
    ws.send_bytes(sess.seal({"t": "state", "state": "ST_AWAKE"}))                     # para esperar a que se procese
    ws.send_bytes(sess.seal({"t": "mem_restore_req"}))
    got, last = b"", 0
    while not last:
        m = sess.open(ws.receive_bytes())
        if m.get("t") != "mem_restore":
            continue
        got += base64.b64decode(m["data"])
        last = m["last"]
    assert got == new                                                                 # la más reciente y válida
    lst = c.get("/app/memory").json()["backups"]
    assert [b["age_days"] for b in lst] == [7, 6] and lst[0]["bytes"] == len(new)
    ws.__exit__(None, None, None)


def test_guarda_solo_las_ultimas(monkeypatch, tmp_path):
    monkeypatch.setattr(mem_backup.settings, "data_dir", lambda: str(tmp_path))
    for i in range(mem_backup.KEEP + 5):
        ch = mem_backup.Chunks()
        ch.add({"seq": 0, "last": 1, "age": i, "data": base64.b64encode(_export(bytes([i]) * 50)).decode()})
        assert mem_backup.save(ch, now=1_800_000_000 + 60 * i)["age_days"] == i
    lst = mem_backup.listing()
    assert len(lst) == mem_backup.KEEP and lst[0]["age_days"] == mem_backup.KEEP + 4
    assert mem_backup.latest() == _export(bytes([mem_backup.KEEP + 4]) * 50)
