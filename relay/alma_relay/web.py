"""App del dueño (instalable, Web Push) y enlace del robot por WebSocket (2026-10-30).

El servidor está en internet: todo lo de /app pide sesión (contraseña del dueño); la contraseña se crea con un código
de instalación de un solo uso que solo aparece en la consola del servidor. El robot entra por /v1/robot con la llave
simétrica (link.py), sin TLS.
"""

import asyncio
import collections
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import time

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response

from . import alarms, bgammon_alma, calendar_ics, care, haiku, history, link, night, notify, play, playstrategy, repertorio, settings, vision, voice
from . import album, fiestas, mem_backup, milestones, robot_debug, tricks

router = APIRouter()
WEB = os.path.join(os.path.dirname(__file__), "web")
SESSION_S = 30 * 86400
LOGIN_FAILS, LOGIN_WINDOW_S = 5, 600

_fails: dict[str, collections.deque] = {}


class Hub:
    """El robot conectado (uno) y lo último que mandó."""

    def __init__(self):
        self.ws: WebSocket | None = None
        self.sess: link.Session | None = None
        self.robot_id = ""
        self.state: dict = {}
        self.last_seen = 0.0
        self.events: collections.deque = collections.deque(maxlen=100)
        self.clip = voice.Clip()
        self.photo = vision.Photo()
        self.backup = mem_backup.Chunks()
        self.pending: dict[int, asyncio.Future] = {}   # respuestas del robot por "req" (comida)
        self.unsent_play = 0   # segundos jugados con el robot desconectado: se mandan al reconectar
        self.trick_ok: tuple[str, float] | None = None   # el último truco bien hecho y cuándo (caricia = 👍)
        self.ota_ready: asyncio.Future | None = None   # firmware por Wi-Fi: espera el "ota_ready" del robot
        self.fiesta: str | None = None   # la fiesta que ya se le mandó en esta conexión (fiestas.py)
        self.fiesta_at = 0.0
        self.req = 0
        self.lock = asyncio.Lock()

    async def send(self, obj: dict) -> bool:
        if not self.ws or not self.sess:
            return False
        async with self.lock:
            await self.ws.send_bytes(self.sess.seal(obj))
        return True


hub = Hub()


# ---- sesión del dueño ----

