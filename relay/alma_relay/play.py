"""Jugar con Alma: la base común de los juegos nuevos (PLAN-JUEGOS del dueño, 2026-10-31).

Cada juego viene de un repo abierto (THIRD_PARTY.md) y corre en el celular con su propio motor de reglas: ese motor es
el árbitro (genera las jugadas legales, las aplica y decide quién gana). Aquí solo se decide la jugada de Alma:
el juego manda el estado en texto, la lista de jugadas legales (ids estables) y el historial corto; el relay agrega el
contexto de Alma (rasgos, ánimo, bienestar, salud, apego y su memoria de partidas) y Haiku elige con tool use forzado
(`elegir_jugada`, con la jugada como enum de las legales). Sin red, Alma no juega: un reintento y, si vuelve a fallar,
la partida se pausa ("Alma se quedó pensando"). En tiempo real, si su decisión llega tarde, ese momento no juega.

Partidas lentas (async): el dueño juega y cierra la app; Alma piensa un rato según su ánimo, guarda su jugada y avisa
con una notificación ("Ya jugué, te toca"). El estado de la partida (snapshot opaco del juego) vive en data/play.json
y sobrevive a reinicios del relay. Tope diario de tokens (Ajustes): al llegar, "Alma ya está cansada de jugar por hoy".
"""

import asyncio
import datetime as dt
import json
import os
import random
import re
import threading
import time
import uuid

from . import settings

REACTIONS = ["presumida", "nerviosa", "picada", "aburrida", "concentrada", "farol", "contenta", "dudosa"]
EVENT_TYPES = ["empieza", "buena_jugada", "mala_jugada", "gana_alma", "pierde_alma", "empate", "farol_descubierto"]
END_TYPES = {"gana_alma": "alma", "pierde_alma": "owner", "empate": "draw"}
MAX_LEGAL = 400            # más jugadas que esto: el juego debe agruparlas (p. ej. zonas en tiempo real)
MAX_TURN_S = 180           # tiempo del dueño por turno que cuenta para el bienestar (como en los otros juegos)
DEFAULT_BUDGET = 600_000   # tokens al día para jugar (Ajustes → play_budget_tokens)
REMIND_AFTER_S = 24 * 3600
REALTIME_TIMEOUT_S = 2.5
GAMES_DIR = os.environ.get("ALMA_GAMES_DIR", "/opt/alma-games")   # lo sirve Caddy en /play/ (solo con sesión)

