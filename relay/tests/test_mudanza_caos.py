"""Fase 0 del plan del reloj (PLAN-RELOJ-v2.md, sección 19): mudanzas con caos en la PC.

El árbitro real (alma_relay.body) y dos cuerpos simulados (robot y reloj) que corren el núcleo real de Alma
(sim/body_lib.c por ctypes). La red pierde, duplica y retrasa mensajes; los cuerpos se desconectan, se
reinician y el reloj hasta se resetea; el servidor se reinicia desde su JSON. Se revisa:

1. Nunca dos Almas corriendo a la vez (salvo tras un rescate forzado con el reloj vivo y sin conexión,
   riesgo que el dueño aceptó en 6.4b).
2. Cuando el servidor da por perdido al robot (6.4), el robot ya se durmió solo (invariante del lease).
3. Un paquete importado es exactamente el que se exportó (exportar → importar → exportar da lo mismo).
4. Ningún evento importante se pierde ni se aplica dos veces; solo puede perderse lo vivido en un reloj
   reseteado después de su último respaldo.

Días simulados por semilla: ALMA_CAOS_DIAS (por omisión 1); semillas: ALMA_CAOS_SEMILLAS (por omisión 3).
"""

import json
import os
import random
import sys

import pytest

from alma_relay import body
from alma_relay.body import RELOJ, ROBOT

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alma_body  # noqa: E402

pytestmark = pytest.mark.skipif(not alma_body.available(), reason="falta sim/build/alma_body (sim/build.sh)")

T0 = 1793520000.0          # 2026-11-01, hora local simulada
HELLO_S = {ROBOT: 20.0, RELOJ: 900.0}


class Net:
    def __init__(self, rng):
        self.rng, self.q, self.drop, self.dup, self.sent = rng, [], 0.05, 0.03, 0

    def send(self, now, fn, slow=False):
        if self.rng.random() < self.drop:
            return
        for _ in range(2 if self.rng.random() < self.dup else 1):
            d = self.rng.uniform(0, 120) if (slow or self.rng.random() < 0.03) else self.rng.uniform(0.05, 3)
            self.q.append((now + d, self.sent, fn))
            self.sent += 1

    def due(self, now):
        self.q.sort(key=lambda x: (x[0], x[1]))
        while self.q and self.q[0][0] <= now:
            yield self.q.pop(0)[2]


