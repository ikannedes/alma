"""Alma en el reloj (PLAN-RELOJ-v2.md): el árbitro de cuerpo en vivo, la API HTTP del reloj y de la APK del
celular, la vinculación de dispositivos y los mensajes del robot para mudarse.

Seguridad: el reloj y el celular entran con su propia llave (Bearer), revocable sin tocar al robot ni a la app.
La llave se obtiene con un código de vinculación de un solo uso que el dueño genera desde la app (10 min).

Mientras el robot no hable el protocolo de mudanza (firmware nuevo, mensajes "body_*"), el árbitro queda quieto:
Alma vive en el robot como siempre y las mudanzas se rechazan con un aviso claro.
"""

import asyncio
import base64
import hashlib
import json
import os
import secrets
import time

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse

from . import body, care, haiku, mem_backup, milestones, notify, rules, settings

router = APIRouter()

PAIR_S = 600
ROBOT_MAX_EVENTOS = 48      # el robot lee mensajes de hasta 16 KB (UPLINK_MAX): no más de 48 eventos por mensaje
DEVICES = ("reloj", "celular")
CHUNK = 2400
_lock = asyncio.Lock()
_arb: body.Arbiter | None = None


# ---------- estado ----------
def _path() -> str:
    return os.path.join(settings.data_dir(), "body.json")


def arb() -> body.Arbiter:
    global _arb
    if _arb is None:
        _arb = body.load(_path(), now=time.time())
    return _arb


def save() -> None:
    body.save(arb(), _path())


def reset_for_tests() -> None:
    global _arb
    _arb = None


def robot_ready() -> bool:
    """El robot ya habló el protocolo de mudanza alguna vez (firmware con modo "Alma no está")."""
    return bool(settings.get("robot_body_v"))


def active() -> bool:
    return robot_ready() and bool(settings.get("reloj_activo", True))


# ---------- dispositivos ----------
def _h(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


def new_pair_code(now: float | None = None) -> str:
    now = now or time.time()
    code = f"{secrets.randbelow(10 ** 8):08d}"
    settings.update(pair_code={"h": _h(code), "exp": now + PAIR_S})
    return code


def pair(code: str, now: float | None = None, solo: str | None = None) -> dict | None:
    """Llaves nuevas para el celular y el reloj (la APK le pasa la suya al reloj), o solo para `solo` si el reloj
    se vincula directo con el código; la llave del otro dispositivo se conserva."""
    now = now or time.time()
    pc = settings.load().get("pair_code") or {}
    if not code or not pc or pc.get("exp", 0) < now or not secrets.compare_digest(pc.get("h", ""), _h(code)):
        return None
    which = [solo] if solo in DEVICES else list(DEVICES)
    toks = {d: secrets.token_urlsafe(32) for d in which}
    devs = dict(settings.load().get("devices") or {}) | {d: _h(t) for d, t in toks.items()}
    settings.update(pair_code=None, devices=devs)
    return toks


def device(request: Request) -> str | None:
    a = request.headers.get("authorization", "")
    if not a.lower().startswith("bearer "):
        return None
    h = _h(a[7:].strip())
    for d, v in (settings.load().get("devices") or {}).items():
        if secrets.compare_digest(v, h):
            return d
    return None


def _deny():
    return JSONResponse({"error": "dispositivo no vinculado"}, status_code=401)


# ---------- directivas ----------
def _wire(d: dict) -> dict:
    """La directiva para HTTP: el paquete va en base64."""
    if "pkg" in d:
        d = dict(d, pkg=base64.b64encode(d["pkg"]).decode())
    return d


def where() -> dict:
    w = arb().where()
    return w | {"activo": active(), "robot_listo": robot_ready()}


def _remember_pkg(pkg: bytes) -> None:
    """Cada paquete aceptado también va a las copias de mem_backups (las últimas 20)."""
    c = mem_backup.Chunks()
    c.data = bytearray(pkg)
    mem_backup.save(c)


_al_robot: list[dict] = []        # lo que hay que mandarle al robot después de una mudanza (recuerdos del paseo)


def _announce(before: dict, now: float) -> None:
    """Avisos al dueño cuando termina una mudanza; empieza o termina el paseo."""
    after = arb().where()
    if before.get("cuerpo") != after["cuerpo"] and after["cuerpo"] in body.BODIES:
        if after["cuerpo"] == body.RELOJ:
            _salida(now)
        elif (p := _regreso(now)):
            _al_robot.append(p)
        last = next((e for e in reversed(arb().s["log"]) if e["kind"] == "completa"), {})
        if after["cuerpo"] == body.RELOJ:
            title = "Alma se fue contigo ⌚" if last.get("reason") != "desconexion" else "El robot se quedó dormido ⌚"
            text = "Ahora vive en tu reloj." if last.get("reason") != "desconexion" else "Alma se vino a tu reloj."
        else:
            title, text = "Alma regresó al robot 🤖", "Ya está en casa."
        notify.push("mudanza", title, text)


# ---------- paseos: lo que Alma vive en el reloj (13) ----------
SEG_POR_PASO = 0.6          # ~100 pasos por minuto
MIL_PASOS = 1000


def _paseos_path() -> str:
    return os.path.join(settings.data_dir(), "paseos.json")


def _paseos() -> dict:
    try:
        with open(_paseos_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"actual": None, "dias": {}, "pasos_reloj": {}}


def _paseos_save(d: dict) -> None:
    tmp = _paseos_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, _paseos_path())


