"""Respaldo de la memoria de Alma (dueño, 2026-11-01: "no quiero perder el avance"). El robot manda su exportación de
memory_store (alma_mem_export, ~4 KB) en trozos {"t":"mem_backup","seq","last","age","data"} al conectar, cada 6 h y
tras cada pase nocturno; se guardan las últimas KEEP copias en disco. Si el robot arranca con la memoria vacía (flash
borrada al reprogramarlo o robot nuevo) pide {"t":"mem_restore_req"} y recibe la más reciente en trozos
{"t":"mem_restore","seq","last","data"} o {"t":"mem_restore","none":1}.
"""

import base64
import json
import os
import struct
import threading
import time
import zlib

from . import settings

MAGIC = b"ALMX"              # EXPORT_MAGIC 0x584D4C41 en little-endian (memory_store/alma_mem.c)
MAX_BYTES = 64 * 1024
KEEP = 20
CHUNK = 2400

_lock = threading.Lock()


def _dir() -> str:
    d = os.path.join(settings.data_dir(), "mem_backups")
    os.makedirs(d, exist_ok=True)
    return d


def valid(data: bytes) -> bool:
    """Formato de exportación con su CRC (el mismo zlib.crc32 del robot)."""
    return (len(data) >= 28 and data[:4] == MAGIC
            and zlib.crc32(data[:-4]) & 0xFFFFFFFF == struct.unpack("<I", data[-4:])[0])


class Chunks:
    """La copia que va llegando."""

    def __init__(self):
        self.data = bytearray()
        self.next_seq = 0
        self.broken = False
        self.age = None

    def add(self, msg: dict) -> bool:
        seq = msg.get("seq")
        if seq == 0:
            self.__init__()
        if seq != self.next_seq:
            self.broken = True
        self.next_seq = (seq or 0) + 1
        if isinstance(msg.get("age"), int):
            self.age = msg["age"]
        try:
            self.data += base64.b64decode(msg.get("data") or "")
        except ValueError:
            self.broken = True
        if len(self.data) > MAX_BYTES:
            self.broken = True
        return bool(msg.get("last"))


def save(c: Chunks, now: float | None = None) -> dict:
    """Guarda la copia si está completa y es válida; borra las más viejas. Devuelve su descripción o {"error"}."""
    now = now if now is not None else time.time()
    data = bytes(c.data)
    if c.broken or not valid(data):
        return {"error": "copia incompleta o dañada"}
    with _lock:
        d = _dir()
        name = (time.strftime("%Y%m%d-%H%M%S", time.gmtime(now)) + f"{int(now * 1000) % 1000:03d}"
                + f"_d{c.age if c.age is not None else 0}.bin")
        tmp = os.path.join(d, name + ".tmp")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(d, name))
        for old in sorted(x for x in os.listdir(d) if x.endswith(".bin"))[:-KEEP]:
            os.remove(os.path.join(d, old))
    return {"name": name, "bytes": len(data), "age_days": c.age}


def listing() -> list[dict]:
    """Las copias guardadas, la más nueva primero."""
    with _lock:
        d = _dir()
        out = []
        for x in sorted((x for x in os.listdir(d) if x.endswith(".bin")), reverse=True):
            p = os.path.join(d, x)
            age = x.rsplit("_d", 1)[-1][:-4]
            out.append({"name": x, "bytes": os.path.getsize(p), "at": int(os.path.getmtime(p)),
                        "age_days": int(age) if age.isdigit() else None})
        return out


def latest() -> bytes | None:
    """La copia válida más reciente."""
    for b in listing():
        with open(os.path.join(_dir(), b["name"]), "rb") as f:
            data = f.read()
        if valid(data):
            return data
    return None


def restore_msgs() -> list[dict]:
    """Los mensajes para el robot con la última copia, o "none" si no hay."""
    data = latest()
    if not data:
        return [{"t": "mem_restore", "none": 1}]
    parts = [data[i:i + CHUNK] for i in range(0, len(data), CHUNK)]
    return [{"t": "mem_restore", "seq": n, "last": int(n == len(parts) - 1), "data": base64.b64encode(p).decode()}
            for n, p in enumerate(parts)]


def summary() -> str:
    """Para los registros: cuántas copias y la última."""
    b = listing()
    return json.dumps({"copias": len(b), "ultima": b[0] if b else None}, ensure_ascii=False)
