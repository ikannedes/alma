"""Configuración guardada en el servidor (no en el código ni en variables que yo vea).

data/settings.json con permisos 0600: la contraseña del dueño (scrypt), las llaves de Claude y Groq que el dueño pega
desde la app, la llave simétrica del enlace con el robot, el token del dispositivo, las llaves VAPID de Web Push y las
suscripciones de notificaciones. La API nunca devuelve una llave: solo si está configurada.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading

_lock = threading.Lock()
SECRET_FIELDS = ("anthropic_key", "groq_key", "link_key", "device_token", "calendar_ics", "ps_token")


def data_dir() -> str:
    d = os.environ.get("ALMA_RELAY_DATA", "data")
    os.makedirs(d, exist_ok=True)
    return d


def _path() -> str:
    return os.path.join(data_dir(), "settings.json")


def load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save(s: dict) -> None:
    p = _path()
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=1)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)


def get(key: str, default=None):
    """Llave guardada; para Claude y Groq, la variable de entorno sigue valiendo si no se guardó ninguna."""
    v = load().get(key)
    if v:
        return v
    env = {"anthropic_key": "ANTHROPIC_API_KEY", "groq_key": "GROQ_API_KEY", "device_token": "ALMA_DEVICE_TOKEN"}.get(key)
    return os.environ.get(env, default) if env else default


def update(**kw) -> None:
    with _lock:
        s = load()
        for k, v in kw.items():
            if v is None:
                s.pop(k, None)
            else:
                s[k] = v
        save(s)


def public_view() -> dict:
    """Lo que la app puede ver: qué está configurado, nunca el valor."""
    s = load()
    return {k: bool(get(k)) for k in SECRET_FIELDS} | {"password_set": bool(s.get("password"))}


# ---- contraseña del dueño ----

def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return base64.b64encode(salt + h).decode()


def check_password(pw: str) -> bool:
    stored = load().get("password")
    if not stored:
        return False
    raw = base64.b64decode(stored)
    salt, h = raw[:16], raw[16:]
    return hmac.compare_digest(hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32), h)


def setup_code() -> str | None:
    """Código de instalación de un solo uso: se genera al primer arranque sin contraseña y se muestra solo en la
    consola del servidor (y en data/setup_code.txt). Sin él nadie puede crear la contraseña desde internet."""
    if load().get("password"):
        return None
    p = os.path.join(data_dir(), "setup_code.txt")
    try:
        with open(p, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        code = secrets.token_urlsafe(9)
        with open(p, "w", encoding="utf-8") as f:
            f.write(code)
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
        print(f"[alma-relay] código de instalación (un solo uso): {code}", flush=True)
        return code


def consume_setup_code() -> None:
    try:
        os.remove(os.path.join(data_dir(), "setup_code.txt"))
    except FileNotFoundError:
        pass