def _hoy(now: float) -> str:
    import datetime as dt
    from . import alarms
    return dt.datetime.fromtimestamp(now, alarms.tz()).strftime("%Y-%m-%d")


def _dia(d: dict, now: float) -> dict:
    return d["dias"].setdefault(_hoy(now), {"salidas": 0, "pasos": 0, "minutos": 0, "pulso_alto": 0})


def salud(info: dict, now: float) -> None:
    """Resumen del reloj (14): pasos del día y momentos de pulso alto. Solo resúmenes, nunca el pulso segundo a segundo."""
    if not isinstance(info, dict):
        return
    d = _paseos()
    dia = str(info.get("dia") or _hoy(now))
    pasos = int(info.get("pasos") or 0)
    antes = d["pasos_reloj"].get(dia, 0)
    d["pasos_reloj"] = {dia: max(antes, pasos)}                    # solo el de hoy; el reloj reinicia la cuenta
    nuevos = max(0, pasos - antes)
    hoy = _dia(d, now)
    hoy["pulso_alto"] = max(hoy.get("pulso_alto", 0), int(info.get("pulso_alto") or 0))
    a = d.get("actual")
    if a and nuevos:
        a["pasos"] = a.get("pasos", 0) + nuevos
        hoy["pasos"] += nuevos
        care.add_exercise("paseo", nuevos * SEG_POR_PASO, now)
        if a["pasos"] >= MIL_PASOS:
            milestones.learned("mil_pasos", "Mil pasos juntos", "Caminaron mil pasos con Alma en tu muñeca.", "👣", now)
    for k in sorted(d["dias"])[:-14]:
        del d["dias"][k]
    _paseos_save(d)


def _salida(now: float) -> None:
    d = _paseos()
    d["actual"] = {"desde": now, "pasos": 0, "comidas": 0}
    _dia(d, now)["salidas"] += 1
    _paseos_save(d)
    milestones.learned("primer_paseo", "Su primer paseo contigo", "Alma salió por primera vez en tu reloj.", "⌚", now)


def _regreso(now: float) -> dict | None:
    """Termina el paseo y devuelve lo que Alma "cuenta" al llegar al robot."""
    d = _paseos()
    a = d.get("actual")
    if not a:
        return None
    minutos = int((now - a["desde"]) / 60)
    _dia(d, now)["minutos"] += minutos
    d["actual"] = None
    _paseos_save(d)
    return {"t": "paseo", "minutos": minutos, "pasos": a.get("pasos", 0), "comidas": a.get("comidas", 0),
            "cansada": a.get("pasos", 0) >= 3000}