# Cada juego: título, reglas resumidas para Haiku y cómo se juega con personalidad. Los ids son los de la app.
GAMES = {
    "dados": {
        "title": "Dados mentirosos", "emoji": "🎲", "async": False, "realtime": False,
        "rules": ("Dados mentirosos para dos. Cada uno tiene dados ocultos bajo un cubilete. Por turnos se apuesta "
                  "'hay al menos N dados con la cara X entre todos los dados de la mesa', subiendo cantidad o cara. "
                  "En vez de subir, puedes abrir (dudar): se destapan los dados; si la apuesta se cumple, pierde quien "
                  "abrió; si no, pierde quien apostó. Los unos pueden ser comodines (cuentan como cualquier cara) si "
                  "la mesa lo dice. Solo ves tus dados: la cantidad total se calcula con probabilidad."),
        "style": ("Atrevida o impulsiva: faroles (apostar caras que no tienes) y subidas grandes. Prudente: apuestas "
                  "que respaldan tus dados y abres cuando la apuesta es improbable. Marca reaccion=farol cuando "
                  "apuestes algo que tus dados no respaldan (el dueño no lo ve)."),
    },
    "muros": {
        "title": "Muros", "emoji": "🧱", "async": True, "realtime": False,
        "rules": ("Muros en un tablero de 9×9. Cada uno tiene una ficha y gana quien llegue primero al lado contrario. "
                  "En tu turno mueves tu ficha una casilla (puedes saltar a la otra ficha si está pegada) o pones un "
                  "muro de dos casillas que bloquea el paso; cada uno tiene 10 muros y nunca se puede encerrar a nadie "
                  "del todo. La lista de jugadas ya trae solo las legales."),
        "style": ("Terca: insiste en su camino. Atrevida: muros agresivos para alargar el camino del dueño. Prudente: "
                  "avanza y guarda muros. Cansada o enferma: juega más simple."),
    },
    "timbiriche": {
        "title": "Timbiriche", "emoji": "✏️", "async": False, "realtime": False,
        "rules": ("Timbiriche (puntos y cajas). Por turnos se traza una línea entre dos puntos vecinos. Quien cierra el "
                  "cuarto lado de una caja se la queda y vuelve a tirar. Gana quien tenga más cajas al llenar el "
                  "tablero. Cuidado con trazar el tercer lado de una caja: le regalas la caja al otro."),
        "style": "Impulsiva: tira rápido y a veces regala cajas. Concentrada: evita terceros lados y cuenta cadenas.",
    },
    "maestros": {
        "title": "Maestros", "emoji": "🥋", "async": True, "realtime": False,
        "rules": ("Maestros: tablero de 5×5, cada uno con un maestro y cuatro alumnos. Hay cinco cartas de movimiento: "
                  "dos tuyas, dos del rival y una al lado. En tu turno usas una de tus cartas para mover una pieza "
                  "según el dibujo de la carta, y esa carta pasa al rival. Ganas capturando al maestro rival o "
                  "llevando tu maestro a la casilla de inicio del maestro rival."),
        "style": "Atrevida: ataca al maestro. Prudente: protege al suyo y cambia piezas. Terca: sigue su plan.",
    },
    "naval": {
        "title": "Batalla naval", "emoji": "🚢", "async": False, "realtime": False,
        "rules": ("Batalla naval en un mar de 8×8 (filas A–H, columnas 1–8), cinco barcos por bando. Cada uno esconde sus barcos. Por turnos se dispara a una casilla: "
                  "agua, tocado o hundido. Gana quien hunda toda la flota rival. Cuando tocas un barco, conviene "
                  "seguir disparando alrededor hasta hundirlo."),
        "style": "Atrevida: dispara lejos y en patrones raros. Prudente: barre en diagonal. Impulsiva: a la suerte.",
    },
    "torres": {
        "title": "Batalla de torres", "emoji": "🏰", "async": False, "realtime": True,
        "rules": ("Batalla de torres en tiempo real (3 min). Cada uno tiene torres y una mano de cartas de tropas y "
                  "hechizos que cuestan energía; la energía sube sola. Gana quien destruya más torres. En cada "
                  "decisión eliges tirar una carta que puedas pagar en una zona, o esperar a juntar energía."),
        "style": "Atrevida: ataca pronto. Prudente: defiende y contraataca. Impulsiva: gasta la energía en cuanto la tiene.",
    },
}

PLAY_SYSTEM = (
    "Eres Alma, una mascota robot de escritorio, y juegas contra tu dueño desde su celular. El juego (el árbitro) ya "
    "te da solo las jugadas legales: elige una con la herramienta elegir_jugada.\n"
    "- jugada: el id exacto de una jugada de la lista.\n"
    "- reaccion: cómo te sientes con esta jugada (una de la lista).\n"
    "- pensamiento: lo que piensas, en español y primera persona, máximo 80 caracteres. El dueño lo ve como burbuja.\n"
    "Tu personalidad decide el ESTILO, no la fuerza: atrevida arriesga, impulsiva juega rápido sin pensar mucho, terca "
    "insiste en su plan, cansada o enferma juega peor y lo dice. Juegas por diversión. Nunca reveles en el "
    "pensamiento información oculta tuya (tus dados, tus barcos) ni que es un farol."
)

# Nivel de Alma en cada juego (dueño, 2026-10-31): "al inicio ambos somos principiantes… dentro de 2 meses, y ya
# jugué 100 juegos, su dificultad debe ser muy alta". Sube con las partidas jugadas (un poco más con las que pierde:
# aprende de sus derrotas). Principiante: ve solo algunas de las jugadas legales (al azar) y decide simple; experta:
# las ve todas y piensa a fondo. Siempre son jugadas legales: el árbitro sigue siendo el juego.
SKILL_GAMES = 100
LEVELS = [(0.0, "principiante"), (0.2, "aprendiz"), (0.45, "intermedia"), (0.7, "avanzada"), (0.9, "experta")]
LEVEL_HINT = {
    "principiante": ("Eres principiante en este juego (igual que tu dueño): decide rápido y simple, con la primera idea "
                     "razonable; no calcules varias jugadas adelante y a veces te equivocas."),
    "aprendiz": "Vas aprendiendo este juego: piensas un poco más, pero todavía se te pasan cosas.",
    "intermedia": "Ya juegas bien este juego: piensas la jugada y evitas errores obvios.",
    "avanzada": "Juegas muy bien este juego: anticipas lo que hará tu dueño y aprovechas sus errores.",
    "experta": ("Eres experta en este juego: piensa varias jugadas adelante, usa las probabilidades y lo que sabes de "
                "tu dueño, y elige la jugada más fuerte sin perder tu estilo."),
}