class Body:
    def __init__(self, name, sim):
        self.name, self.sim = name, sim
        self.lease = body.lease_s(name)
        self.core, self.mem, self.n = None, set(), 0
        self.active, self.lease_until = False, -1.0
        self.flash = None                 # copia persistente: (pkg, mem, n)
        self.released, self.imported = {}, set()
        self.backup_ok = set()            # eventos del último respaldo aceptado
        self.stale, self.acked = [], []
        self.online, self.next_hello, self.counter = True, 0.0, 0
        self.turn_at = -1.0
        self.seq = 0                      # número de respaldo, sube siempre               # último cambio de turno: soltar, recibir o "ya no está"

    def running(self, now):
        return self.active and self.core is not None and now < self.lease_until

    # --- vida ---
    def live(self, now):
        if self.active and self.core and now >= self.lease_until:
            self.core.run(self.lease_until)         # caducó: se duerme en el acto (6.4)
            self.active = False
        if self.running(now):
            self.core.run(now)
            if now >= getattr(self, "next_backup", 0):          # respaldo cada 10 min (5.5)
                self.next_backup = now + 600
                self.send_backup(now)

    def save_local(self):
        self.flash = (self.core.export(), set(self.mem), self.n)

    def important(self, now, kind="comida"):
        if not self.running(now):
            return
        self.counter += 1
        eid = f"{self.name}-{self.counter}"
        self.core.run(now)
        self.core.feed(self.sim.rng.randrange(16))
        self.mem.add(eid)
        self.sim.generated.add(eid)
        self.save_local()
        self.send_backup(now)

    def send_backup(self, now):
        pkg, meta, n = self.core.export(), sorted(self.mem), self.n
        sim = self.sim
        self.seq += 1
        seq = self.seq

        def at_server(t):
            ok = sim.arb.backup(self.name, n, pkg, t, meta=meta, seq=seq)
            sim.net.send(t, lambda t2: self._backup_result(ok, meta))
        if self.online:
            sim.net.send(now, at_server)

    def _backup_result(self, ok, meta):
        if ok and self.online:
            self.backup_ok = set(meta)

    # --- protocolo ---
    def hello(self, now):
        if not self.online:
            return
        sim, n, sent_at = self.sim, self.n, now
        events = [{"id": e, "kind": "recuerdo"} for e in self.stale]
        acked = [e for e in self.acked if e in self.mem]   # solo eventos de la memoria actual

        def at_server(t):
            d = sim.arb.hello(self.name, n, t, events=events, acked=acked)
            sim.after_server(t)
            sim.net.send(t, lambda t2: self.on_directive(d, sent_at, t2, bool(events)))
        sim.net.send(now, at_server)

    def on_directive(self, d, sent_at, now, carried_events):
        if not self.online:
            return
        sim = self.sim
        self.live(now)
        if sent_at < self.turn_at:
            return                         # respuesta a un hello anterior al último cambio de turno: vieja
        if d["t"] == "keep":
            if d["n"] == self.n and self.core is not None:
                if not self.active:
                    self.core.catch_up(now)
                    self.active = True
                self.lease_until = max(self.lease_until, sent_at + d["lease_s"])
                new = False
                for e in d["events"]:
                    if e["id"] not in self.mem and self.running(now):
                        self.mem.add(e["id"])
                        self.core.feed(3)
                        new = True
                    if e["id"] in self.mem and e["id"] not in self.acked:
                        self.acked.append(e["id"])
                self.acked = self.acked[-200:]
                if new:                                    # evento importante: guardar y respaldar (5.5)
                    self.save_local()
                    self.send_backup(now)
        elif d["t"] == "release":
            mid = d["mid"]
            if mid not in self.released:
                if self.core is None:
                    return
                if self.active:
                    self.core.run(now)
                self.active = False
                self.turn_at = now
                self.save_local()
                self.released[mid] = (self.core.export(), sorted(self.mem))
            pkg, meta = self.released[mid]

            def at_server(t):
                sim.arb.release(self.name, mid, pkg, t, meta=meta)
                sim.after_server(t)
            sim.net.send(now, at_server)
        elif d["t"] == "deliver":
            mid = d["mid"]
            if not (mid in self.imported and self.n == d["n"]):
                c = alma_body.Core.from_package(d["pkg"], d["at"])
                if c is None:
                    sim.send_ack(self, mid, False, now)
                    return
                assert c.export() == d["pkg"], "el paquete importado no es el exportado"
                c.catch_up(now)
                # lo que la copia local vieja vivió y la nueva no trae vuelve como recuerdo (5.6)
                leftover = (self.mem - set(d["meta"] or [])) if self.core else set()
                if self.core:
                    self.core.free()
                self.core, self.mem, self.n, self.acked = c, set(d["meta"] or []), d["n"], []
                for e in sorted(leftover):
                    self.mem.add(e)
                    self.core.feed(3)
                self.active, self.lease_until = True, sent_at + self.lease
                self.backup_ok, self.stale = set(d["meta"] or []), []
                self.imported.add(mid)
                self.seq = max(self.seq, d.get("seq", 0))
                self.turn_at = now
                self.save_local()
                if leftover:
                    self.send_backup(now)
                sim.check_two(now, f"deliver {mid}")
            sim.send_ack(self, mid, True, now)
        elif d["t"] == "absent":
            if self.running(now) and d["n"] > self.n and self.name == RELOJ:
                sim.overlap_ok = False
            if self.active:
                self.turn_at = now
            self.active = False
            if self.core is not None and d["n"] > self.n:
                if not carried_events:
                    self.stale = sorted(self.mem - self.backup_ok)
                if carried_events or not self.stale:
                    self.core.free()               # descarta su copia local (6.4)
                    self.core, self.stale, self.flash = None, [], None
                    self.mem, self.acked = set(), []

    # --- energía ---
    def reboot(self, now):
        """Reinicio: se pierde la RAM; la memoria vuelve de la flash; arranca sin Alma (7)."""
        self.active, self.lease_until, self.released = False, -1.0, {}
        if self.core:
            self.core.free()
        self.core = None
        if self.flash:
            pkg, mem, n = self.flash
            self.core = alma_body.Core.from_package(pkg, now)
            self.mem, self.n = set(mem), n

    def wipe(self, now):
        """Reloj reseteado o app reinstalada: sin memoria (7)."""
        self.sim.allowed_lost |= self.mem - self.sim.server_mem()
        self.active, self.lease_until, self.released = False, -1.0, {}
        if self.core:
            self.core.free()
        self.core, self.mem, self.n, self.flash, self.stale, self.seq = None, set(), 0, None, [], 0