# Las sesiones se guardan en settings.json (solo el SHA-256 de la cookie) para que un reinicio no cierre la sesión.
def _sid(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _live_sessions() -> dict[str, float]:
    now = time.time()
    return {k: v for k, v in settings.load().get("sessions", {}).items() if v > now}


def _logged(request: Request) -> bool:
    t = request.cookies.get("alma_session")
    return bool(t) and settings.load().get("sessions", {}).get(_sid(t), 0) > time.time()


def _start_session(resp: JSONResponse, request: Request) -> JSONResponse:
    t = secrets.token_urlsafe(32)
    settings.update(sessions=_live_sessions() | {_sid(t): time.time() + SESSION_S})
    resp.set_cookie("alma_session", t, max_age=SESSION_S, httponly=True, samesite="strict",
                    secure=request.url.scheme == "https")
    return resp


def _need_login():
    return JSONResponse({"error": "login"}, status_code=401)


def _too_many(ip: str) -> bool:
    q = _fails.setdefault(ip, collections.deque())
    while q and time.time() - q[0] > LOGIN_WINDOW_S:
        q.popleft()
    return len(q) >= LOGIN_FAILS


@router.get("/")
def index():
    return FileResponse(os.path.join(WEB, "index.html"), headers={"Cache-Control": "no-cache"})


@router.get("/manifest.webmanifest")
def manifest():
    return FileResponse(os.path.join(WEB, "manifest.webmanifest"), media_type="application/manifest+json")


@router.get("/sw.js")
def service_worker():
    return FileResponse(os.path.join(WEB, "sw.js"), media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@router.get("/icon.svg")
def icon():
    return FileResponse(os.path.join(WEB, "icon.svg"), media_type="image/svg+xml")


@router.get("/app/status")
def status(request: Request):
    settings.setup_code()   # el primer arranque lo genera y lo muestra en la consola
    return {"setup_needed": not settings.load().get("password"), "logged_in": _logged(request)}


@router.post("/app/setup")
async def setup(request: Request):
    body = await request.json()
    code = settings.setup_code()
    ip = request.client.host if request.client else "?"
    if not code or _too_many(ip):
        return JSONResponse({"error": "no disponible"}, status_code=403)
    pw = body.get("password") or ""
    if not secrets.compare_digest(str(body.get("code", "")), code):
        _fails.setdefault(ip, collections.deque()).append(time.time())
        return JSONResponse({"error": "código incorrecto"}, status_code=403)
    if len(pw) < 8:
        return JSONResponse({"error": "la contraseña necesita al menos 8 caracteres"}, status_code=400)
    settings.update(password=settings.hash_password(pw))
    settings.consume_setup_code()
    return _start_session(JSONResponse({"ok": True}), request)


@router.post("/app/login")
async def login(request: Request):
    ip = request.client.host if request.client else "?"
    if _too_many(ip):
        return JSONResponse({"error": "demasiados intentos; espera 10 minutos"}, status_code=429)
    body = await request.json()
    if not settings.check_password(str(body.get("password", ""))):
        _fails.setdefault(ip, collections.deque()).append(time.time())
        return JSONResponse({"error": "contraseña incorrecta"}, status_code=403)
    return _start_session(JSONResponse({"ok": True}), request)


@router.post("/app/logout")
def logout(request: Request):
    s = _live_sessions()
    s.pop(_sid(request.cookies.get("alma_session", "")), None)
    settings.update(sessions=s)
    return {"ok": True}


@router.get("/app/state")
def app_state(request: Request):
    if not _logged(request):
        return _need_login()
    online = hub.ws is not None and time.time() - hub.last_seen < 30
    return {"online": online, "seconds_since": int(time.time() - hub.last_seen) if hub.last_seen else None,
            "state": hub.state, "events": list(hub.events)[-20:], "journal": history.journal(3)}


@router.post("/app/command")
async def app_command(request: Request):
    if not _logged(request):
        return _need_login()
    action = (await request.json()).get("action_id")
    if not isinstance(action, str):
        return JSONResponse({"error": "action_id"}, status_code=400)
    if not await hub.send({"t": "command", "action_id": action}):
        return JSONResponse({"error": "Alma no está conectada"}, status_code=409)
    return {"ok": True}


@router.get("/app/settings")
def get_settings(request: Request):
    if not _logged(request):
        return _need_login()
    return settings.public_view() | {"vapid_public": notify.vapid_keys()[1]}


@router.post("/app/settings")
async def post_settings(request: Request):
    """El dueño pega aquí sus llaves; se guardan en el servidor y no se devuelven nunca."""
    if not _logged(request):
        return _need_login()
    body = await request.json()
    upd = {}
    for k in ("anthropic_key", "groq_key", "device_token"):
        v = body.get(k)
        if isinstance(v, str) and v.strip():
            upd[k] = v.strip()
    lk = body.get("link_key")
    if isinstance(lk, str) and lk.strip():
        try:
            if len(bytes.fromhex(lk.strip())) != 32:
                raise ValueError
        except ValueError:
            return JSONResponse({"error": "la llave del enlace son 64 caracteres hexadecimales"}, status_code=400)
        upd["link_key"] = lk.strip().lower()
    ics = body.get("calendar_ics")
    if isinstance(ics, str) and ics.strip():
        u = ics.strip()
        if u.startswith("webcal://"):
            u = "https://" + u[len("webcal://"):]
        if not u.startswith("https://"):
            return JSONResponse({"error": "la dirección del calendario empieza con https:// (dirección secreta en formato iCal)"},
                                status_code=400)
        upd["calendar_ics"] = u
        _cal["fetched"] = 0   # leerla ya
    lm = body.get("calendar_lead_min")
    if isinstance(lm, int) and 0 <= lm <= 240:
        upd["calendar_lead_min"] = lm
    pst = body.get("ps_token")
    if isinstance(pst, str) and pst.strip():
        upd["ps_token"] = pst.strip()
    pso = body.get("ps_owner")
    if isinstance(pso, str) and pso.strip():
        if not re.fullmatch(r"[A-Za-z0-9_-]{2,30}", pso.strip()):
            return JSONResponse({"error": "tu usuario de PlayStrategy: letras, números, - o _"}, status_code=400)
        upd["ps_owner"] = pso.strip()
    pb = body.get("play_budget_tokens")   # tope diario de Haiku para jugar (PLAN-JUEGOS)
    if pb is not None:
        if not isinstance(pb, int) or isinstance(pb, bool) or not 20_000 <= pb <= 5_000_000:
            return JSONResponse({"error": "el tope de juegos va de 20 000 a 5 000 000 tokens al día"}, status_code=400)
        upd["play_budget_tokens"] = pb
    if body.get("calendar_off") is True:
        upd["calendar_ics"] = ""
        _cal.update(events=[], error=None)
    if upd:
        settings.update(**upd)
        haiku.reset_client()
        if "ps_token" in upd:
            playstrategy.restart()
    return settings.public_view()


# ---- PlayStrategy (playstrategy.py; dueño, 2026-10-31) ----

@router.get("/app/auth")
def auth(request: Request):
    """Para Caddy (forward_auth): el tablero de backgammon (/bg/*) solo se abre con la sesión del dueño."""
    return {"ok": True} if _logged(request) else _need_login()


@router.get("/app/bg")
def bg_status(request: Request):
    if not _logged(request):
        return _need_login()
    return bgammon_alma.status()


@router.get("/app/playstrategy")
def ps_status(request: Request):
    if not _logged(request):
        return _need_login()
    return playstrategy.status()


@router.post("/app/playstrategy/upgrade")
async def ps_upgrade(request: Request):
    """El dueño lo confirma en la app: convertir la cuenta de Alma en bot no se puede deshacer."""
    if not _logged(request):
        return _need_login()
    if (await request.json()).get("confirm") is not True:
        return JSONResponse({"error": "falta confirmar"}, status_code=400)
    ok, msg = await playstrategy.upgrade()
    return {"ok": True} if ok else JSONResponse({"error": msg}, status_code=400)


# ---- alarmas (alarms.py; dueño, 2026-10-30) ----


@router.get("/app/alarms")
def alarms_list(request: Request):
    if not _logged(request):
        return _need_login()
    now = dt.datetime.now(dt.timezone.utc)
    return {"timezone": str(alarms.tz()), "now": now.astimezone(alarms.tz()).strftime("%H:%M"),
            "alarms": [a | {"next": alarms.next_ring(a, now)} for a in sorted(alarms.load(), key=lambda a: a["time"])]}


@router.post("/app/alarms")
async def alarms_add(request: Request):
    if not _logged(request):
        return _need_login()
    f = alarms.clean(await request.json())
    if isinstance(f, str):
        return JSONResponse({"error": f}, status_code=400)
    a = alarms.add(f)
    return a if a else JSONResponse({"error": f"máximo {alarms.MAX_ALARMS} alarmas"}, status_code=400)


@router.post("/app/alarms/{alarm_id}")
async def alarms_edit(alarm_id: str, request: Request):
    if not _logged(request):
        return _need_login()
    body = await request.json()
    fields = {}
    if "time" in body or "days" in body or "label" in body:
        cur = next((a for a in alarms.load() if a["id"] == alarm_id), None)
        f = alarms.clean((cur or {}) | body)
        if isinstance(f, str):
            return JSONResponse({"error": f}, status_code=400)
        fields |= f
    if isinstance(body.get("enabled"), bool):
        fields["enabled"] = body["enabled"]
    a = alarms.update(alarm_id, fields)
    return a if a else JSONResponse({"error": "no existe"}, status_code=404)


@router.delete("/app/alarms/{alarm_id}")
def alarms_delete(alarm_id: str, request: Request):
    if not _logged(request):
        return _need_login()
    return {"ok": alarms.delete(alarm_id)}


@router.post("/app/alarm-test")
async def alarms_test(request: Request):
    if not _logged(request):
        return _need_login()
    return await _ring("Prueba de alarma", dt.datetime.now(dt.timezone.utc).astimezone(alarms.tz()).strftime("%H:%M"))


async def _ring(label: str, at: str, minutes: int = 0) -> dict:
    """Alarma (minutes = 0) o aviso del calendario (minutes antes del evento): al celular y al robot."""
    label = label or "Alarma"
    if minutes > 0:
        pushed = notify.push("reminder", f"📅 En {minutes} min: {label}", f"A las {at}. Alma te lo recuerda.")
    else:
        pushed = notify.push("reminder", f"⏰ {label}", f"Son las {at}. Alma te avisa.")
    hub.events.append({"ev": "reminder", "title": label, "minutes": minutes, "at": int(time.time())})
    robot = await hub.send({"t": "reminder", "title": label[:80], "minutes": minutes, "at": at})
    return {"pushed": pushed, "robot": robot}


# ---- tamagotchi (dueño, 2026-10-30): comida real desde la app. Desde el plan v2 (2026-10-31) decide el servidor
# (care.py) si el robot tiene el firmware que lo entiende; si no, decide el robot como antes ----

FOODS = [(f["id"], f["emoji"], f["name"]) for f in care.FOOD.values()]
WHY = {"enferma": "🤒 Está enferma: no tiene ganas", "de_mala_gana": "😕 Se lo comió de mala gana",
       "medicina_alivia": "😣 Se tomó la medicina: en unas horas se siente mejor",
       "le_encanta": "😋 ¡Le encantó!", "ok": "😊 Se lo comió", "llena": "🙅 Está llena", "no_le_gusta": "😖 No le gusta",
       "otra_vez_lo_mismo": "😒 Otra vez lo mismo, no", "berrinche": "😤 Hizo berrinche", "no_esta_enferma": "🤨 No está enferma",
       "medicina": "😣 Se tomó la medicina, de mala gana", "ocupada": "⏳ Está ocupada, intenta en un momento"}


@router.get("/app/foods")
def foods(request: Request):
    if not _logged(request):
        return _need_login()
    return {"foods": [{"id": f["id"], "emoji": f["emoji"], "name": f["name"], "kind": care.KIND_TAG[f["kind"]]}
                      for f in care.FOOD.values()]}


@router.get("/app/care")
def care_view(request: Request):
    if not _logged(request):
        return _need_login()
    return {"enabled": care.enabled(hub.state), **care.snapshot()}


async def _feed_server(food: str) -> dict | JSONResponse:
    """Plan v2: decide el servidor (reglas + Haiku); el robot solo actúa el resultado."""
    if not hub.ws:
        return JSONResponse({"error": "Alma no está conectada: ahorita no puede comer"}, status_code=409)
    r = await asyncio.to_thread(care.feed, food, dict(hub.state))
    await hub.send(care.robot_feed_msg(r))
    f = care.FOOD[food]
    text = WHY.get(r["why"], "")
    if r["got_sick"]:
        text += " … y se empachó 🤢 (dale medicina)"
    hub.events.append({"ev": "feed", "food": f["name"], "emoji": f["emoji"], "accepted": r["accepted"], "why": r["why"],
                       "at": int(time.time())})
    s = r["state"]
    return {"accepted": r["accepted"], "why": r["why"], "text": text, "comment": r["comment"], "hunger": s["hunger"],
            "sick": s["sick"], "food": f["name"], "emoji": f["emoji"], "care": s}


async def _care_state(msg: dict) -> None:
    out = await asyncio.to_thread(care.on_robot_state, msg)
    if not out:
        return
    if out.pop("got_sick", False):
        what = out.pop("what", "") or "algo"
        if out.get("cause") == "resfriado":
            notify.push("sick", "Alma amaneció enferma 🤧", f"Tiene {what}. Le durará unos días; la medicina la alivia.")
        else:
            body = {"empacho": "Comió muchas golosinas.", "debil": "Pasó demasiada hambre."}.get(out.get("cause"), "")
            notify.push("sick", "Alma se enfermó 🤒", body + " Dale medicina desde la app.")
    await hub.send(out)


@router.post("/app/feed")
async def feed(request: Request):
    if not _logged(request):
        return _need_login()
    food = (await request.json()).get("food")
    names = {i: (e, n) for i, e, n in FOODS}
    if food not in names:
        return JSONResponse({"error": "comida desconocida"}, status_code=400)
    if care.enabled(hub.state):
        return await _feed_server(food)
    hub.req += 1
    req = hub.req
    fut = asyncio.get_running_loop().create_future()
    hub.pending[req] = fut
    if not await hub.send({"t": "feed", "food": food, "req": req}):
        hub.pending.pop(req, None)
        return JSONResponse({"error": "Alma no está conectada: ahorita no puede comer"}, status_code=409)
    try:
        r = await asyncio.wait_for(fut, timeout=5)
    except asyncio.TimeoutError:
        hub.pending.pop(req, None)
        return JSONResponse({"error": "Alma no contestó"}, status_code=504)
    if r.get("error"):
        return JSONResponse({"error": r["error"]}, status_code=400)
    e, n = names[food]
    text = WHY.get(r.get("why"), "")
    if r.get("got_sick"):
        text += " … y se empachó 🤢 (dale medicina)"
    hub.events.append({"ev": "feed", "food": n, "emoji": e, "accepted": r.get("accepted"), "why": r.get("why"),
                       "at": int(time.time())})
    return {"accepted": bool(r.get("accepted")), "why": r.get("why"), "text": text, "hunger": r.get("hunger"),
            "sick": bool(r.get("sick")), "food": n, "emoji": e}


# ---- calendario de Google (calendar_ics.py), además de las alarmas ----

_cal: dict = {"fetched": 0.0, "events": [], "tz": "UTC", "error": None}


@router.get("/app/calendar")
def calendar_view(request: Request):
    if not _logged(request):
        return _need_login()
    now = dt.datetime.now(dt.timezone.utc)
    nxt = [{"title": e["title"], "at": calendar_ics.local_hhmm(e["start"], _cal["tz"]),
            "in_min": int((e["start"] - now).total_seconds() // 60)} for e in _cal["events"] if e["start"] > now][:5]
    return {"configured": bool(settings.get("calendar_ics")), "lead_min": calendar_ics.lead_min(), "next": nxt,
            "error": _cal["error"], "timezone": _cal["tz"]}


async def _calendar_tick(now: dt.datetime) -> list[dict]:
    url = settings.get("calendar_ics")
    if not url:
        return []
    if time.time() - _cal["fetched"] > calendar_ics.FETCH_EVERY_S:
        _cal["fetched"] = time.time()
        try:
            import httpx
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
                r = await c.get(url)
                r.raise_for_status()
            events, tz = await asyncio.to_thread(calendar_ics.parse, r.content, now - dt.timedelta(hours=1),
                                                 now + dt.timedelta(days=2))
            _cal.update(events=events, tz=tz, error=None)
        except Exception as e:   # la URL es secreta: no va al registro ni a la app
            _cal["error"] = f"no pude leer el calendario ({type(e).__name__})"
    sent = calendar_ics.due(_cal["events"], now, calendar_ics.lead_min(), set(calendar_ics.load_sent()))
    for r in sent:
        await _ring(r["title"], calendar_ics.local_hhmm(r["start"], _cal["tz"]), max(1, r["minutes"]))
    if sent:
        calendar_ics.mark_sent([r["key"] for r in sent])
    return sent


async def _alarms_tick(now: dt.datetime) -> list[dict]:
    rang = alarms.due(now)
    for a in rang:
        await _ring(a["label"], a["time"])
    return rang


async def _alarms_loop():
    while True:
        for tick in (_alarms_tick, _calendar_tick, _album_tick, _tricks_tick, _fiestas_tick):
            try:
                await tick(dt.datetime.now(dt.timezone.utc))
            except Exception as e:
                print(f"[alma-relay] {tick.__name__}: {type(e).__name__}", flush=True)
        await asyncio.sleep(20)


def start_background() -> None:
    """Lo llama el arranque del servidor (app.py, lifespan)."""
    asyncio.get_running_loop().create_task(_alarms_loop())
    asyncio.get_running_loop().create_task(_reloj_loop())
    playstrategy.start()
    bgammon_alma.start()
    from . import web_play
    web_play.start_background()


async def _reloj_loop():
    """Árbitro de cuerpo (reloj.py): caducidades, mudanza por desconexión del robot (6.4)."""
    from . import reloj
    while True:
        await asyncio.sleep(10)
        try:
            if await reloj.tick():
                await hub.send({"t": "body_poke"})
        except Exception as e:
            print(f"[alma-relay] reloj: {type(e).__name__}: {e}", flush=True)


@router.post("/app/push/subscribe")
async def push_subscribe(request: Request):
    if not _logged(request):
        return _need_login()
    sub = await request.json()
    if not isinstance(sub, dict) or not sub.get("endpoint"):
        return JSONResponse({"error": "suscripción inválida"}, status_code=400)
    notify.subscribe(sub)
    return {"ok": True}


@router.post("/app/push/check")
async def push_check(request: Request):
    if not _logged(request):
        return _need_login()
    return {"subscribed": notify.is_subscribed(str((await request.json()).get("endpoint", "")))}


@router.post("/app/push/unsubscribe")
async def push_unsubscribe(request: Request):
    if not _logged(request):
        return _need_login()
    notify.unsubscribe(str((await request.json()).get("endpoint", "")))
    return {"ok": True}


@router.get("/app/milestones")
def milestones_view(request: Request):
    """Los hitos de Alma: cumpleaños y lo que aprendió."""
    if not _logged(request):
        return _need_login()
    return milestones.listing()


@router.get("/app/notifications")
def notifications(request: Request):
    """Todos los avisos que se mandaron al teléfono, el más nuevo primero."""
    if not _logged(request):
        return _need_login()
    return {"notifications": notify.history()}


@router.post("/app/push/test")
def push_test(request: Request):
    if not _logged(request):
        return _need_login()
    notify._last.pop("test", None)
    return {"sent": notify.push("test", "Alma", "Las notificaciones funcionan.")}


# ---- enlace del robot ----

@router.websocket("/v1/robot")
async def robot(ws: WebSocket):
    await ws.accept()
    key = settings.get("link_key")
    if not key:
        await ws.close(code=1011)
        return
    k = bytes.fromhex(key)
    ns, h = link.hello()
    await ws.send_bytes(h)
    try:
        frame = await asyncio.wait_for(ws.receive_bytes(), timeout=10)
        nr, robot_id = link.check_auth(k, ns, frame)
    except (link.LinkError, asyncio.TimeoutError, WebSocketDisconnect, KeyError):
        try:
            await ws.close(code=1008)
        except Exception:   # ya se había ido
            pass
        return
    hub.ws, hub.sess, hub.robot_id = ws, link.Session(link.session_key(k, ns, nr), i_am_server=True), robot_id
    hub.last_seen = time.time()
    global _watch
    if _watch is None or _watch.done():
        _watch = asyncio.create_task(_offline_watch())
    await hub.send(welcome_msg())
    cmds = asyncio.create_task(_cmd_watch(ws))   # órdenes de depuración por Wi-Fi (robot_debug.py)
    hub.fiesta = None   # la fiesta de hoy se le vuelve a mandar (_fiestas_tick, en menos de 20 s)
    from . import reloj
    rpkg = reloj.RobotPkg()
    asyncio.create_task(_repertorio_send())   # sus trucos e inventos (repertorio.py), si su firmware los sabe
    if hub.unsent_play:   # lo que jugaste mientras estaba desconectada también cuenta
        add, hub.unsent_play = hub.unsent_play, 0
        await hub.send({"t": "remote_play", "add_s": min(add, 3600)})
    try:
        while True:
            msg = hub.sess.open(await ws.receive_bytes())
            hub.last_seen = time.time()
            t = msg.get("t")
            if t == "state":
                hub.state = msg
                if care.enabled(msg):
                    asyncio.create_task(_care_state(msg))
                asyncio.create_task(asyncio.to_thread(play.remember_robot, msg))
            elif t == "care_import":
                care.import_payload(msg)
            elif t in ("cara_ok", "cara_error"):
                await asyncio.to_thread(fiestas.on_result, msg)
            elif t == "log":
                await asyncio.to_thread(robot_debug.append, str(msg.get("s", "")))
            elif t in ("ota_ready", "ota_ok", "ota_error"):   # firmware por Wi-Fi (robot_debug.py)
                await asyncio.to_thread(robot_debug.append, f"servidor: robot → {t} {msg.get('why') or msg.get('sha256') or ''}")
                if t == "ota_ready" and hub.ota_ready and not hub.ota_ready.done():
                    hub.ota_ready.set_result(True)
            elif t == "event" and msg.get("ev") == "bateria":   # cada 5 min: a bateria.csv, no a los avisos
                await asyncio.to_thread(robot_debug.bateria, msg)
            elif t == "event" and msg.get("ev") in ("invento", "truco_res"):   # sus movimientos propios
                if msg.get("ev") == "invento":
                    await asyncio.to_thread(repertorio.on_invention, msg)
                else:
                    estado = await asyncio.to_thread(repertorio.on_result, msg)
                    hub.events.append({"ev": "truco_res", "res": msg.get("res"), "estado": estado, "at": int(time.time())})
            elif t == "event":
                hub.events.append(msg | {"at": int(time.time())})
                if msg.get("ev") == "pet":
                    _pet_after_trick()
            elif t == "night":
                asyncio.create_task(_night(msg))
            elif t in ("feed_result", "trick_result"):
                fut = hub.pending.pop(msg.get("req"), None)
                if fut and not fut.done():
                    fut.set_result(msg)
            elif t == "voice" and hub.clip.add(msg):
                clip, hub.clip = hub.clip, voice.Clip()
                asyncio.create_task(_voice(clip))
            elif t == "mem_backup" and hub.backup.add(msg):
                b, hub.backup = hub.backup, mem_backup.Chunks()
                r = await asyncio.to_thread(mem_backup.save, b)
                print(f"[alma-relay] respaldo de memoria: {r}", flush=True)
            elif t == "mem_restore_req":   # arrancó con la memoria vacía: la última copia
                for m in await asyncio.to_thread(mem_backup.restore_msgs):
                    await hub.send(m)
                hub.events.append({"ev": "mem_restore_sent", "at": int(time.time())})
            elif isinstance(t, str) and t.startswith("body_"):   # mudanza entre cuerpos (reloj.py)
                for m in await reloj.on_robot(msg, rpkg):
                    await hub.send(m)
                continue
            elif t == "photo" and hub.photo.add(msg):
                photo, hub.photo = hub.photo, vision.Photo()
                asyncio.create_task(_vision(photo))
            notify.on_robot_message(msg)
            if t in ("state", "event"):
                await asyncio.to_thread(milestones.on_robot_message, msg)
    except (link.LinkError, WebSocketDisconnect, KeyError, ValueError):
        pass
    finally:
        cmds.cancel()
        if hub.ws is ws:
            hub.ws = hub.sess = None
        try:
            await ws.close()
        except Exception:
            pass


async def _cmd_watch(ws: WebSocket):
    """Cada medio segundo, las órdenes que dejé en robot_cmd.txt (robot_debug.py) van al robot."""
    while hub.ws is ws:
        for m in await asyncio.to_thread(robot_debug.take_cmds):
            if m["t"] == "_ota":
                asyncio.create_task(_ota_send(m))
            elif m["t"] == "_subir":
                asyncio.create_task(_subir_send(m))
            else:
                await hub.send(m)
        await asyncio.sleep(0.5)


async def _subir_send(m: dict):
    """Un archivo de caras/ al robot ("subir" en robot_cmd.txt); el robot contesta cara_ok o cara_error."""
    with open(m["file"], "rb") as f:
        data = f.read()
    chunks = fiestas.trozos(data, m["nombre"], m["ext"])
    for c in chunks:
        if not await hub.send(c):
            await asyncio.to_thread(robot_debug.append, f"servidor: subir: se cortó el enlace en el trozo {c['seq']}")
            return
        await asyncio.sleep(OTA_PAUSE_S)
    await asyncio.to_thread(robot_debug.append, f"servidor: subir: {m['nombre']}.{m['ext']} ({len(data)} bytes, {len(chunks)} trozos)")


OTA_PAUSE_S = 0.2    # entre trozos: que el robot escriba la flash antes del siguiente (hasta 0a2f190a, dos trozos juntos
                     # en su búfer cortaban el enlace: "frame demasiado grande", 2026-11-03)


async def _ota_send(m: dict):
    """Firmware nuevo por Wi-Fi: ota_begin, espera ota_ready (15 s) y manda los trozos en orden; el robot contesta ota_ok
    u ota_error (web.robot los anota en robot_log). El reinicio va aparte ("ota reboot"), con el dueño."""
    with open(m["file"], "rb") as f:
        data = f.read()
    hub.ota_ready = asyncio.get_running_loop().create_future()
    await asyncio.to_thread(robot_debug.append, f"servidor: ota: {m['name']} ({len(data)} bytes, {m['sha256'][:12]}…)")
    if not await hub.send({"t": "ota_begin", "size": len(data), "sha256": m["sha256"], "version": m["name"]}):
        return
    try:
        await asyncio.wait_for(hub.ota_ready, timeout=15)
    except asyncio.TimeoutError:
        await asyncio.to_thread(robot_debug.append, "servidor: ota: el robot no contestó ota_ready; no se manda nada")
        return
    chunks = robot_debug.ota_chunks(data)
    for c in chunks:
        if not await hub.send(c):
            await asyncio.to_thread(robot_debug.append, f"servidor: ota: se cortó el enlace en el trozo {c['seq']}")
            return
        await asyncio.sleep(OTA_PAUSE_S)
    await asyncio.to_thread(robot_debug.append, f"servidor: ota: {len(chunks)} trozos enviados")


def welcome_msg(now: float | None = None) -> dict:
    """time: UTC; local: segundos locales desde 1970 en la zona del dueño (el robot la usa si el SNTP no contestó)."""
    from . import alarms
    now = now if now is not None else time.time()
    off = dt.datetime.fromtimestamp(now, alarms.tz()).utcoffset() or dt.timedelta(0)
    return {"t": "welcome", "time": int(now), "local": int(now + off.total_seconds())}


async def _night(msg: dict):
    """Pase nocturno pedido por el robot: Haiku con los límites de 07, de vuelta por el mismo enlace."""
    summary = msg.get("summary") or {}
    try:   # juegos desde la app del día (07): Haiku los cuenta en el diario
        from . import games
        summary["remote_games"] = games.today_summary()
        if p := play.today_summary():
            summary["play"] = p
        if seen := vision.today_summary():
            summary["vio_de_cerca"] = seen
        if dueno := vision.owner_summary():   # las fotos que le tomó a su dueño: qué hacía
            summary["fotos_al_dueno"] = dueno
        if hitos := milestones.recent(time.time() - 24 * 3600):
            summary["hitos"] = hitos
        if fotos := album.today_summary():
            summary["fotos"] = fotos
        if trucos := tricks.today_summary():
            summary["trucos"] = trucos
        if propios := repertorio.today_summary():
            summary["movimientos_propios"] = propios
        from . import reloj
        if paseos := reloj.today_summary():
            summary["reloj"] = paseos
        from . import juegos_reloj
        if jr := juegos_reloj.today_summary():
            summary["juegos_reloj"] = jr
        if care.enabled(hub.state):
            if c := care.day_summary():
                summary["care"] = c
            ill = await asyncio.to_thread(care.nightly, dict(hub.state))   # ¿mañana amanece enferma? (Haiku)
            print(f"[alma-relay] salud de mañana: propensión {ill['risk']}, enferma {ill['sick']} ({ill['src']})", flush=True)
    except Exception:
        pass
    previous = (msg.get("previous") or history.previous(6))[-6:]   # el robot no guarda días: los pone el servidor
    if not settings.get("anthropic_key"):
        history.add(summary, None)
        await hub.send({"t": "night_result", "error": "falta la llave de Claude en la app"})
        return
    try:
        raw = await asyncio.to_thread(haiku.night_report, summary, previous, msg.get("assets") or [])
        result = night.apply_limits(raw, msg.get("assets") or [])
        history.add(summary, result)
        await hub.send({"t": "night_result"} | result)
        asyncio.create_task(_new_moves(summary))
    except Exception as e:
        history.add(summary, None)
        await hub.send({"t": "night_result", "error": f"{type(e).__name__}"})


async def _repertorio_send():
    """Al conectar: sus trucos (nuevos y aprendidos) e inventos, para que no los pierda al reiniciar."""
    await asyncio.sleep(5)   # que llegue su primer estado (rep_v)
    if not hub.ws or not hub.state.get("rep_v"):
        return
    for m in await asyncio.to_thread(repertorio.mensajes_robot):
        if not await hub.send(m):
            return


async def _new_moves(summary: dict):
    """Después del pase nocturno, Haiku propone 1–2 trucos nuevos (vía 3); como mucho 3 sin enseñar a la vez."""
    try:
        if await asyncio.to_thread(repertorio.pending_count) >= 3:
            return
        props = await asyncio.to_thread(haiku.propose_moves, summary, repertorio.today_summary())
        nuevos = await asyncio.to_thread(repertorio.add_tricks, props)
        print(f"[alma-relay] trucos nuevos de Haiku: {[t['nombre'] for t in nuevos]} ({len(props)} propuestos)", flush=True)
        if hub.ws and hub.state.get("rep_v"):
            for t in nuevos:
                await hub.send({"t": "truco", "id": t["id"], "nombre": t["nombre"], "estado": "nuevo", "cuadros": t["cuadros"]})
    except Exception as e:
        print(f"[alma-relay] trucos nuevos: {type(e).__name__}", flush=True)


async def _voice(clip: "voice.Clip"):
    """Lo que dijo el dueño tras "Hey EMO": Whisper y reglas o Haiku; vuelve por el enlace (07)."""
    r = await asyncio.to_thread(voice.understand, clip)
    hub.events.append({"ev": "voice", "transcript": r.get("transcript", ""), "action_id": r.get("action_id"),
                       "intent": r.get("intent"), "error": r.get("error"), "at": int(time.time())})
    await hub.send({"t": "voice_result"} | r)


async def _vision(photo: "vision.Photo"):
    """Algo a 10 cm o menos, o la foto que le tomó a su dueño: Haiku la mira y dice cómo reacciona Alma; vuelve por el
    enlace."""
    r = await asyncio.to_thread(vision.see, photo, dict(hub.state))
    hub.events.append({"ev": "seen", "kind": photo.kind, "objeto": r.get("objeto"), "reaccion": r.get("reaccion"),
                       "comentario": r.get("comentario"), "error": r.get("error"), "at": int(time.time())})
    await hub.send({"t": "seen"} | r)


@router.get("/app/memory")
def memory_backups(request: Request):
    """Las copias de la memoria de Alma que guarda el servidor."""
    if not _logged(request):
        return _need_login()
    return {"backups": mem_backup.listing()}


@router.get("/app/vision/last.jpg")
def vision_last(request: Request):
    """La última foto que vio de cerca (solo en memoria)."""
    if not _logged(request):
        return _need_login()
    v = vision.last()
    if not v.get("jpg"):
        return JSONResponse({"error": "todavía no ha visto nada"}, status_code=404)
    return Response(v["jpg"], media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ---- álbum (album.py; dueño, 2026-11-01): la app pide fotos, Alma reacciona con Haiku y se guardan ----

@router.get("/app/album")
def album_view(request: Request):
    if not _logged(request):
        return _need_login()
    return {"photos": album.listing(), "pedidos": album.pedidos()}


@router.post("/app/album")
async def album_upload(request: Request):
    """Una foto del teléfono (multipart: foto, y pedido si responde a lo que ella pidió)."""
    if not _logged(request):
        return _need_login()
    form = await request.form()
    f = form.get("foto")
    if f is None or not hasattr(f, "read"):
        return JSONResponse({"error": "falta la foto"}, status_code=400)
    data = await f.read(album.MAX_UPLOAD + 1)
    r = await asyncio.to_thread(album.upload, data, form.get("pedido") or None, dict(hub.state))
    if r.get("error"):
        return JSONResponse(r, status_code=400)
    hub.events.append({"ev": "foto", "titulo": r["titulo"], "le_gusta": r["le_gusta"], "comentario": r["comentario"],
                       "at": int(time.time())})
    # el robot reacciona como al ver algo de cerca (con el firmware que acepta origen "app"; el de hoy lo ignora)
    await hub.send({"t": "seen", "origen": "app", "objeto": r["que_es"], "reaccion": r["reaccion"],
                    "conducta": r["conducta"], "comentario": r["comentario"]})
    return r


@router.post("/app/album/keep")
async def album_keep(request: Request):
    """Guarda en el álbum la última foto que tomó ella de cerca."""
    if not _logged(request):
        return _need_login()
    r = await asyncio.to_thread(album.keep_last_seen, dict(hub.state))
    return JSONResponse(r, status_code=400) if r.get("error") else r


@router.post("/app/album/pedido/{pid}/close")
def album_close(pid: str, request: Request):
    """"Ahora no": el pedido deja de aparecer."""
    if not _logged(request):
        return _need_login()
    album.close(pid[:40])
    return {"ok": True}


@router.get("/app/album/{name}.jpg")
def album_photo(name: str, request: Request):
    if not _logged(request):
        return _need_login()
    thumb = name.endswith("_t")
    p = album.path(name[:-2] if thumb else name, thumb)
    if not p:
        return JSONResponse({"error": "no existe"}, status_code=404)
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/app/album/{pid}")
def album_delete(pid: str, request: Request):
    if not _logged(request):
        return _need_login()
    return {"ok": album.delete(pid)}


async def _album_tick(now: dt.datetime) -> list[str]:
    """Avisa al teléfono cuando Alma empieza a pedir una foto (fechas especiales y cumpleaños; de día)."""
    t = now.timestamp()
    if care.is_night(t):
        return []
    new = await asyncio.to_thread(album.to_notify, t)
    for p in new:
        notify.push("photo_ask", f"{p['emoji']} Alma te pide una foto", p["ask"], t)
    if new:
        album.mark_told([p["id"] for p in new])
    return [p["id"] for p in new]


# ---- trucos (tricks.py; dueño, 2026-11-01: "como aibo", sin tope, se olvidan sin práctica) ----
TRICK_WAIT_S = 8
TRICK_PET_S = 10
_tricks_last = 0.0


async def _tricks_tick(now: dt.datetime) -> list[str]:
    """Una vez por hora: los trucos que ya olvidó."""
    global _tricks_last
    t = now.timestamp()
    if t - _tricks_last < 3600:
        return []
    _tricks_last = t
    return await asyncio.to_thread(tricks.forget_due, t)


async def _fiestas_tick(now: dt.datetime) -> None:
    """La cara de la fiesta de hoy (fiestas.py): al conectar, al cambiar el día y, si aún no la tiene, cada hora."""
    if not hub.ws or not hub.state.get("fiesta_v"):   # un firmware que no sabe de caras no las recibe
        return
    t = now.timestamp()
    nombre = await asyncio.to_thread(fiestas.hoy, t)
    pending = nombre and nombre not in await asyncio.to_thread(fiestas.en_robot)
    if nombre != hub.fiesta or (pending and t - hub.fiesta_at >= 3600):
        for m in await asyncio.to_thread(fiestas.mensajes, nombre, t):
            if not await hub.send(m):
                return
        hub.fiesta, hub.fiesta_at = nombre, t
    # las demás caras, de noche y con ella dormida, una cada 15 min (fiestas.precarga)
    for m in await asyncio.to_thread(fiestas.precarga, hub.state.get("state") == "ST_SLEEPING", t):
        if not await hub.send(m):
            return


async def _robot_trick(mot: str) -> dict:
    """Le pide al robot el movimiento y espera a que diga si lo hizo."""
    if not hub.ws:
        return {"error": "Alma no está conectada"}
    hub.req += 1
    req = hub.req
    fut = asyncio.get_running_loop().create_future()
    hub.pending[req] = fut
    if not await hub.send({"t": "trick", "mot": mot, "req": req}):
        hub.pending.pop(req, None)
        return {"error": "Alma no está conectada"}
    try:
        r = await asyncio.wait_for(fut, timeout=TRICK_WAIT_S)
    except asyncio.TimeoutError:
        hub.pending.pop(req, None)
        return {"error": "Alma no respondió (le falta el firmware con trucos)"}
    return {} if r.get("done") else {"error": "no pudo hacerlo: " + str(r.get("why") or "está ocupada")}


@router.get("/app/tricks")
def tricks_view(request: Request):
    if not _logged(request):
        return _need_login()
    return tricks.listing()


async def _lesson_try() -> dict | JSONResponse:
    r = tricks.lesson_try(dict(hub.state))
    if r.get("error"):
        return JSONResponse(r, status_code=409)
    if err := await _robot_trick(r["mot"]):
        return JSONResponse(err, status_code=409)
    tricks.lesson_did(r["mot"])
    return {"tried": r["label"], **tricks.listing()}


@router.post("/app/tricks/lesson")
async def tricks_lesson(request: Request):
    """Abre una clase con un nombre y Alma hace su primer intento."""
    if not _logged(request):
        return _need_login()
    r = tricks.lesson_start((await request.json()).get("name", ""))
    if r.get("error"):
        return JSONResponse(r, status_code=400)
    return await _lesson_try()


@router.post("/app/tricks/try")
async def tricks_try(request: Request):
    if not _logged(request):
        return _need_login()
    return await _lesson_try()


@router.post("/app/tricks/answer")
async def tricks_answer(request: Request):
    """👍 "si", 👎 "no" o 🍬 "premio" (una galleta: puede no quererla, y de más la empachan)."""
    if not _logged(request):
        return _need_login()
    answer = (await request.json()).get("answer")
    if answer not in ("si", "no", "premio"):
        return JSONResponse({"error": "respuesta desconocida"}, status_code=400)
    treat, treat_ok = None, False
    if answer == "premio":
        if not care.enabled(hub.state):
            return JSONResponse({"error": "los premios necesitan la comida nueva del robot"}, status_code=409)
        treat = await _feed_server("galleta")
        if isinstance(treat, JSONResponse):
            return treat
        treat_ok = bool(treat.get("accepted"))
    r = tricks.lesson_answer(answer, dict(hub.state), treat_ok)
    if r.get("error"):
        return JSONResponse(r, status_code=409)
    out = r | {"treat": treat and {"accepted": treat_ok, "text": treat.get("text")}}
    if answer == "no" or not r.get("learned"):   # 👎: que pruebe otra cosa; 👍 sin aprenderlo aún: que lo intente otra vez
        nxt = await _lesson_try()
        out["next"] = nxt if isinstance(nxt, dict) else json.loads(nxt.body)
    return out


@router.post("/app/tricks/end")
def tricks_end(request: Request):
    if not _logged(request):
        return _need_login()
    tricks.lesson_end()
    return {"ok": True}


@router.post("/app/tricks/{name}/do")
async def tricks_do(name: str, request: Request):
    """Se lo pides: lo hace bien, se equivoca o no quiere."""
    if not _logged(request):
        return _need_login()
    r = tricks.perform(name, dict(hub.state))
    if r.get("error"):
        return JSONResponse(r, status_code=409)
    if r.get("mot") and (err := await _robot_trick(r["mot"])):
        return JSONResponse(err, status_code=409)
    hub.events.append({"ev": "trick", "name": name, "outcome": r["outcome"], "at": int(time.time())})
    hub.trick_ok = (name, time.time()) if r["outcome"] == "bien" else None
    return r


def _pet_after_trick() -> None:
    """Una caricia hasta TRICK_PET_S después de un truco bien hecho cuenta como 👍 (dueño, 2026-11-02)."""
    if hub.trick_ok and time.time() - hub.trick_ok[1] <= TRICK_PET_S:
        name, hub.trick_ok = hub.trick_ok[0], None
        if not tricks.praise(name).get("error"):
            hub.events.append({"ev": "trick_pet", "name": name, "at": int(time.time())})


@router.post("/app/tricks/{name}/praise")
def tricks_praise(name: str, request: Request):
    if not _logged(request):
        return _need_login()
    r = tricks.praise(name)
    return JSONResponse(r, status_code=404) if r.get("error") else r


@router.delete("/app/tricks/{name}")
def tricks_delete(name: str, request: Request):
    if not _logged(request):
        return _need_login()
    return {"ok": tricks.remove(name)}


OFFLINE_S = 600   # sin nada del robot en este tiempo: aviso al celular (dueño, 2026-10-30)
_watch: asyncio.Task | None = None


def _offline_check(warned: bool, now: float) -> bool:
    """Avisa una vez si Alma deja de hablar; vuelve a avisar solo después de que reaparezca. Devuelve warned."""
    quiet = now - hub.last_seen
    if not hub.last_seen or quiet < OFFLINE_S:
        return False
    if not warned:
        st = hub.state
        bat = f" Última batería: {st['battery_pct']:.0f} %." if isinstance(st.get("battery_pct"), (int, float)) else ""
        notify.push("offline", "Alma se desconectó", f"Lleva {int(quiet // 60)} min sin conectarse al servidor.{bat}", now)
    return True


async def _offline_watch():
    warned = False
    while True:
        await asyncio.sleep(60)
        warned = _offline_check(warned, time.time())