# Haiku a veces dice lo que tiene oculto ("Tengo tres dados buenos, dos seises"; prueba real, 2026-10-31) o que es un
# farol: en esos juegos el pensamiento se cambia por uno neutro según su reacción. Lo mismo si viene vacío.
LEAKS = {
    "dados": re.compile(r"\b(tengo|mis|mi)\b[^.!?]*\b(dados?|unos?|doses?|treses?|cuatros?|cincos?|seises?|pares?)\b|"
                        r"\b[1-6]\s*(,|y)\s*[1-6]\b|farol|blof|miento|mentira", re.I),
    "naval": re.compile(r"\b(mi|mis)\b[^.!?]*\b(barcos?|portaaviones|acorazado|submarino|crucero|destructor|lancha|flota)\b"
                        r"[^.!?]*\b[A-Ha-h]\s?[1-8]\b|farol|blof", re.I),
}
CANNED = {"presumida": "Je, a ver qué haces con esto.", "nerviosa": "Mmm… espero que salga bien.",
          "picada": "Ahora sí, ¡ahí te va!", "aburrida": "Va, esta.", "concentrada": "Déjame pensar… esta.",
          "farol": "Déjame pensar… esta.", "contenta": "¡Me gusta esta!", "dudosa": "No sé… pero va."}


def clean_thought(game: str, text: str, reaction: str) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()[:80]
    if not t or (game in LEAKS and LEAKS[game].search(t)):
        return CANNED.get(reaction, "Déjame pensar… esta.")
    return t


_lock = threading.Lock()
_rng = random.Random()
_tasks: dict[str, asyncio.Task] = {}


# ---- almacén ----

def _path() -> str:
    return os.path.join(settings.data_dir(), "play.json")


def load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
    except (FileNotFoundError, ValueError):
        d = {}
    if not isinstance(d, dict):
        d = {}
    d.setdefault("matches", {})      # una abierta por juego como máximo: game → partida
    d.setdefault("log", [])          # partidas terminadas
    d.setdefault("habits", {})       # game → lo que Alma notó del dueño (últimos 6)
    d.setdefault("usage", {})        # día → tokens
    d.setdefault("owner_attachment", None)
    return d


def _save(d: dict) -> None:
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, _path())


def _day(ts: float) -> str:
    from . import alarms
    return dt.datetime.fromtimestamp(ts, alarms.tz()).date().isoformat()


def budget() -> int:
    v = settings.get("play_budget_tokens")
    return int(v) if isinstance(v, (int, float)) and v > 0 else DEFAULT_BUDGET


def used_today(d: dict, now: float) -> int:
    return int(d["usage"].get(_day(now), 0))


def _charge(d: dict, tokens: int, now: float) -> None:
    day = _day(now)
    d["usage"] = {k: v for k, v in d["usage"].items() if k >= _day(now - 7 * 86400)}
    d["usage"][day] = d["usage"].get(day, 0) + int(tokens)


# ---- contexto de Alma ----

def remember_robot(robot_state: dict) -> None:
    """El apego solo llega cuando el dueño está frente a ella: se guarda el último que se vio."""
    for p in robot_state.get("people_present") or []:
        if p.get("person_id") == 0 and isinstance(p.get("attachment"), (int, float)):
            with _lock:
                d = load()
                if d["owner_attachment"] != round(p["attachment"], 2):
                    d["owner_attachment"] = round(p["attachment"], 2)
                    _save(d)


