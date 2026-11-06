"""Depuración del robot por Wi-Fi (dueño, 2026-11-02: "haz lo necesario para que le puedas mandar la orden por wifi").

Sin el USB no hay consola: el robot manda su registro como {"t":"log","s":...} (cuando se le pide) y aquí se guarda en
robot_log.txt; las órdenes se dejan en robot_cmd.txt, una por línea, y el ciclo de la conexión se las manda:
  key C        una tecla de prueba (las mismas que por el USB; el robot solo acepta su lista)
  log on|off   prender o apagar el registro remoto (se apaga solo al reiniciar el robot)
  ota <archivo.bin> <sha256>   firmware nuevo por Wi-Fi (data_dir/ota/; el robot lo verifica y NO reinicia solo)
  ota reboot   que arranque el firmware ya verificado (a prueba 3 min: si no vuelve al servidor, regresa al anterior)
  subir <nombre.avi|nombre.mp3>   un archivo de data_dir/caras/ al robot, a /test/ (p. ej. la cara y la marcha del truco
               de Darth Vader); el robot contesta cara_ok/cara_error
  patas on|off   en la base: on = las patas siguen con corriente (rígido), off = sin corriente, flojo (por omisión)
  usb on|off   con el cable USB: on = se mueve (pruebas), off = cuenta como base y se queda quieta (por omisión)
  bateria on|off   prueba de batería: sin siesta y a casa hasta el 15 % (se apaga sola al reiniciar el robot)
  media <cara> [sonido]   una cara de la SD con un sonido (sin extensión), para buscar nombres (canciones mudas)
La batería llega cada 5 min y se guarda en bateria.csv (bateria()).
Solo con acceso al servidor (SSH): no hay ruta HTTP.
"""

import base64
import hashlib
import os
import time

from . import settings

LOG_MAX = 5_000_000           # al pasar de esto, robot_log.txt pasa a robot_log.1.txt
KEYS = set("CHgiAWSDJTKUVx0?")   # las de prueba (app.c, app_console_key; 0 = PARO, T = gestos, K/U = sticker, V = revisar la SD); el robot vuelve a filtrar


def _path(name: str) -> str:
    return os.path.join(settings.data_dir(), name)


def append(s: str, now: float | None = None, name: str = "robot_log.txt") -> None:
    """Guarda un trozo del registro del robot (líneas con \\n), con la hora del servidor al frente de cada una."""
    if not s:
        return
    p = _path(name)
    try:
        if os.path.getsize(p) > LOG_MAX:
            os.replace(p, _path(name.replace(".txt", ".1.txt")))
    except FileNotFoundError:
        pass
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now if now is not None else time.time()))
    lines = [ln for ln in s.split("\n") if ln.strip()]
    with open(p, "a", encoding="utf-8") as f:
        f.writelines(f"{stamp} | {ln}\n" for ln in lines)


def take_cmds() -> list[dict]:
    """Lee y borra robot_cmd.txt; devuelve los mensajes para el robot (las líneas que no entiende, se ignoran)."""
    p = _path("robot_cmd.txt")
    try:
        with open(p, encoding="utf-8") as f:
            text = f.read()
        os.remove(p)
    except FileNotFoundError:
        return []
    out = []
    for ln in text.splitlines():
        parts = ln.strip().split(" ", 1)
        if parts[0] == "key" and len(parts) == 2 and len(parts[1]) == 1 and parts[1] in KEYS:
            out.append({"t": "key", "k": parts[1]})
        elif parts[0] == "log" and len(parts) == 2 and parts[1] in ("on", "off"):
            out.append({"t": "rlog", "on": parts[1] == "on"})
        elif parts[0] == "subir" and len(parts) == 2:
            m = subir_cmd(parts[1].strip())
            if m:
                out.append(m)
        elif parts[0] == "patas" and len(parts) == 2 and parts[1] in ("on", "off"):
            out.append({"t": "patas", "on": parts[1] == "on"})
        elif parts[0] == "usb" and len(parts) == 2 and parts[1] in ("on", "off"):
            out.append({"t": "usb_mueve", "on": parts[1] == "on"})
        elif parts[0] == "media" and len(parts) == 2 and _media_ok(parts[1].split()):
            nm = parts[1].split()
            out.append({"t": "prueba_media", "avi": nm[0], "mp3": nm[1] if len(nm) > 1 else ""})
        elif parts[0] == "bateria" and len(parts) == 2 and parts[1] in ("on", "off"):
            out.append({"t": "prueba_bateria", "on": parts[1] == "on"})
        elif parts[0] == "ota" and len(parts) == 2:
            m = ota_cmd(parts[1].split())
            if m:
                out.append(m)
    return out


def _media_ok(names: list[str]) -> bool:
    """media <cara> [sonido]: nombres de la SD del K210 (letras, números, _ y -), sin rutas"""
    return 1 <= len(names) <= 2 and all(0 < len(n) <= 40 and all(c.isalnum() or c in "_-" for c in n) for n in names)


