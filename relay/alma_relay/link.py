"""Enlace del robot por WebSocket con llave simétrica precompartida (decisión del dueño, 2026-10-30: sin TLS en el
robot para no gastar RAM; el servidor está en internet).

Protocolo (frames binarios), K = llave del enlace (32 bytes, la misma en el robot y en el servidor):
  1. servidor → robot: b"H" + ns (16 bytes aleatorios)
  2. robot → servidor: b"A" + nr (16) + iv (12) + AES-256-GCM_K(iv, b"alma-auth" + ns + id_robot, aad=b"A" + nr)
     Solo quien tiene K puede cifrar ns: el servidor lo descifra y compara.
  3. llave de sesión Ks = HMAC-SHA256(K, b"alma-session" + ns + nr): nueva en cada conexión.
  4. datos: b"D" + n (8 bytes, contador que solo sube) + AES-256-GCM_Ks(iv, json, aad=b"D" + n),
     iv = b"R2S\\0" o b"S2R\\0" (sentido) + n. Un frame repetido o de otra conexión no pasa.
"""

import hashlib
import hmac
import json
import os
import struct

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AUTH_PREFIX = b"alma-auth"
R2S, S2R = b"R2S\x00", b"S2R\x00"


class LinkError(Exception):
    pass


def session_key(k: bytes, ns: bytes, nr: bytes) -> bytes:
    return hmac.new(k, b"alma-session" + ns + nr, hashlib.sha256).digest()


def hello() -> tuple[bytes, bytes]:
    ns = os.urandom(16)
    return ns, b"H" + ns


def make_auth(k: bytes, ns: bytes, robot_id: str) -> tuple[bytes, bytes]:
    """Lo que hace el robot (para las pruebas y como referencia del firmware)."""
    nr, iv = os.urandom(16), os.urandom(12)
    ct = AESGCM(k).encrypt(iv, AUTH_PREFIX + ns + robot_id.encode(), b"A" + nr)
    return nr, b"A" + nr + iv + ct


def check_auth(k: bytes, ns: bytes, frame: bytes) -> tuple[bytes, str]:
    if len(frame) < 1 + 16 + 12 + 16 or frame[:1] != b"A":
        raise LinkError("saludo inválido")
    nr, iv, ct = frame[1:17], frame[17:29], frame[29:]
    try:
        pt = AESGCM(k).decrypt(iv, ct, b"A" + nr)
    except Exception as e:
        raise LinkError("llave incorrecta") from e
    if not pt.startswith(AUTH_PREFIX + ns):
        raise LinkError("reto distinto")
    return nr, pt[len(AUTH_PREFIX) + 16:].decode(errors="replace")


class Session:
    """Un sentido de envío y otro de recepción, cada uno con su contador."""

    def __init__(self, ks: bytes, i_am_server: bool):
        self.aead = AESGCM(ks)
        self.out_dir, self.in_dir = (S2R, R2S) if i_am_server else (R2S, S2R)
        self.out_n = 0
        self.in_n = 0

    def seal(self, obj: dict) -> bytes:
        self.out_n += 1
        n = struct.pack(">Q", self.out_n)
        return b"D" + n + self.aead.encrypt(self.out_dir + n, json.dumps(obj, separators=(",", ":")).encode(), b"D" + n)

    def open(self, frame: bytes) -> dict:
        if len(frame) < 1 + 8 + 16 or frame[:1] != b"D":
            raise LinkError("frame inválido")
        nb = frame[1:9]
        n = struct.unpack(">Q", nb)[0]
        if n <= self.in_n:
            raise LinkError("contador repetido")
        try:
            pt = self.aead.decrypt(self.in_dir + nb, frame[9:], b"D" + nb)
        except Exception as e:
            raise LinkError("frame alterado") from e
        self.in_n = n
        return json.loads(pt)