def alma_context(robot_state: dict, game: str, d: dict) -> str:
    from . import care, games
    rs = robot_state or {}
    lines = ["Tu carácter ahora: " + games._mood_text(rs)]
    wb = rs.get("wellbeing")
    if isinstance(wb, (int, float)):
        lines.append(f"Bienestar (−1023 a 1023): {wb:+.0f}.")
    needs = rs.get("needs") or {}
    if needs:
        lines.append("Necesidades (0 a 1): " + ", ".join(f"{k} {v:.2f}" for k, v in needs.items()
                                                         if isinstance(v, (int, float))) + ".")
    try:
        c = care.snapshot()
        if care.enabled(rs):
            lines.append(f"Salud: {'enferma (' + (c.get('what') or c.get('cause') or '') + ')' if c['sick'] else 'sana'}; "
                         f"peso {c['band']}; energía {c['energy']:.2f}; hambre {c['hunger']:.2f}.")
    except Exception:
        pass
    if d["owner_attachment"] is not None:
        lines.append(f"Apego con tu dueño (0 a 1): {d['owner_attachment']:.2f}.")
    rec = record(d, game)
    lines.append(f"Contra tu dueño en este juego: ganaste {rec['alma']}, perdiste {rec['owner']}"
                 + (f", empates {rec['draw']}" if rec["draw"] else "") + (f"; racha: {rec['streak']}" if rec["streak"] else "") + ".")
    if d["habits"].get(game):
        lines.append("Lo que has notado de cómo juega tu dueño: " + "; ".join(d["habits"][game][-3:]) + ".")
    return "\n".join(lines)


def skill(d: dict, game: str) -> float:
    """0 (principiante) … 1 (experta), por las partidas jugadas en ese juego."""
    log = [e for e in d["log"] if e["game"] == game]
    lost = sum(1 for e in log if e["winner"] == "owner")
    return round(min(1.0, (len(log) + 0.5 * lost) / SKILL_GAMES) ** 0.8, 3)


def level_name(sk: float) -> str:
    return [name for lim, name in LEVELS if sk >= lim][-1]


def considered(legal: list[dict], sk: float, rng: random.Random) -> list[dict]:
    """Las jugadas que "ve": de principiante, una parte al azar (siempre la primera de la lista, que los juegos usan
    para lo especial: abrir, esperar); de experta, todas. El orden se conserva."""
    k = max(3, round(len(legal) * (0.25 + 0.75 * sk)))
    if k >= len(legal):
        return legal
    keep = {0} | set(rng.sample(range(1, len(legal)), k - 1))
    return [m for i, m in enumerate(legal) if i in keep]


def record(d: dict, game: str | None = None) -> dict:
    r = {"alma": 0, "owner": 0, "draw": 0, "streak": ""}
    last, n = None, 0
    for e in d["log"]:
        if game and e["game"] != game:
            continue
        r[e["winner"]] = r.get(e["winner"], 0) + 1
        n = n + 1 if e["winner"] == last else 1
        last = e["winner"]
    if last in ("alma", "owner") and n >= 2:
        r["streak"] = f"{'ganaste' if last == 'alma' else 'perdiste'} las últimas {n}"
    return r


# ---- Haiku elige (tool use forzado; sin respaldo) ----

class Paused(Exception):
    """Haiku no contestó dos veces, o se acabó el presupuesto: la partida espera."""


def _tool(legal_ids: list[str]) -> dict:
    return {"name": "elegir_jugada", "description": "Elige tu jugada de la lista y di cómo te sientes.",
            "input_schema": {"type": "object", "properties": {
                "jugada": {"type": "string", "enum": legal_ids},
                "reaccion": {"type": "string", "enum": REACTIONS},
                "pensamiento": {"type": "string", "minLength": 3,
                                "description": "Español, primera persona, ≤ 80 caracteres. Nunca vacío."}},
                "required": ["jugada", "reaccion", "pensamiento"]}}


def _prompt(game: str, state_text: str, legal: list[dict], history: list[str], ctx: str) -> str:
    lines = [ctx, "", "Estado (solo lo que tú ves):", state_text.strip()[:3000], ""]
    if history:
        lines += ["Últimas jugadas:"] + [f"- {h}" for h in history[-8:]] + [""]
    lines.append("Jugadas legales (id: qué es):")
    lines += [f"{m['id']}: {m.get('label', m['id'])}" for m in legal]
    return "\n".join(lines)


