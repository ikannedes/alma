"""Árbitro de cuerpo: en qué cuerpo vive Alma (PLAN-RELOJ-v2.md, secciones 5 y 6).

Es lógica pura con su estado en un dict (se guarda como JSON); el transporte (WebSocket del robot,
HTTP del reloj, avisos por la APK) va aparte. Reglas:

- Un solo dueño del turno (`holder`) y un número de mudanza `n` que solo sube. Un cuerpo corre a Alma
  solo con la orden "keep" para su `n` y mientras no caduque su lease, contado desde que MANDÓ el hello
  que la renovó (así un acuse retrasado no la estira).
- Mudanza normal: el servidor pide "release" al cuerpo actual; `n` sube cuando llega el paquete (el cuerpo
  ya se detuvo). Si nunca llega, la mudanza se puede cancelar sin dejar a nadie con un número viejo.
- Mudanza forzada (robot desconectado 5 min, rescate): usa la última copia y sube `n` en el acto.
- Invariante: ROBOT_LEASE_S < ROBOT_OFFLINE_S. Cuando el servidor da por perdido al robot, el robot ya
  dejó de correr a Alma por su cuenta.
- Las órdenes se repiten en cada hello hasta que se cumplen: mensajes perdidos o duplicados no rompen nada.
"""

import base64
import json
import os
import tempfile

ROBOT, RELOJ = "robot", "reloj"
BODIES = (ROBOT, RELOJ)

ROBOT_LEASE_S = 180.0          # el robot renueva cada ~20 s; sin renovar 3 min, se duerme solo (6.4)
ROBOT_OFFLINE_S = 300.0        # 5 min sin el robot: Alma se va al reloj (6.4)
WATCH_LEASE_S = 72 * 3600.0    # el reloj vive sin conexión hasta 3 días (5.2)
RELEASE_TIMEOUT_S = {"cara": 1200.0, "manual": 600.0}   # sin respuesta del cuerpo actual: se cancela (cara: el reloj
#   con la app cerrada sincroniza cada ~15 min; dueño, 2026-11-04: que espere a que conteste)
LOCK_MAX_S = 3600.0            # un candado que nadie quita caduca (pase nocturno, actualización)
EV_IDS_KEEP = 5000
LOG_KEEP = 500

assert ROBOT_LEASE_S + 60 <= ROBOT_OFFLINE_S, "el lease del robot debe caducar antes de la mudanza por desconexión"

REASONS = ("boton", "cara", "manual", "desconexion", "rescate")


def fresh(holder: str = ROBOT, now: float = 0.0) -> dict:
    return {"v": 1, "holder": holder, "n": 1, "transit": None, "pkg": None, "seen": {}, "since": now,
            "locks": {}, "pending_req": None, "events": [], "ev_ids": [], "log": [], "notices": []}


def lease_s(body: str) -> float:
    return ROBOT_LEASE_S if body == ROBOT else WATCH_LEASE_S


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def _unb64(s: str) -> bytes:
    return base64.b64decode(s)