def comio_en_paseo() -> None:
    d = _paseos()
    if d.get("actual"):
        d["actual"]["comidas"] = d["actual"].get("comidas", 0) + 1
        _paseos_save(d)


def today_summary(now: float | None = None) -> dict | None:
    """Para el diario nocturno con Haiku (13): lo vivido en el reloj hoy, en números chicos."""
    now = now or time.time()
    hoy = _paseos()["dias"].get(_hoy(now))
    if not hoy or not (hoy.get("salidas") or hoy.get("pasos")):
        return None
    out = {"salidas_en_el_reloj": hoy["salidas"], "minutos_fuera": hoy["minutos"], "pasos_juntos": hoy["pasos"]}
    if hoy.get("pulso_alto"):
        out["el_dueño_se_agitó"] = True                              # a Haiku solo una frase, nunca cifras médicas
    return out


# ---------- robot (WebSocket) ----------
class RobotPkg:
    """Paquete del robot en trozos: {"t":"body_pkg","kind","seq","last","data",...}."""

    def __init__(self):
        self.c = mem_backup.Chunks()
        self.head: dict = {}

    def add(self, msg: dict) -> bool:
        if msg.get("seq") == 0:
            self.head = {k: msg.get(k) for k in ("kind", "n", "bseq", "mid", "meta")}
        return self.c.add(msg)

    def bytes(self) -> bytes | None:
        data = bytes(self.c.data)
        return None if self.c.broken or not mem_backup.valid(data) else data


def robot_out(d: dict, nonce=None) -> list[dict]:
    """La directiva para el robot; el paquete va aparte en trozos {"t":"body_pkg_in"}."""
    head = {("d" if k == "t" else k): v for k, v in d.items() if k != "pkg"}
    for k in ("meta", "events"):
        if isinstance(head.get(k), list):
            # meta: los más recientes (lo demás ya vive en el paquete); events: los más viejos primero, el resto
            # llega en los siguientes hellos conforme el robot los confirma
            head[k] = head[k][-ROBOT_MAX_EVENTOS:] if k == "meta" else head[k][:ROBOT_MAX_EVENTOS]
    out = [{"t": "body", "nonce": nonce} | head]          # d: keep, release, deliver o absent
    if "pkg" in d:
        p = d["pkg"]
        parts = [p[i:i + CHUNK] for i in range(0, len(p), CHUNK)]
        out += [{"t": "body_pkg_in", "mid": d["mid"], "seq": k, "last": int(k == len(parts) - 1),
                 "data": base64.b64encode(x).decode()} for k, x in enumerate(parts)]
    return out


async def on_robot(msg: dict, rpkg: RobotPkg, now: float | None = None) -> list[dict]:
    """Mensajes body_* del robot. Devuelve lo que hay que mandarle."""
    now = now or time.time()
    t = msg.get("t")
    if not settings.get("robot_body_v"):
        settings.update(robot_body_v=int(msg.get("v", 1)))
    async with _lock:
        a, before = arb(), arb().where()
        out: list[dict] = []
        if t == "body_hello":
            for k, on in (msg.get("locks") or {}).items():
                a.lock(f"robot_{k}", bool(on), now)
            d = a.hello(body.ROBOT, int(msg.get("n", 0)), now, events=msg.get("events"), acked=msg.get("acked"))
            out = robot_out(d, msg.get("nonce"))
        elif t == "body_pkg" and rpkg.add(msg):
            data, h = rpkg.bytes(), rpkg.head
            if data is None:
                out = [{"t": "body_pkg_result", "kind": h.get("kind"), "ok": False, "why": "paquete dañado"}]
            elif h.get("kind") == "backup":
                ok = a.backup(body.ROBOT, int(h.get("n") or 0), data, now, meta=h.get("meta"), seq=int(h.get("bseq") or 0))
                if ok:
                    await asyncio.to_thread(_remember_pkg, data)
                out = [{"t": "body_pkg_result", "kind": "backup", "bseq": h.get("bseq"), "ok": ok}]
            elif h.get("kind") == "release":
                ok = a.release(body.ROBOT, str(h.get("mid")), data, now, meta=h.get("meta"))
                if ok:
                    await asyncio.to_thread(_remember_pkg, data)
                out = [{"t": "body_pkg_result", "kind": "release", "mid": h.get("mid"), "ok": ok}]
        elif t == "body_ack":
            a.ack(body.ROBOT, str(msg.get("mid")), bool(msg.get("ok")), now, why=str(msg.get("why") or ""))
        elif t == "body_move":       # la llegada por cara la pide el robot (6.2)
            r = a.request(str(msg.get("mid")), body.ROBOT, "cara", now) if active() else {"ok": False, "why": "inactivo"}
            out = [{"t": "body_move_result", "mid": msg.get("mid")} | r]
        save()
        _announce(before, now)
        while _al_robot:
            out.append(_al_robot.pop(0))       # "te cuento mi paseo": el robot lo usa para saludar (13)
    return out


