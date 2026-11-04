"""Envoltura ctypes del cuerpo de Alma (sim/body_lib.c) para la fase 0 del plan del reloj.

Compilar antes con sim/build.sh. Si la biblioteca o el catálogo no están, available() es False y las
pruebas que la usan se saltan.
"""

import ctypes
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ALMA = os.path.normpath(os.path.join(HERE, "..", ".."))
LIB = os.path.join(ALMA, "sim", "build", "alma_body.dll" if sys.platform == "win32" else "libalma_body.so")
CATALOG = os.path.join(ALMA, "catalog", "catalog.json")
INVENTORY = os.environ.get("ALMA_INVENTORY", r"C:\Users\ikann\emo_backup\assets_inventory.json")
CAP = 64 * 1024

_lib = None


def available() -> bool:
    return os.path.exists(LIB) and os.path.exists(CATALOG) and os.path.exists(INVENTORY)


def lib():
    global _lib
    if _lib is None:
        L = ctypes.CDLL(LIB)
        P, D, U32, I = ctypes.c_void_p, ctypes.c_double, ctypes.c_uint32, ctypes.c_int
        L.body_catalog.argtypes, L.body_catalog.restype = [ctypes.c_char_p, ctypes.c_char_p], I
        L.body_new.argtypes, L.body_new.restype = [U32, D], P
        L.body_free.argtypes, L.body_free.restype = [P], None
        L.body_run.argtypes, L.body_run.restype = [P, D], None
        L.body_catch_up.argtypes, L.body_catch_up.restype = [P, D], None
        L.body_pet.argtypes, L.body_pet.restype = [P], I
        L.body_feed.argtypes, L.body_feed.restype = [P, I], I
        L.body_hunger.argtypes, L.body_hunger.restype = [P], ctypes.c_float
        L.body_age_days.argtypes, L.body_age_days.restype = [P], I
        L.body_now.argtypes, L.body_now.restype = [P], D
        L.body_export.argtypes, L.body_export.restype = [P, ctypes.c_char_p, U32], ctypes.c_long
        L.body_from_package.argtypes, L.body_from_package.restype = [ctypes.c_char_p, U32, D], P
        if L.body_catalog(CATALOG.encode(), INVENTORY.encode()) != 0:
            raise RuntimeError("no se pudo cargar el catálogo")
        _lib = L
    return _lib


class Core:
    """El núcleo real de una Alma viva en un cuerpo."""

    def __init__(self, handle):
        self.h = handle

    @classmethod
    def born(cls, seed: int, now: float) -> "Core":
        return cls(lib().body_new(seed, now))

    @classmethod
    def from_package(cls, pkg: bytes, now: float) -> "Core | None":
        h = lib().body_from_package(pkg, len(pkg), now)
        return cls(h) if h else None

    def run(self, now: float):
        lib().body_run(self.h, now)

    def catch_up(self, now: float):
        lib().body_catch_up(self.h, now)

    def pet(self):
        lib().body_pet(self.h)

    def feed(self, food: int) -> int:
        return lib().body_feed(self.h, food)

    @property
    def hunger(self) -> float:
        return lib().body_hunger(self.h)

    @property
    def now(self) -> float:
        return lib().body_now(self.h)

    def export(self) -> bytes:
        buf = ctypes.create_string_buffer(CAP)
        n = lib().body_export(self.h, buf, CAP)
        if n < 0:
            raise RuntimeError("export falló")
        return buf.raw[:n]

    def free(self):
        if self.h:
            lib().body_free(self.h)
            self.h = None