def choose(game: str, state_text: str, legal: list[dict], history: list[str], robot_state: dict,
           now: float | None = None, timeout: float | None = None, tries: int = 2) -> dict:
    """{"id", "reaccion", "pensamiento", "tokens"}. Lanza Paused si no se pudo (sin jugada sustituta)."""
    now = now or time.time()
    if game not in GAMES:
        raise ValueError("juego desconocido")
    ids = [str(m["id"]) for m in legal]
    if not ids or len(ids) > MAX_LEGAL or len(set(ids)) != len(ids):
        raise ValueError("lista de jugadas inválida")
    with _lock:
        d = load()
        if used_today(d, now) >= budget():
            raise Paused("cansada")
        ctx = alma_context(robot_state, game, d)
        sk = skill(d, game)
    if not settings.get("anthropic_key"):
        raise Paused("sin_llave")
    all_ids = set(ids)                    # todas las legales que mandó el juego (el árbitro)
    legal = considered(legal, sk, _rng)
    ids = [str(m["id"]) for m in legal]
    ctx += f"\nTu nivel en este juego: {level_name(sk)} ({sk:.2f}). {LEVEL_HINT[level_name(sk)]}"
    from . import haiku
    g = GAMES[game]
    system = [{"type": "text", "text": PLAY_SYSTEM},
              {"type": "text", "text": f"Juego: {g['title']}.\nReglas: {g['rules']}\nEstilo: {g['style']}",
               "cache_control": {"type": "ephemeral"}}]
    text = _prompt(game, state_text, legal, history, ctx)
    last = None
    for _ in range(max(1, tries)):
        try:
            kw = {"timeout": timeout} if timeout else {}
            r = haiku.client().messages.create(
                model=haiku.MODEL, max_tokens=120, system=system, tools=[_tool(ids)],
                tool_choice={"type": "tool", "name": "elegir_jugada"}, messages=[{"role": "user", "content": text}], **kw)
            u = getattr(r, "usage", None)
            tokens = (getattr(u, "input_tokens", 0) or 0) + (getattr(u, "output_tokens", 0) or 0) if u else 0
            with _lock:
                d = load()
                _charge(d, tokens, now)
                _save(d)
            raw = haiku._tool_input(r, "elegir_jugada")
            mv = str(raw.get("jugada"))
            # De principiante ve solo algunas, pero si elige otra que el juego sí permite (p. ej. disparar junto a un
            # tocado que vio en el tablero; prueba real, 2026-10-31), es legal y vale. Fuera de las legales: fallo.
            if mv not in all_ids:
                raise ValueError("jugada fuera de la lista")
            reac = raw.get("reaccion") if raw.get("reaccion") in REACTIONS else "concentrada"
            th = clean_thought(game, raw.get("pensamiento"), reac)
            return {"id": mv, "reaccion": reac, "pensamiento": th, "tokens": tokens}
        except Paused:
            raise
        except Exception as e:
            last = e
            print(f"[alma-relay] jugar {game}: Haiku falló ({type(e).__name__})", flush=True)
    raise Paused("pensando") from last


# ---- partidas ----

PAUSE_TEXT = {"pensando": "Alma se quedó pensando… (sin conexión con su cerebro). Intenta en un rato.",
              "cansada": "Alma ya está cansada de jugar por hoy.",
              "sin_llave": "Falta la llave de Claude en Ajustes: sin ella Alma no puede jugar."}


def refuse_reason(robot_state: dict) -> str | None:
    """Respeta al núcleo: enferma, muy triste o sin energía puede no querer jugar."""
    from . import care
    rs = robot_state or {}
    try:
        c = care.snapshot()
        if care.enabled(rs) and c["sick"]:
            return "Alma está enferma y no tiene ganas de jugar ahorita."
        if care.enabled(rs) and c["energy"] < 0.4 and _rng.random() < 0.6:
            return "Alma está muy cansada; dice que mejor al rato."
    except Exception:
        pass
    wb = rs.get("wellbeing")
    if isinstance(wb, (int, float)) and wb < -500 and _rng.random() < 0.5:
        return "Alma anda triste y no quiere jugar ahorita."
    return None