async def tick(now: float | None = None) -> bool:
    """Cada 10 s (lo llama el ciclo de web.py). True si cambió algo que el robot deba saber."""
    if not active():
        return False
    now = now or time.time()
    async with _lock:
        before = json.dumps(arb().where(), sort_keys=True)
        b = arb().where()
        arb().tick(now)
        changed = json.dumps(arb().where(), sort_keys=True) != before
        if changed:
            save()
            _announce(b, now)
    return changed


# ---------- reloj (HTTP) ----------
def _robot_window() -> dict:
    from . import web
    st = web.hub.state or {}
    online = web.hub.ws is not None and time.time() - web.hub.last_seen < 30
    out = {"online": online, "state": st.get("state"), "mood": st.get("simple_mood"), "face": st.get("face"),
           "age_days": st.get("age_days"), "wellbeing": st.get("wellbeing")}   # la página "¿Cómo está?" del reloj
    if st.get("alma_here") is False:   # cuerpo vacío: su núcleo no corre y su ánimo no es el de Alma (salía "asustada")
        for k in ("mood", "age_days", "wellbeing"):
            out.pop(k)
    if care.enabled(st):
        s = care.snapshot()
        out["care"] = {k: s.get(k) for k in ("hunger", "sick", "weight", "energy")}
    return out


@router.post("/v1/reloj/hello")
async def reloj_hello(request: Request):
    if device(request) != "reloj":
        return _deny()
    b = await request.json()
    now = time.time()
    async with _lock:
        a, before = arb(), arb().where()
        for k, on in (b.get("locks") or {}).items():
            a.lock(f"reloj_{k}", bool(on), now)
        d = a.hello(body.RELOJ, int(b.get("n", 0)), now, events=b.get("events"), acked=b.get("acked"))
        save()
        _announce(before, now)
        if b.get("salud"):
            salud(b["salud"], now)
    return {"directive": _wire(d), "where": where(), "server_time": now, "robot": _robot_window()}


@router.post("/v1/reloj/backup")
async def reloj_backup(request: Request):
    if device(request) != "reloj":
        return _deny()
    b = await request.json()
    try:
        pkg = base64.b64decode(b.get("pkg") or "")
    except ValueError:
        return JSONResponse({"error": "paquete"}, status_code=400)
    if not mem_backup.valid(pkg):
        return JSONResponse({"error": "paquete dañado"}, status_code=400)
    async with _lock:
        ok = arb().backup(body.RELOJ, int(b.get("n", 0)), pkg, time.time(), meta=b.get("meta"), seq=int(b.get("seq", 0)))
        save()
    if ok:
        await asyncio.to_thread(_remember_pkg, pkg)
    return {"ok": ok}


@router.post("/v1/reloj/release")
async def reloj_release(request: Request):
    if device(request) != "reloj":
        return _deny()
    b = await request.json()
    pkg = base64.b64decode(b.get("pkg") or "")
    if not mem_backup.valid(pkg):
        return JSONResponse({"error": "paquete dañado"}, status_code=400)
    async with _lock:
        ok = arb().release(body.RELOJ, str(b.get("mid")), pkg, time.time(), meta=b.get("meta"))
        save()
    if ok:
        await asyncio.to_thread(_remember_pkg, pkg)
    return {"ok": ok}