class Sim:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.net = Net(self.rng)
        self.arb = body.Arbiter(now=T0)
        self.robot, self.reloj = Body(ROBOT, self), Body(RELOJ, self)
        self.robot.core = alma_body.Core.born(seed, T0)
        self.robot.n = 1
        self.robot.save_local()
        self.generated, self.pwa_events, self.allowed_lost = set(), set(), set()
        self.overlap_ok, self.violations, self.forced_seen = False, [], 0
        self.stats = {"pedidas": 0, "completas": 0, "forzadas": 0, "rescates": 0, "reinicios": 0, "resets": 0}
        self.log_seen = 0

    def bodies(self):
        return (self.robot, self.reloj)

    def server_mem(self):
        p = self.arb.s["pkg"]
        return set((p or {}).get("meta") or [])

    def send_ack(self, b, mid, ok, now):
        def at_server(t):
            self.arb.ack(b.name, mid, ok, t)
            self.after_server(t)
        self.net.send(now, at_server)

    def after_server(self, t):
        for e in self.arb.s["log"][self.log_seen:]:
            if e["kind"] == "forzada" and e["reason"] == "desconexion":
                self.stats["forzadas"] += 1
                if self.robot.running(t):
                    self.violations.append(f"{t}: el servidor movió a Alma con el robot corriendo")
            if e["kind"] == "completa":
                self.stats["completas"] += 1
        self.log_seen = len(self.arb.s["log"])

    def check_two(self, now, where=""):
        run = [b.name for b in self.bodies() if b.running(now)]
        if len(run) > 1 and not self.overlap_ok:
            self.violations.append(f"{now - T0:.0f}s {where}: dos Almas {run}")

    def request(self, now, to, reason):
        mid = f"m{self.rng.getrandbits(48):x}"
        self.stats["pedidas"] += 1
        if reason == "rescate":
            self.stats["rescates"] += 1
            if self.reloj.running(now) or self.reloj.active:
                self.overlap_ok = True        # riesgo aceptado (6.4b)
        for k in range(3):                    # la app reintenta con el mismo id
            self.net.send(now + 5 * k, lambda t: (self.arb.request(mid, to, reason, t), self.after_server(t)))

    def step(self, now, calm=False):
        for fn in self.net.due(now):
            fn(now)
        for b in self.bodies():
            b.live(now)
            if now >= b.next_hello:
                b.next_hello = now + HELLO_S[b.name] * (1 if calm else self.rng.uniform(0.5, 1.5))
                b.hello(now)
        if int(now) % 10 == 0:
            self.arb.tick(now)
            self.after_server(now)
            t = self.arb.transit
            if t and RELOJ in (t["from"], t["to"]) and int(now) % 30 == 0:
                self.net.send(now, lambda t2: self.reloj.hello(t2))      # aviso por la APK (puede perderse)
        if self.reloj.running(now) is False and not self.reloj.active:
            pass
        self.check_two(now)
        if calm:
            return
        r = self.rng.random
        holder = self.arb.holder
        if r() < 1 / 1200:                                   # el dueño hace algo cada ~20 min
            if holder == ROBOT:
                self.request(now, RELOJ, "boton")
            elif holder == RELOJ:
                x = r()
                self.request(now, ROBOT, "rescate" if x < 0.05 else "manual" if x < 0.2 else "cara")
        if r() < 1 / 900:                                    # comida desde la PWA
            eid = f"pwa-{self.rng.getrandbits(40):x}"

            def at_server(t, eid=eid):
                if self.arb.event({"id": eid, "kind": "comida"}, t):
                    self.pwa_events.add(eid)          # solo cuenta lo que el servidor aceptó
            self.net.send(now, at_server)
        for b in self.bodies():
            if r() < 1 / 1800:
                b.important(now)
            if b.online and r() < (1 / 3000 if b.name == ROBOT else 1 / 5000):
                b.online = False
                b.back_at = now + self.rng.choice([30, 120, 240, 290, 310, 360, 900, 3600])
            elif not b.online and now >= b.back_at:
                b.online = True
                b.next_hello = now
            if r() < 1 / 20000:
                self.stats["reinicios"] += 1
                b.reboot(now)
        if r() < 1 / 200000:
            self.stats["resets"] += 1
            self.reloj.wipe(now)
        if r() < 1 / 5000:                                   # pase nocturno del robot: candado de 2 min
            self.arb.lock("noche_robot", True, now)
            self.net.send(now + 120, lambda t: self.arb.lock("noche_robot", False, t), slow=False)
        if r() < 1 / 7200:                                   # el servidor se reinicia desde su JSON
            self.arb = body.Arbiter(json.loads(json.dumps(self.arb.s)))


def run_seed(seed, days):
    sim = Sim(seed)
    now = T0
    end = T0 + days * 86400
    while now < end:
        sim.step(now)
        now += 1.0
    # calma: todos conectados, sin pérdidas, hasta que se asiente
    sim.net.drop = sim.net.dup = 0.0
    for b in sim.bodies():
        b.online, b.next_hello = True, now
    sim.arb.lock("noche_robot", False, now)
    for _ in range(4 * 3600):
        sim.step(now, calm=True)
        now += 1.0
    return sim, now


@pytest.mark.parametrize("seed", range(int(os.environ.get("ALMA_CAOS_SEMILLAS", "3"))))
def test_caos(seed):
    days = float(os.environ.get("ALMA_CAOS_DIAS", "1"))
    sim, now = run_seed(seed, days)
    print(seed, sim.stats, "violaciones:", len(sim.violations))
    assert not sim.violations, sim.violations[:5]
    run = [b for b in sim.bodies() if b.running(now)]
    assert len(run) == 1, "al final Alma vive en exactamente un cuerpo"
    alma = run[0]
    assert sim.arb.transit is None and sim.arb.holder == alma.name and alma.n == sim.arb.n
    lost = (sim.generated | sim.pwa_events) - alma.mem - sim.allowed_lost
    assert not lost, f"eventos perdidos: {sorted(lost)[:10]}"
    assert sim.stats["completas"] > 0