def start(game: str, robot_state: dict, now: float | None = None, force_new: bool = False) -> dict:
    now = now or time.time()
    if game not in GAMES:
        raise ValueError("juego desconocido")
    with _lock:
        d = load()
        m = d["matches"].get(game)
        if m and not force_new:
            return {"ok": True, "match": public(m), "resumed": True}
        if used_today(d, now) >= budget():
            return {"ok": False, "refused": PAUSE_TEXT["cansada"]}
    why = refuse_reason(robot_state)
    if why:
        return {"ok": False, "refused": why}
    with _lock:
        d = load()
        m = {"id": uuid.uuid4().hex[:12], "game": game, "started": now, "updated": now, "snapshot": None,
             "turn": "owner", "pending": None, "request": None, "owner_since": now, "owner_seconds": 0,
             "moves": 0, "reminded": False, "paused": None}
        d["matches"][game] = m
        _save(d)
    return {"ok": True, "match": public(m), "resumed": False}


def public(m: dict) -> dict:
    return {k: m.get(k) for k in ("id", "game", "started", "updated", "snapshot", "turn", "pending", "moves", "paused")}


def get(game: str) -> dict | None:
    m = load()["matches"].get(game)
    return public(m) if m else None


def save_snapshot(game: str, match_id: str, snapshot, now: float | None = None) -> bool:
    now = now or time.time()
    with _lock:
        d = load()
        m = d["matches"].get(game)
        if not m or m["id"] != match_id:
            return False
        m["snapshot"], m["updated"] = snapshot, now
        if m.get("pending") and m["pending"].get("seen"):
            m["pending"] = None
        _save(d)
        return True


def owner_moved(game: str, match_id: str, now: float | None = None) -> int:
    """El dueño terminó su turno: segundos que cuentan (con tope) para el bienestar y como poquito ejercicio."""
    now = now or time.time()
    with _lock:
        d = load()
        m = d["matches"].get(game)
        if not m or m["id"] != match_id:
            return 0
        add = int(min(max(0.0, now - (m.get("owner_since") or now)), MAX_TURN_S))
        m["owner_seconds"] += add
        m["owner_since"] = None
        m["moves"] += 1
        m["reminded"] = False
        _save(d)
        return add


def alma_moved(game: str, match_id: str, choice: dict, now: float | None = None) -> None:
    now = now or time.time()
    with _lock:
        d = load()
        m = d["matches"].get(game)
        if not m or m["id"] != match_id:
            return
        m["pending"] = {"id": choice["id"], "reaccion": choice["reaccion"], "pensamiento": choice["pensamiento"],
                        "at": now, "seen": False}
        m["request"], m["paused"], m["turn"] = None, None, "owner"
        m["owner_since"], m["updated"] = now, now
        m["moves"] += 1
        _save(d)


def set_request(game: str, match_id: str, req: dict | None, paused: str | None = None) -> None:
    with _lock:
        d = load()
        m = d["matches"].get(game)
        if not m or m["id"] != match_id:
            return
        m["request"], m["paused"] = req, paused
        m["turn"] = "alma" if req else m["turn"]
        _save(d)


def mark_seen(game: str, match_id: str) -> None:
    with _lock:
        d = load()
        m = d["matches"].get(game)
        if m and m["id"] == match_id and m.get("pending"):
            m["pending"]["seen"] = True
            _save(d)


def finish(game: str, match_id: str, winner: str, now: float | None = None) -> dict | None:
    """Cierra la partida y la anota (una sola vez)."""
    now = now or time.time()
    with _lock:
        d = load()
        m = d["matches"].get(game)
        if not m or m["id"] != match_id:
            return None
        d["matches"].pop(game)
        e = {"game": game, "id": match_id, "winner": winner, "started": m["started"], "ended": now,
             "seconds": int(now - m["started"]), "moves": m["moves"], "owner_seconds": m["owner_seconds"],
             "date": _day(now)}
        d["log"] = (d["log"] + [e])[-200:]
        _save(d)
        return e


def think_delay(robot_state: dict) -> float:
    """Partidas lentas: cuánto se tarda en contestar según su ánimo (segundos)."""
    sm = (robot_state or {}).get("simple_mood")
    lo, hi = {"SM_PLAYFUL": (5, 20), "SM_HAPPY": (10, 40), "SM_SLEEPY": (120, 600), "SM_GRUMPY": (60, 300),
              "SM_BORED": (5, 30)}.get(sm, (30, 120))
    return lo + (hi - lo) * _rng.random()


