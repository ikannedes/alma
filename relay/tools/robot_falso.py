"""Robot falso para probar la mudanza de punta a punta en la PC (PLAN-RELOJ-v2.md, fases 2 y 3) sin tocar a EMO.

Se conecta a un servidor LOCAL por el enlace cifrado real (link.py), habla el protocolo body_* y usa el núcleo real
de Alma (sim/build/alma_body.dll) para exportar e importar paquetes ALMX, igual que el robot.

Uso: python tools/robot_falso.py ws://127.0.0.1:8765/v1/robot <llave_hex> [--cara-en S] [--durante S]
  --cara-en S: a los S segundos "reconoce al dueño" y pide la llegada (body_move), si Alma no está aquí.
Escribe una línea por cada cosa que pasa; al final imprime un resumen JSON.
"""

import argparse
import asyncio
import base64
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "..", "tests"))

import websockets  # noqa: E402

import alma_body  # noqa: E402
from alma_relay import link  # noqa: E402

LEASE_S = 180.0
T0 = 1793520000.0


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Robot:
    def __init__(self):
        self.core = alma_body.Core.born(42, T0)
        self.n, self.bseq, self.activo, self.lease_hasta, self.turno = 1, 0, False, -1.0, -1.0
        self.nonce, self.enviados = 0, {}
        self.rx = bytearray()
        self.rx_mid = None
        self.resumen = {"recibidas": [], "soltadas": [], "keeps": 0}

    def corriendo(self):
        return self.activo and self.core is not None and time.time() < self.lease_hasta

    def hello(self):
        self.nonce += 1
        self.enviados[self.nonce] = time.time()
        return {"t": "body_hello", "v": 1, "n": self.n, "nonce": self.nonce, "events": [], "acked": []}

    def trozos(self, kind, pkg, **head):
        parts = [pkg[i:i + 2400] for i in range(0, len(pkg), 2400)]
        out = []
        for k, p in enumerate(parts):
            m = {"t": "body_pkg", "kind": kind, "seq": k, "last": int(k == len(parts) - 1),
                 "data": base64.b64encode(p).decode()}
            if k == 0:
                m |= head
            out.append(m)
        return out

    def respaldo(self):
        self.bseq += 1
        return self.trozos("backup", self.core.export(), n=self.n, bseq=self.bseq, meta=[])

    def directiva(self, m):
        enviado = self.enviados.pop(m.get("nonce"), None)
        if enviado is None or enviado < self.turno:
            return []
        d = m["d"]
        if d == "keep" and m["n"] == self.n and self.core:
            if not self.activo:
                log("robot: Alma despierta aquí")
            self.activo = True
            self.lease_hasta = max(self.lease_hasta, enviado + m["lease_s"])
            self.resumen["keeps"] += 1
            return []
        if d == "release" and self.core:
            self.activo, self.turno = False, time.time()
            pkg = self.core.export()
            self.resumen["soltadas"].append({"mid": m["mid"], "bytes": len(pkg)})
            log(f"robot: suelto a Alma (mudanza {m['mid']}, {len(pkg)} bytes)")
            return self.trozos("release", pkg, mid=m["mid"], meta=[])
        if d == "deliver":
            self.rx, self.rx_mid, self.rx_head = bytearray(), m["mid"], m
            return []
        if d == "absent":
            if self.activo:
                log("robot: Alma ya no está aquí")
            self.activo = False
            if m["n"] > self.n and self.core:
                self.core.free()
                self.core = None
                self.turno = time.time()
        return []

    def trozo_entrante(self, m):
        if m.get("mid") != self.rx_mid:
            return []
        self.rx += base64.b64decode(m["data"])
        if not m.get("last"):
            return []
        h, pkg = self.rx_head, bytes(self.rx)
        c = alma_body.Core.from_package(pkg, T0)
        if c is None:
            log("robot: el paquete no se pudo importar")
            return [{"t": "body_ack", "mid": h["mid"], "ok": False, "why": "no se pudo importar"}]
        same = c.export()[24:-4] == pkg[24:-4]      # los bloques de memoria; el encabezado lleva la etiqueta del cuerpo
        if self.core:
            self.core.free()
        self.core, self.n, self.activo, self.turno = c, h["n"], True, time.time()
        self.lease_hasta = time.time() + LEASE_S
        self.bseq = max(self.bseq, h.get("seq", 0))
        self.resumen["recibidas"].append({"mid": h["mid"], "bytes": len(pkg), "bloques_iguales": same,
                                          "razon": h.get("reason")})
        log(f"robot: llegó Alma ({len(pkg)} bytes, bloques iguales: {same})")
        return [{"t": "body_ack", "mid": h["mid"], "ok": True}]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("llave")
    ap.add_argument("--cara-en", type=float, default=None)
    ap.add_argument("--durante", type=float, default=600)
    a = ap.parse_args()
    k = bytes.fromhex(a.llave)
    r = Robot()
    inicio = time.time()
    async with websockets.connect(a.url, max_size=2 ** 20) as ws:
        h = await ws.recv()
        nr, auth = link.make_auth(k, h[1:17], "robot-falso")
        await ws.send(auth)
        s = link.Session(link.session_key(k, h[1:17], nr), i_am_server=False)

        async def mandar(m):
            await ws.send(s.seal(m))

        await mandar({"t": "state", "state": "ST_AWAKE", "simple_mood": "SM_HAPPY", "care_v": 1})
        await mandar(r.hello())
        sig_hello, sig_resp, cara_pedida = time.time() + 20, time.time() + 120, False
        while time.time() - inicio < a.durante:
            try:
                fr = await asyncio.wait_for(ws.recv(), timeout=1.0)
                m = s.open(fr)
                out = []
                if m.get("t") == "body":
                    out = r.directiva(m)
                elif m.get("t") == "body_pkg_in":
                    out = r.trozo_entrante(m)
                elif m.get("t") == "body_poke":
                    out = [r.hello()]
                elif m.get("t") in ("body_pkg_result", "body_move_result"):
                    log("robot: servidor dice", json.dumps(m, ensure_ascii=False))
                for o in out:
                    await mandar(o)
            except asyncio.TimeoutError:
                pass
            if time.time() >= sig_hello:
                sig_hello = time.time() + 20
                await mandar(r.hello())
            if r.corriendo() and time.time() >= sig_resp:
                sig_resp = time.time() + 600
                for o in r.respaldo():
                    await mandar(o)
            if a.cara_en is not None and not cara_pedida and time.time() - inicio >= a.cara_en and not r.corriendo():
                cara_pedida = True
                log("robot: reconozco al dueño (id 0) sostenido: pido la llegada")
                await mandar({"t": "body_move", "mid": "cara-" + str(int(time.time()))})
    print(json.dumps(r.resumen, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