@router.post("/v1/reloj/ack")
async def reloj_ack(request: Request):
    if device(request) != "reloj":
        return _deny()
    b = await request.json()
    now = time.time()
    async with _lock:
        before = arb().where()
        ok = arb().ack(body.RELOJ, str(b.get("mid")), bool(b.get("ok")), now, why=str(b.get("why") or ""))
        save()
        _announce(before, now)
    return {"ok": ok}


async def _move(mid: str, to: str, reason: str) -> dict:
    if not active():
        why = "el robot todavía no sabe mudarse (falta su firmware nuevo)" if not robot_ready() else "desactivado"
        return {"ok": False, "why": why}
    if to not in body.BODIES or reason not in ("boton", "manual", "rescate"):
        return {"ok": False, "why": "pedido inválido"}
    async with _lock:
        r = arb().request(mid, to, reason, time.time())
        save()
    from . import web
    await web.hub.send({"t": "body_poke"})       # que el robot pregunte ya
    return r | {"where": where()}


@router.post("/v1/mudanza")
async def mudanza(request: Request):
    """Llévame contigo / Regresa al robot / Rescate, desde el reloj o la APK."""
    d = device(request)
    if not d:
        return _deny()
    b = await request.json()
    reason = str(b.get("reason") or "boton")
    if reason == "rescate" and d != "celular":
        return JSONResponse({"error": "el rescate se pide desde el celular o la app"}, status_code=403)
    return await _move(str(b.get("mid") or secrets.token_hex(8)), str(b.get("to")), reason)


@router.post("/v1/reloj/evento")
async def reloj_evento(request: Request):
    """Algo que el dueño hizo en el reloj mientras Alma está en el robot (8.4): el robot reacciona."""
    if device(request) != "reloj":
        return _deny()
    b = await request.json()
    kind, data = b.get("kind"), b.get("data") or {}
    w = arb().where()
    if w["cuerpo"] == body.RELOJ:
        return {"ok": False, "why": "Alma está en el reloj"}
    if w["cuerpo"] == "transito":
        async with _lock:
            arb().event({"id": str(b.get("id")), "kind": kind, "data": data}, time.time())
            save()
        return {"ok": True, "queued": True}
    from . import web
    if kind == "comida":
        return await _feed(str(data.get("food")))
    if kind == "orden":
        ok = await web.hub.send({"t": "command", "action_id": str(data.get("action_id"))})
        return {"ok": ok}
    if kind == "truco":
        return await web._robot_trick(str(data.get("mot")))
    if kind in ("caricia", "juego"):
        ok = await web.hub.send({"t": "remote", "kind": kind, "data": data, "from": "reloj"})
        return {"ok": ok}
    return JSONResponse({"error": "evento desconocido"}, status_code=400)


async def _feed(food: str) -> dict:
    from . import web
    if food not in care.FOOD:
        return {"ok": False, "why": "comida desconocida"}
    if care.enabled(web.hub.state):
        r = await web._feed_server(food)
        return r if isinstance(r, dict) else {"ok": False, "why": "Alma no está conectada"}
    return {"ok": False, "why": "el cuidado del servidor no está activo"}


@router.post("/v1/reloj/comer")
async def reloj_comer(request: Request):
    """Comida cuando Alma vive en el reloj: decide el servidor (mismo cuidado que en el robot)."""
    if device(request) != "reloj":
        return _deny()
    b = await request.json()
    food = str(b.get("food"))
    if food not in care.FOOD:
        return JSONResponse({"error": "comida desconocida"}, status_code=400)
    r = await asyncio.to_thread(care.feed, food, {"state": b.get("state") or "ST_AWAKE",
                                                   "simple_mood": b.get("mood") or "SM_CALM"})
    comio_en_paseo()
    return {k: r[k] for k in ("accepted", "why", "comment", "got_sick")} | {"care": r["state"]}


@router.get("/v1/reloj/comidas")
def reloj_comidas(request: Request):
    if not device(request):
        return _deny()
    return {"foods": [{"id": f["id"], "emoji": f["emoji"], "name": f["name"]} for f in care.FOOD.values()]}