def add_habit(game: str, note: str) -> None:
    note = re.sub(r"\s+", " ", note or "").strip()[:120]
    if not note:
        return
    with _lock:
        d = load()
        d["habits"][game] = (d["habits"].get(game, []) + [note])[-6:]
        _save(d)


HABIT_SYSTEM = ("Eres Alma, una mascota robot. Acabas de terminar una partida contra tu dueño. Con el historial, "
                "anota UN hábito o costumbre que notaste en cómo juega él (máximo 100 caracteres, en español, "
                "concreto: 'siempre abre cuando subo a cuatro', 'pone muros en la columna e'). Si no notaste nada, "
                "contesta exactamente: nada.")


def note_habit(game: str, history: list[str], now: float | None = None) -> str:
    """Al terminar: Haiku anota un hábito del dueño (cuenta en el presupuesto). Si falla, no pasa nada."""
    now = now or time.time()
    if not history or not settings.get("anthropic_key"):
        return ""
    with _lock:
        d = load()
        if used_today(d, now) >= budget():
            return ""
    try:
        from . import haiku
        r = haiku.client().messages.create(model=haiku.MODEL, max_tokens=80, system=HABIT_SYSTEM,
                                           messages=[{"role": "user", "content": f"Juego: {GAMES[game]['title']}.\n"
                                                      + "\n".join(history[-40:])}])
        u = getattr(r, "usage", None)
        with _lock:
            d = load()
            _charge(d, ((getattr(u, "input_tokens", 0) or 0) + (getattr(u, "output_tokens", 0) or 0)) if u else 0, now)
            _save(d)
        text = "".join(getattr(b, "text", "") for b in r.content).strip()
        if text and text.lower().strip(". ") != "nada":
            add_habit(game, text)
            return text
    except Exception as e:
        print(f"[alma-relay] jugar {game}: hábito sin anotar ({type(e).__name__})", flush=True)
    return ""


def due_reminders(now: float | None = None) -> list[str]:
    """Partidas lentas en las que el dueño no juega desde hace 24 h: se le recuerda una vez."""
    now = now or time.time()
    out = []
    with _lock:
        d = load()
        for g, m in d["matches"].items():
            if (GAMES.get(g, {}).get("async") and m["turn"] == "owner" and not m.get("reminded")
                    and now - m["updated"] >= REMIND_AFTER_S):
                m["reminded"] = True
                out.append(g)
        if out:
            _save(d)
    return out


def today_summary(now: float | None = None) -> list[dict]:
    """Para el diario nocturno."""
    now = now or time.time()
    d = load()
    day = _day(now - 6 * 3600)   # el pase es de madrugada
    out = [{"juego": GAMES.get(e["game"], {}).get("title", e["game"]),
            "ganó": {"alma": "tú (Alma)", "owner": "tu dueño", "draw": "empate"}.get(e["winner"], e["winner"]),
            "movimientos_de_la_partida": e["moves"]}
           for e in d["log"] if e.get("date") in (day, _day(now))]
    habits = [h for g in d["habits"].values() for h in g[-1:]]
    return out + ([{"hábitos_notados": habits}] if habits else [])


def _played_today() -> int:
    """Segundos que jugó el dueño hoy en todos los juegos (games.json lleva la cuenta de todos)."""
    try:
        from . import games
        return games.played_seconds_today()
    except Exception:
        return 0


def overview(robot_state: dict, now: float | None = None) -> dict:
    now = now or time.time()
    d = load()
    return {"games": [{"id": k, "title": g["title"], "emoji": g["emoji"], "async": g["async"], "realtime": g["realtime"],
                       "record": record(d, k), "open": public(d["matches"][k]) if k in d["matches"] else None,
                       "level": level_name(skill(d, k)), "skill": skill(d, k)}
                      for k, g in GAMES.items() if os.path.exists(os.path.join(GAMES_DIR, k, "index.html"))],
            "budget": budget(), "used_today": used_today(d, now), "tired": used_today(d, now) >= budget(),
            "seconds_today": _played_today(),
            "mood": (robot_state or {}).get("simple_mood"), "wellbeing": (robot_state or {}).get("wellbeing")}