class Arbiter:
    def __init__(self, state: dict | None = None, now: float = 0.0):
        self.s = state if state is not None else fresh(now=now)

    # ---------- consultas ----------
    @property
    def n(self) -> int:
        return self.s["n"]

    @property
    def holder(self) -> str | None:
        return self.s["holder"]

    @property
    def transit(self) -> dict | None:
        return self.s["transit"]

    def where(self) -> dict:
        t = self.transit
        return {"cuerpo": self.holder or "transito", "n": self.n,
                "transito": None if not t else {k: t[k] for k in ("mid", "from", "to", "reason", "forced", "created")}}

    def _note(self, now: float, kind: str, **kw):
        self.s["log"].append({"at": now, "kind": kind, **kw})
        del self.s["log"][:-LOG_KEEP]

    # ---------- de los cuerpos ----------
    def hello(self, body: str, n_local: int, now: float, events: list | None = None,
              acked: list | None = None) -> dict:
        """Cada contacto de un cuerpo. events: eventos de un cuerpo que perdió el turno (5.6);
        acked: ids de eventos que el cuerpo ya aplicó."""
        assert body in BODIES
        self.s["seen"][body] = now
        if acked and body == self.holder and n_local == self.n and not self.transit:
            # solo cuenta el acuse del cuerpo que tiene a Alma: uno viejo pudo aplicarlo y perderlo después
            done = set(acked)
            self.s["events"] = [e for e in self.s["events"] if e["id"] not in done]
        for ev in events or []:
            self._event(ev, now, recovered_from=body)
        return self.directive(body, n_local, now)

    def directive(self, body: str, n_local: int, now: float) -> dict:
        t = self.transit
        if t:
            if body == t["from"] and t["pkg"] is None and not t["forced"]:
                return {"t": "release", "mid": t["mid"], "n": t["n_new"]}
            if body == t["to"] and t["pkg"] is not None:
                return {"t": "deliver", "mid": t["mid"], "n": t["n_new"], "pkg": _unb64(t["pkg"]),
                        "meta": t.get("meta"), "at": t["pkg_at"], "now": now, "reason": t["reason"]}
            return {"t": "absent", "n": self.n}
        if body == self.holder:
            if n_local == self.n:
                return {"t": "keep", "n": self.n, "lease_s": lease_s(body), "events": list(self.s["events"])}
            p = self.s["pkg"]
            if n_local < self.n and p and p["n"] == self.n:
                # el cuerpo perdió su copia (reloj reseteado, app reinstalada): se le reenvía la última (7)
                return {"t": "deliver", "mid": f"reenvio-{self.n}", "n": self.n, "pkg": _unb64(p["data"]),
                        "meta": p.get("meta"), "at": p["at"], "now": now, "reason": "reenvio",
                        "seq": p.get("seq", 0)}     # el cuerpo sigue numerando sus respaldos desde aquí
        return {"t": "absent", "n": self.n}

    def backup(self, body: str, n_local: int, pkg: bytes, now: float, meta=None, seq: int = 0) -> bool:
        """Respaldo periódico o por evento importante (5.5). Solo del dueño del turno con su número, y solo
        si es más nuevo que el guardado: `seq` lo numera el cuerpo (sube con cada respaldo), así un respaldo
        retrasado no pisa uno más reciente."""
        t = self.transit
        if body != self.holder or n_local != self.n:
            return False
        if t and not (t["from"] == body and t["pkg"] is None and not t["forced"]):
            return False
        p = self.s["pkg"]
        if p and p["n"] == self.n and p.get("body") == body and p.get("seq", 0) >= seq:
            return False
        self.s["pkg"] = {"body": body, "n": self.n, "at": now, "data": _b64(pkg), "meta": meta, "seq": seq}
        return True

    def release(self, body: str, mid: str, pkg: bytes, now: float, meta=None) -> bool:
        """El cuerpo actual ya se detuvo y entrega su memoria: aquí sube el número de mudanza."""
        t = self.transit
        if not t or t["mid"] != mid or body != t["from"] or t["forced"]:
            return any(e.get("mid") == mid and e["kind"] in ("soltada", "completa") for e in self.s["log"])
        if t["pkg"] is not None:
            return True                                   # duplicado
        self.s["n"] = t["n_new"]
        self.s["holder"] = None
        t.update(pkg=_b64(pkg), pkg_at=now, meta=meta, released=now)
        self.s["pkg"] = {"body": body, "n": t["n_new"], "at": now, "data": t["pkg"], "meta": meta}
        self._note(now, "soltada", mid=mid, body=body, n=t["n_new"])
        return True

    def ack(self, body: str, mid: str, ok: bool, now: float, why: str = "") -> bool:
        t = self.transit
        if not t or t["mid"] != mid or body != t["to"] or t["pkg"] is None:
            return any(e.get("mid") == mid and e["kind"] == "completa" for e in self.s["log"])
        if ok:
            self.s["holder"] = body
            self.s["transit"] = None
            self._note(now, "completa", mid=mid, to=body, n=self.n, reason=t["reason"])
            return True
        # el destino no entiende el paquete (versión de núcleo, 5.4): vuelve al cuerpo de origen
        self._note(now, "rechazada", mid=mid, to=body, why=why)
        self.s["notices"].append({"at": now, "kind": "mudanza_rechazada", "why": why})
        t["from"], t["to"] = t["to"], t["from"]
        t["reason"] = "regreso"
        return False

    # ---------- de la app, el reloj o el robot ----------
    def request(self, mid: str, to: str, reason: str, now: float) -> dict:
        """Pedir una mudanza. reason: boton, cara, manual (esperan al cuerpo actual) o rescate (forzada)."""
        assert to in BODIES and reason in REASONS
        t = self.transit
        if t and t["mid"] == mid or any(e.get("mid") == mid for e in self.s["log"]):
            return {"ok": True, "why": "ya_pedida"}
        if self._locked(now):
            self.s["pending_req"] = {"mid": mid, "to": to, "reason": reason, "at": now}
            return {"ok": True, "why": "espera_candado"}
        if t:
            return {"ok": False, "why": "en_transito"}
        if to == self.holder:
            return {"ok": False, "why": "ya_esta"}
        frm = self.holder
        nt = {"mid": mid, "from": frm, "to": to, "reason": reason, "created": now, "n_new": self.n + 1,
              "forced": False, "pkg": None, "pkg_at": None, "meta": None}
        self.s["transit"] = nt
        self._note(now, "pedida", mid=mid, frm=frm, to=to, reason=reason)
        if reason in ("rescate", "desconexion"):
            if not self._force(now):
                self.s["transit"] = None
                return {"ok": False, "why": "sin_copia"}
        return {"ok": True, "why": "en_curso"}

    def _force(self, now: float) -> bool:
        """Mudanza forzada con la última copia del linaje vigente."""
        t, p = self.transit, self.s["pkg"]
        if not p or p["n"] != self.n:
            return False
        t["forced"] = True
        self.s["n"] = t["n_new"]
        self.s["holder"] = None
        t.update(pkg=p["data"], pkg_at=p["at"], meta=p.get("meta"))
        self.s["pkg"] = dict(p, n=t["n_new"])
        self._note(now, "forzada", mid=t["mid"], to=t["to"], reason=t["reason"], copia_de=p["at"])
        return True

    def event(self, ev: dict, now: float) -> bool:
        """Evento para Alma (comida o caricia desde la PWA o el reloj): se entrega donde esté; en tránsito
        se encola para el cuerpo destino (5.3)."""
        return self._event(ev, now)

    def _event(self, ev: dict, now: float, recovered_from: str | None = None) -> bool:
        """Un id que ya pasó por aquí no se vuelve a encolar, salvo como recuerdo: un evento de la PWA que el
        cuerpo aplicó y luego perdió con su copia (mudanza forzada) tiene que poder volver. El cuerpo que lo
        recibe lo ignora si ya lo tiene en su memoria (5.6)."""
        if any(e["id"] == ev["id"] for e in self.s["events"]):
            return False
        if ev["id"] in self.s["ev_ids"] and not recovered_from:
            return False
        if ev["id"] not in self.s["ev_ids"]:
            self.s["ev_ids"].append(ev["id"])
        del self.s["ev_ids"][:-EV_IDS_KEEP]
        e = dict(ev, at=ev.get("at", now))
        if recovered_from:
            e["recuerdo_de"] = recovered_from
        self.s["events"].append(e)
        return True

    def lock(self, kind: str, on: bool, now: float):
        """Candado (5.3.7): pase nocturno o actualización de firmware; no hay mudanza mientras dure."""
        if on:
            self.s["locks"][kind] = now
        else:
            self.s["locks"].pop(kind, None)

    def _locked(self, now: float) -> bool:
        for k, at in list(self.s["locks"].items()):
            if now - at > LOCK_MAX_S:
                del self.s["locks"][k]
        return bool(self.s["locks"])

    # ---------- reloj del servidor ----------
    def tick(self, now: float):
        if self.s["pending_req"] and not self._locked(now) and not self.transit:
            r = self.s["pending_req"]
            self.s["pending_req"] = None
            self.request(r["mid"], r["to"], r["reason"], now)
        t = self.transit
        if t and not t["forced"] and t["pkg"] is None:
            lim = RELEASE_TIMEOUT_S.get(t["reason"])
            if lim is not None and now - t["created"] > lim:
                self.s["transit"] = None
                self._note(now, "cancelada", mid=t["mid"], why="sin_respuesta")
                return
        # 6.4: el robot lleva 5 min sin hablar y tiene a Alma (o la iba a soltar)
        robot_gone = now - self.s["seen"].get(ROBOT, self.s["since"]) >= ROBOT_OFFLINE_S
        if robot_gone and not self._locked(now):
            if not t and self.holder == ROBOT:
                self.request(f"desconexion-{self.n}", RELOJ, "desconexion", now)
            elif t and t["from"] == ROBOT and t["pkg"] is None and not t["forced"]:
                if self._force(now):
                    t["reason"] = "desconexion"
            elif t and t["to"] == ROBOT and t["pkg"] is None and not t["forced"]:
                self.s["transit"] = None   # el robot se fue mientras esperaba al reloj: Alma se queda donde está
                self._note(now, "cancelada", mid=t["mid"], why="robot_desconectado")


# ---------- persistencia ----------
def load(path: str, now: float = 0.0) -> Arbiter:
    try:
        with open(path, encoding="utf-8") as f:
            return Arbiter(json.load(f))
    except FileNotFoundError:
        return Arbiter(now=now)


def save(arb: Arbiter, path: str):
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".body-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(arb.s, f)
    os.replace(tmp, path)
