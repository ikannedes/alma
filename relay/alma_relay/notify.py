"""Notificaciones Web Push al celular del dueño (app instalable) y las reglas que las disparan.

Las llaves VAPID se generan una vez en el servidor (data/settings.json). Las suscripciones las agrega la app.
"""

import base64
import json
import os
import threading
import time

from . import settings

# no repetir el mismo aviso antes de este tiempo (s)
COOLDOWN = {"home_failed": 1800, "battery_critical": 1800, "sad": 6 * 3600, "falls": 3600, "new_face": 0, "offline": 3600, "reminder": 0, "forgot_face": 0, "hungry": 3 * 3600, "sick": 3600, "game": 0, "milestone": 0, "photo_ask": 0, "trick_forgot": 0, "mudanza": 0}
_last: dict[str, float] = {}
sender = None   # las pruebas lo cambian por un doble
KEEP = 200      # historial de avisos (dueño, 2026-11-01: "por si no lo alcancé a leer y le di clic")
_lock = threading.Lock()


def _hist_path() -> str:
    return os.path.join(settings.data_dir(), "notifications.json")


def history() -> list[dict]:
    """Los avisos mandados, el más nuevo primero."""
    try:
        with open(_hist_path(), encoding="utf-8") as f:
            h = json.load(f)
        return list(reversed(h)) if isinstance(h, list) else []
    except (FileNotFoundError, ValueError):
        return []


def _remember(entry: dict) -> None:
    with _lock:
        h = list(reversed(history())) + [entry]
        tmp = _hist_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(h[-KEEP:], f, ensure_ascii=False)
        os.replace(tmp, _hist_path())


def vapid_keys() -> tuple[str, str]:
    """(privada en PEM, pública en base64url sin relleno), creadas la primera vez."""
    s = settings.load()
    if not s.get("vapid_private"):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        key = ec.generate_private_key(ec.SECP256R1())
        priv = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                 serialization.NoEncryption()).decode()
        pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        settings.update(vapid_private=priv, vapid_public=base64.urlsafe_b64encode(pub).rstrip(b"=").decode())
        s = settings.load()
    return s["vapid_private"], s["vapid_public"]


def subscribe(sub: dict) -> None:
    subs = [x for x in settings.load().get("subscriptions", []) if x.get("endpoint") != sub.get("endpoint")]
    subs.append(sub)
    settings.update(subscriptions=subs)


def is_subscribed(endpoint: str) -> bool:
    return any(x.get("endpoint") == endpoint for x in settings.load().get("subscriptions", []))


def unsubscribe(endpoint: str) -> None:
    settings.update(subscriptions=[x for x in settings.load().get("subscriptions", []) if x.get("endpoint") != endpoint])


def _send(sub: dict, payload: dict) -> bool:
    if sender:
        return sender(sub, payload)
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush
    priv, _ = vapid_keys()
    try:
        # la llave va como objeto: pywebpush lee un texto como DER en base64, no como PEM (2026-10-30)
        webpush(sub, json.dumps(payload), vapid_private_key=Vapid.from_pem(priv.encode()),
                vapid_claims={"sub": "mailto:alma@localhost"}, timeout=10)
        return True
    except WebPushException as e:
        if e.response is not None and e.response.status_code in (404, 410):   # suscripción vencida
            settings.update(subscriptions=[x for x in settings.load().get("subscriptions", [])
                                           if x.get("endpoint") != sub.get("endpoint")])
        print(f"[alma-relay] push falló: {str(e)[:200]}", flush=True)
        return False
    except Exception as e:   # red o llave: un aviso que falla no tumba la petición
        print(f"[alma-relay] push falló: {type(e).__name__}: {str(e)[:200]}", flush=True)
        return False


def push(kind: str, title: str, body: str, now: float | None = None, url: str | None = None) -> int:
    now = now if now is not None else time.time()
    if now - _last.get(kind, -1e12) < COOLDOWN.get(kind, 600):
        return 0
    _last[kind] = now
    n = 0
    for sub in settings.load().get("subscriptions", []):
        n += _send(sub, {"title": title, "body": body, "kind": kind} | ({"url": url} if url else {}))
    if kind != "test":   # se guarda aunque no haya llegado a ningún teléfono
        _remember({"at": int(now), "kind": kind, "title": title, "body": body, "sent": n} | ({"url": url} if url else {}))
    return n


def on_robot_message(msg: dict, now: float | None = None) -> list[str]:
    """Reglas (dueño, 2026-10-30). Devuelve los avisos mandados."""
    sent = []
    if msg.get("t") == "event":
        ev = msg.get("ev")
        if ev == "home_failed" and msg.get("battery_pct", 100) < 25:
            if push("home_failed", "Alma no encuentra su base", f"Batería {msg.get('battery_pct', 0):.0f} %. Ayúdala a llegar a la Home Station.", now):
                sent.append("home_failed")
        elif ev == "new_face":
            if push("new_face", "Alma conoció a alguien", f"Registró una cara nueva: {msg.get('name', '')}.", now):
                sent.append("new_face")
        elif ev == "hungry":
            from . import care
            if care.is_night(now if now is not None else time.time()):
                pass   # de noche duerme y nadie le da de comer (dueño, 2026-11-01): el hambre corre más lento
            elif push("hungry", "Alma tiene hambre 🍽️", "Abre la app y dale algo de comer.", now):
                sent.append("hungry")
        elif ev == "sick":
            if push("sick", "Alma se empachó 🤢", "Comió muchas golosinas. Dale medicina desde la app.", now):
                sent.append("sick")
        elif ev == "forgot_face":
            if push("forgot_face", "Alma olvidó a alguien 🍂", f"No veía a la persona {msg.get('person_id', '?')} desde hace 28 días.", now):
                sent.append("forgot_face")
        elif ev == "falls":
            if push("falls", "Alma tuvo varios sustos", "Varios bordes o caídas en poco tiempo. Revisa dónde está.", now):
                sent.append("falls")
    elif msg.get("t") == "state":
        if msg.get("battery_pct", 100) <= 10 and msg.get("power") == "battery":
            if push("battery_critical", "Batería crítica", f"Alma tiene {msg.get('battery_pct', 0):.0f} % y no está cargando.", now):
                sent.append("battery_critical")
        if msg.get("wellbeing", 0) < -400:
            if push("sad", "Alma está triste", "Lleva días sin pasarla bien. Un rato de juego le haría bien.", now):
                sent.append("sad")
    return sent