def subir_cmd(name: str) -> dict | None:
    """Solo <nombre>.avi o <nombre>.mp3 de data_dir/caras/, con el nombre como lo acepta el robot (a-z, 0-9, _)."""
    stem, _, ext = name.rpartition(".")
    if ext not in ("avi", "mp3") or not stem or len(stem) > 24 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789_" for c in stem):
        append(f"servidor: subir: nombre no válido: {name}")
        return None
    path = _path(os.path.join("caras", name))
    if not os.path.exists(path):
        append(f"servidor: subir: no existe caras/{name}")
        return None
    return {"t": "_subir", "file": path, "nombre": stem, "ext": ext}


BAT_COLS = ("pct", "mv", "carga", "estado", "sin_alma", "servo_s", "prueba")


def bateria(msg: dict, now: float | None = None) -> None:
    """Un renglón de bateria.csv por aviso del robot (cada 5 min): hora del servidor y lo que mandó (app.c)."""
    p = _path("bateria.csv")
    new = not os.path.exists(p)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now if now is not None else time.time()))
    with open(p, "a", encoding="utf-8") as f:
        if new:
            f.write("hora," + ",".join(BAT_COLS) + "\n")
        f.write(stamp + "," + ",".join(str(msg.get(c, "")).replace(",", " ") for c in BAT_COLS) + "\n")


OTA_CHUNK = 4000   # bytes por trozo (el robot acepta hasta 9216, ota.h); chicos: hasta 0a2f190a, dos de 9 KB juntos
                   # en su búfer de 16 KB cortaban el enlace (2026-11-03)


def ota_cmd(args: list[str], log=append) -> dict | None:
    """"ota <archivo.bin> <sha256>": solo archivos de data_dir/ota/ (sin rutas) y con el SHA-256 que dice el archivo;
    "ota reboot": que arranque la ya verificada. Lo demás se ignora."""
    if args == ["reboot"]:
        return {"t": "ota_reboot"}
    if len(args) != 2 or "/" in args[0] or "\\" in args[0] or not args[0].endswith(".bin"):
        return None
    path = _path(os.path.join("ota", args[0]))
    sha = args[1].lower()
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        log(f"servidor: ota: no existe {args[0]}")
        return None
    if hashlib.sha256(data).hexdigest() != sha or len(sha) != 64:
        log(f"servidor: ota: el SHA-256 de {args[0]} no es el que dice la orden; no se manda")
        return None
    return {"t": "_ota", "file": path, "name": args[0], "sha256": sha, "size": len(data)}


def ota_chunks(data: bytes) -> list[dict]:
    n = (len(data) + OTA_CHUNK - 1) // OTA_CHUNK
    return [{"t": "ota", "seq": i, "last": i == n - 1, "b64": base64.b64encode(data[i * OTA_CHUNK:(i + 1) * OTA_CHUNK]).decode()}
            for i in range(n)]


# ---- la Home Station con alma-base (firmware/base; dueño, 2026-11-06) ----
# Su registro va a base_log.txt (siempre: no tiene USB) y sus órdenes se dejan en base_cmd.txt:
#   ota <archivo.bin> <sha256> | ota reboot   firmware nuevo por Wi-Fi, igual que el robot (data_dir/ota/)
#   anim <nombre>   una de sus animaciones (tools/base_leds)     leds off   apagar la matriz     anims   cuáles tiene
#   comp <r> <g> <b> [curva]   % extra por canal en los LEDs gastados por la casita de fábrica (0-300); curva
#                  100 = recta, 200 = cuadrática (por omisión)
#   pong | pong stop   una partida con Alma (su paleta la mueve el robot; sin él, un jugador con su estilo)
#   musica          20 s del analizador de espectro (normalmente lo prende el robot al bailar o cantar)

def base_append(s: str, now: float | None = None) -> None:
    append(s, now, "base_log.txt")


def base_take_cmds() -> list[dict]:
    """Lee y borra base_cmd.txt; devuelve los mensajes para la base (lo que no entiende, se ignora)."""
    p = _path("base_cmd.txt")
    try:
        with open(p, encoding="utf-8") as f:
            text = f.read()
        os.remove(p)
    except FileNotFoundError:
        return []
    out = []
    for ln in text.splitlines():
        parts = ln.strip().split()
        if len(parts) == 2 and parts[0] == "anim" and len(parts[1]) < 16 and parts[1].replace("_", "").isalnum():
            out.append({"t": "anim", "n": parts[1]})
        elif parts == ["leds", "off"]:
            out.append({"t": "leds_off"})
        elif parts == ["anims"]:
            out.append({"t": "anims"})
        elif parts == ["pong"]:
            out.append({"t": "pong"})
        elif parts == ["pong", "stop"]:
            out.append({"t": "pong_stop"})
        elif parts == ["musica"]:
            out.append({"t": "musica"})
        elif len(parts) in (4, 5) and parts[0] == "comp" and all(p.isdigit() and int(p) <= 400 for p in parts[1:]):
            m = {"t": "comp", "r": int(parts[1]), "g": int(parts[2]), "b": int(parts[3])}
            if len(parts) == 5:
                m["e"] = int(parts[4])
            out.append(m)
        elif parts and parts[0] == "ota":
            m = ota_cmd(parts[1:], log=base_append)
            if m:
                out.append(m)
    return out