@router.get("/v1/reloj/ordenes")
def reloj_ordenes(request: Request):
    """La tabla local del reloj (9): solo frases completas; lo demás va a Haiku."""
    if not device(request):
        return _deny()
    return {"actions": rules.ACTION_PHRASES, "praise": rules.PRAISE_PHRASES, "scold": rules.SCOLD_PHRASES,
            "fillers": rules.FILLERS}


@router.post("/v1/reloj/voz")
async def reloj_voz(request: Request):
    """Texto que reconoció el reloj y no está en la tabla local: reglas completas y luego Haiku (9)."""
    if device(request) != "reloj":
        return _deny()
    text = str((await request.json()).get("texto") or "")[:300]
    norm = rules.normalize(text)
    hit = rules.match(norm) if norm else None
    if hit:
        r = {**hit, "source": "rule"}
    elif not settings.get("anthropic_key"):
        r = {"intent": "none", "action_id": None, "source": "rule"}
    else:
        try:
            r = {**(await asyncio.to_thread(haiku.decide_intent, text)), "source": "haiku"}
        except Exception as e:
            return {"error": f"haiku: {type(e).__name__}"}
    if r.get("action_id") and arb().where()["cuerpo"] == body.ROBOT:
        from . import web
        r["robot"] = await web.hub.send({"t": "command", "action_id": r["action_id"]})
    return r | {"texto": text}


# ---------- celular (APK) ----------
@router.post("/v1/vincular")
async def vincular(request: Request):
    """La APK manda el código que generó el dueño en la app; recibe las llaves del celular y del reloj."""
    b = await request.json()
    toks = pair(str(b.get("code") or ""), solo=b.get("solo"))
    if not toks:
        return JSONResponse({"error": "código inválido o vencido"}, status_code=403)
    return toks


@router.post("/v1/celular/hello")
async def celular_hello(request: Request):
    if device(request) != "celular":
        return _deny()
    return {"where": where(), "robot": _robot_window(), "server_time": time.time(),
            "apk": apk_version()}


def apk_path() -> str:
    return os.path.join(settings.data_dir(), "apk", "alma-celular.apk")


def apk_version() -> dict | None:
    p = os.path.join(settings.data_dir(), "apk", "version.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ---------- app del dueño (PWA) ----------
def _logged(request: Request) -> bool:
    from . import web
    return web._logged(request)


@router.get("/app/reloj")
def app_reloj(request: Request):
    if not _logged(request):
        return JSONResponse({"error": "login"}, status_code=401)
    devs = sorted((settings.load().get("devices") or {}).keys())
    log = [e for e in arb().s["log"] if e["kind"] in ("completa", "forzada", "cancelada", "rechazada")][-10:]
    return {"where": where(), "devices": devs, "log": log, "apk": apk_version()}


@router.post("/app/reloj/vincular")
def app_reloj_vincular(request: Request):
    if not _logged(request):
        return JSONResponse({"error": "login"}, status_code=401)
    return {"code": new_pair_code(), "valid_s": PAIR_S}


@router.post("/app/reloj/desvincular")
def app_reloj_desvincular(request: Request):
    if not _logged(request):
        return JSONResponse({"error": "login"}, status_code=401)
    settings.update(devices={})
    return {"ok": True}


@router.post("/app/mudanza")
async def app_mudanza(request: Request):
    if not _logged(request):
        return JSONResponse({"error": "login"}, status_code=401)
    b = await request.json()
    return await _move(str(b.get("mid") or secrets.token_hex(8)), str(b.get("to")), str(b.get("reason") or "manual"))


@router.get("/app/apk")
def app_apk(request: Request):
    if not _logged(request):
        return JSONResponse({"error": "login"}, status_code=401)
    if not os.path.exists(apk_path()):
        return JSONResponse({"error": "todavía no hay APK publicada"}, status_code=404)
    return FileResponse(apk_path(), media_type="application/vnd.android.package-archive",
                        filename="alma-celular.apk")
