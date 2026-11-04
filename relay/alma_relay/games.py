"""Juegos de mesa por turnos contra Alma (dueño, 2026-10-30).

Reglas reales de OpenSpiel (pyspiel); Alma juega con Haiku en personaje. El dueño juega desde la app sin prisa: hace
su jugada y cierra; Alma contesta en segundos (las pantallas viejas se quitaron el 2026-10-31; queda para PlayStrategy y el diario). data/games.json guarda las partidas (estado serializado
de OpenSpiel), el registro de las terminadas y el tiempo de juego del dueño.

Juegos con información oculta: cada lado ve solo su vista (observation_string o information_state_string). A Haiku
nunca le llega la mano ni los dados del dueño.
"""

import datetime as dt
import json
import os
import random
import re
import secrets
import threading
import time

from . import settings

MAX_TURN_S = 180      # por jugada del dueño se cuenta como mucho esto
KEEP_LOG = 300        # partidas terminadas en el registro
KEEP_DONE = 12        # partidas terminadas que se pueden seguir abriendo
KEEP_PLAY_DAYS = 8
MAX_PROMPT_MOVES = 300
_lock = threading.Lock()
_rng = random.SystemRandom()

# ---- registro de juegos ----

CARDS = "Cartas: valor A,2–9,T(10),J,Q,K y palo C/c tréboles, D/d diamantes, H/h corazones, S/s picas."

# Dueño, 2026-10-30: sin juegos de cartas, Dudo ni Hive; los juegos de verdad irán en PlayStrategy (Alma como bot)
GAMES = {
    "backgammon": {
        "spiel": "backgammon", "title": "Backgammon", "icon": "🎲",
        "desc": "Dados y carrera: saca tus 15 fichas antes que Alma.",
        "rules": ("Backgammon clásico. Cada uno tiene 15 fichas (x u o) que avanzan en sentidos opuestos. Se tiran dos "
                  "dados y se mueve una ficha por cada dado (con dobles, cuatro movimientos). Una ficha sola en un punto "
                  "puede ser comida (*) y va a la barra (Bar); hay que volver a entrarla antes de mover otras. Con todas "
                  "en tu cuadrante final las sacas (Off). Gana quien saca sus 15 fichas primero. Las jugadas son "
                  "desde/hasta, contando los puntos desde tu lado (de 24 hacia 1)."),
        "seats": ("x", "o"),
    },
    "oware": {
        "spiel": "oware", "title": "Oware", "icon": "🌰",
        "desc": "Siembra y captura semillas en el tablero africano.",
        "rules": ("Oware (abapa). Dos filas de 6 hoyos con 4 semillas cada uno; tu fila es A–F si eres el jugador 0 o "
                  "a–f si eres el 1. En tu turno tomas todas las semillas de un hoyo tuyo y las siembras una por hoyo en "
                  "sentido antihorario. Si la última cae en la fila rival y ese hoyo queda con 2 o 3, las capturas, y "
                  "también las de los hoyos anteriores seguidos con 2 o 3. Si el rival no tiene semillas, hay que darle. "
                  "Gana quien captura más de 24. Vista: jugador en turno | puntos 0 y 1 | hoyos A–F y luego a–f."),
        "seats": ("jugador 0 (fila A–F)", "jugador 1 (fila a–f)"),
    },
}

# jugadas que el rival no debe ver (el descarte a la cuna del cribbage)
HIDDEN_TEXT = {"cribbage": "descartó 2 cartas a la cuna"}


def game_list() -> list[dict]:
    return [{"id": k, "title": g["title"], "icon": g["icon"], "desc": g["desc"], "rules": g["rules"]}
            for k, g in GAMES.items()]


# ---- OpenSpiel ----

def _spiel():
    import pyspiel   # pesado: solo al jugar
    return pyspiel


def _state(m: dict):
    return _spiel().deserialize_game_and_state(m["ser"])


def _ser(game, state) -> str:
    return _spiel().serialize_game_and_state(game, state)


def _settle(state) -> None:
    """Los nodos de azar (repartir, tirar dados) los resuelve el servidor."""
    while state.is_chance_node():
        outs = state.chance_outcomes()
        state.apply_action(_rng.choices([a for a, _ in outs], [p for _, p in outs])[0])


def view(game, state, player: int) -> str:
    """Lo que ve un jugador: solo su lado si el juego tiene información oculta."""
    t = game.get_type()
    if t.provides_observation_string:
        return state.observation_string(player)
    if t.provides_information_state_string:
        return state.information_state_string(player)
    return str(state)


def label(state, player: int, action: int) -> str:
    s = state.action_to_string(player, action)
    s = re.sub(r"^Player: \d+ Action: ", "", s)    # gin rummy
    return re.sub(r"^\d+ - ", "", s)                # backgammon


def _hidden(key: str, state, player: int) -> bool:
    return key == "cribbage" and "Phase: Card" in state.observation_string(player)


def _seat_turn(m: dict, state) -> str | None:
    if state.is_terminal():
        return None
    return "owner" if state.current_player() == m["owner_seat"] else "alma"


# ---- almacén ----

def _path() -> str:
    return os.path.join(settings.data_dir(), "games.json")


def load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
    except (FileNotFoundError, ValueError):
        d = {}
    if not isinstance(d, dict):
        d = {}
    d.setdefault("matches", {})
    d.setdefault("log", [])
    d.setdefault("play", [])
    d.setdefault("ps", {})   # partidas en curso en PlayStrategy (playstrategy.py)
    return d


def _save(d: dict) -> None:
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, _path())


def get(mid: str) -> dict | None:
    return load()["matches"].get(mid)


def _tz(tz=None) -> dt.tzinfo:
    if tz is None:
        from . import alarms
        return alarms.tz()
    if isinstance(tz, str):
        from zoneinfo import ZoneInfo
        return ZoneInfo(tz)
    return tz


def _day(ts: float, tz=None) -> str:
    return dt.datetime.fromtimestamp(ts, _tz(tz)).date().isoformat()


def new_match(key: str, now: float | None = None) -> dict:
    """Empieza una partida (o devuelve la que ya está en curso de ese juego). El dueño juega en un asiento al azar."""
    now = now or time.time()
    with _lock:
        d = load()
        for m in d["matches"].values():
            if m["game"] == key and m["status"] == "playing":
                return m
        game = _spiel().load_game(GAMES[key]["spiel"])
        state = game.new_initial_state()
        _settle(state)
        seat = _rng.randrange(2)
        m = {"id": secrets.token_hex(6), "game": key, "owner_seat": seat, "alma_seat": 1 - seat,
             "ser": _ser(game, state), "status": "playing", "started": now, "updated": now, "ended": None,
             "history": [], "moves": 0, "owner_seconds": 0, "last_owner_at": now, "last_fetch": now,
             "comment": "", "comment_at": None, "result": None}
        m["turn"] = _seat_turn(m, state)
        d["matches"][m["id"]] = m
        _save(d)
        return m


def touch(mid: str, now: float | None = None, poll: bool = False) -> dict | None:
    """El dueño abrió la partida (poll=False) o la app la está refrescando sola (poll=True: solo "está mirando")."""
    now = now or time.time()
    with _lock:
        d = load()
        m = d["matches"].get(mid)
        if not m:
            return None
        m["last_fetch"] = now
        if not poll:
            m["last_owner_at"] = now
        _save(d)
        return m


def _record(d: dict, m: dict, game, state, who: str, action: int, now: float, comment: str | None = None) -> None:
    player = state.current_player()
    m["history"].append({"who": who, "label": label(state, player, action), "hidden": _hidden(m["game"], state, player),
                         "at": now})
    m["history"] = m["history"][-80:]
    state.apply_action(action)
    _settle(state)
    m["moves"] += 1
    m["ser"] = _ser(game, state)
    m["updated"] = now
    m["turn"] = _seat_turn(m, state)
    if comment:
        m["comment"], m["comment_at"] = comment, now
    if state.is_terminal():
        r = state.returns()
        o, a = r[m["owner_seat"]], r[m["alma_seat"]]
        _finish(d, m, "owner" if o > a else "alma" if a > o else "draw", now, returns=[o, a])


def _finish(d: dict, m: dict, winner: str, now: float, returns=None, resigned: bool = False) -> None:
    m.update(status="over", turn=None, ended=now, result={"winner": winner, "resigned": resigned, "returns": returns})
    d["log"] = (d["log"] + [{"date": _day(now), "ended_at": now, "game": m["game"], "winner": winner,
                             "resigned": resigned, "moves": m["moves"], "owner_seconds": int(m["owner_seconds"])}])[-KEEP_LOG:]
    done = sorted((x for x in d["matches"].values() if x["status"] == "over"), key=lambda x: x["ended"] or 0)
    for x in done[:-KEEP_DONE]:
        d["matches"].pop(x["id"], None)


def owner_move(mid: str, action, now: float | None = None, mood: dict | None = None) -> dict | str:
    """Jugada del dueño. Devuelve la partida o un texto de error."""
    now = now or time.time()
    if isinstance(action, bool) or not isinstance(action, int):
        return "jugada inválida"
    with _lock:
        d = load()
        m = d["matches"].get(mid)
        if not m:
            return "no existe"
        if m["status"] != "playing":
            return "la partida ya terminó"
        game, state = _state(m)
        if state.current_player() != m["owner_seat"]:
            return "es el turno de Alma"
        if action not in state.legal_actions():
            return "esa jugada no vale"
        add = max(0.0, min(now - m.get("last_owner_at", now), MAX_TURN_S))
        m["owner_seconds"] += add
        d["play"] = [p for p in d["play"] if now - p[0] < KEEP_PLAY_DAYS * 86400] + [[now, round(add, 1)]]
        m["last_owner_at"] = m["last_fetch"] = now
        _record(d, m, game, state, "owner", action, now)
        if m["status"] == "over":
            m["comment"], m["comment_at"] = end_comment(m["result"]["winner"], mood), now
        _save(d)
        return m


def resign(mid: str, now: float | None = None) -> dict | None:
    now = now or time.time()
    with _lock:
        d = load()
        m = d["matches"].get(mid)
        if not m:
            return None
        if m["status"] == "playing":
            _finish(d, m, "alma", now, resigned=True)
            m["comment"], m["comment_at"] = "¿Te rindes? ¡Gané! La próxima te dejo ganar… o no.", now
        _save(d)
        return m


def delete(mid: str, now: float | None = None) -> bool:
    """Borra la partida de la lista; si seguía en juego cuenta como rendición."""
    now = now or time.time()
    with _lock:
        d = load()
        m = d["matches"].get(mid)
        if not m:
            return False
        if m["status"] == "playing":
            _finish(d, m, "alma", now, resigned=True)
        d["matches"].pop(mid, None)
        _save(d)
        return True


# ---- vistas ----

def _history_for(m: dict, side: str) -> list[dict]:
    """Historial visto por un lado: las jugadas ocultas del otro salen sin detalle."""
    out = []
    for h in m["history"]:
        lab = h["label"]
        if h["hidden"] and h["who"] != side:
            lab = HIDDEN_TEXT.get(m["game"], "jugada oculta")
        out.append({"who": h["who"], "label": lab, "at": h["at"]})
    return out


def owner_view(m: dict) -> dict:
    game, state = _state(m)
    seat = m["owner_seat"]
    # al terminar una de información oculta se destapa todo (manos, dados): así se ve quién tenía razón
    reveal = state.is_terminal() and game.get_type().information != _spiel().GameType.Information.PERFECT_INFORMATION
    legal = []
    if m["status"] == "playing" and state.current_player() == seat:
        legal = [{"a": a, "label": label(state, seat, a)} for a in state.legal_actions()]
    g = GAMES[m["game"]]
    return {"id": m["id"], "game": m["game"], "title": g["title"], "icon": g["icon"], "rules": g["rules"],
            "owner_seat": seat, "seat_name": g["seats"][seat], "alma_seat_name": g["seats"][m["alma_seat"]],
            "status": m["status"], "turn": m["turn"],
            "view": str(state) if reveal else view(game, state, seat), "revealed": reveal,
            "legal": legal, "comment": m["comment"], "comment_at": m["comment_at"], "result": m["result"],
            "moves": m["moves"], "history": _history_for(m, "owner")[-30:], "started": m["started"],
            "updated": m["updated"]}


def brief(m: dict) -> dict:
    g = GAMES[m["game"]]
    return {"id": m["id"], "game": m["game"], "title": g["title"], "icon": g["icon"], "status": m["status"],
            "turn": m["turn"], "moves": m["moves"], "result": m["result"], "updated": m["updated"],
            "comment": m["comment"]}


def matches() -> list[dict]:
    return [brief(m) for m in sorted(load()["matches"].values(), key=lambda x: -x["updated"])
            if m["game"] in GAMES]   # partidas de juegos que se quitaron: no se listan


def alma_options(m: dict) -> dict:
    """Lo que Haiku necesita para elegir: solo la vista de Alma, nunca la del dueño."""
    game, state = _state(m)
    seat = m["alma_seat"]
    actions = state.legal_actions()
    recent = [("Tú" if h["who"] == "alma" else "Tu dueño") + ": " + h["label"] for h in _history_for(m, "alma")[-8:]]
    return {"game": m["game"], "ser": m["ser"], "seat_name": GAMES[m["game"]]["seats"][seat],
            "view": view(game, state, seat), "actions": actions, "labels": [label(state, seat, a) for a in actions],
            "recent": recent}


def apply_alma(mid: str, ser_before: str, action: int, comment: str | None, now: float | None = None,
               mood: dict | None = None) -> dict | None:
    """Aplica la jugada de Alma si la partida no cambió mientras Haiku pensaba."""
    now = now or time.time()
    with _lock:
        d = load()
        m = d["matches"].get(mid)
        if not m or m["status"] != "playing" or m["ser"] != ser_before:
            return None
        game, state = _state(m)
        if state.current_player() != m["alma_seat"] or action not in state.legal_actions():
            return None
        _record(d, m, game, state, "alma", action, now, comment)
        if m["status"] == "over":
            m["comment"], m["comment_at"] = (comment + " " if comment else "") + end_comment(m["result"]["winner"], mood), now
            m["comment"] = m["comment"][:140]
        _save(d)
        return m


# ---- para el diario y el bienestar ----

def played_seconds_today(tz=None, now: float | None = None) -> int:
    """Segundos que el dueño jugó hoy (zona del dueño si tz es None), con el tope de 180 s por jugada."""
    now = now or time.time()
    today = _day(now, tz)
    return int(sum(s for ts, s in load()["play"] if _day(ts, tz) == today))


def today_summary(tz=None, now: float | None = None) -> list[dict]:
    """Partidas de hoy: las terminadas y las que siguen en juego con movimiento hoy."""
    now = now or time.time()
    today = _day(now, tz)
    d = load()
    out = [{"game": e["game"], "title": GAMES.get(e["game"], {}).get("title", e["game"]), "state": "finished",
            "winner": e["winner"], "resigned": e["resigned"], "moves": e["moves"], "owner_seconds": e["owner_seconds"]}
           for e in d["log"] if _day(e["ended_at"], tz) == today]
    for e in d["ps"].values():
        if _day(e["updated"], tz) == today:
            out.append({"game": e["game"], "title": GAMES.get(e["game"], {}).get("title", e["game"]), "state": "playing",
                        "winner": None, "resigned": False, "moves": e["moves"], "owner_seconds": int(e["owner_seconds"]),
                        "where": e.get("where", "PlayStrategy")})
    for m in d["matches"].values():
        if m["status"] == "playing" and _day(m["updated"], tz) == today:
            out.append({"game": m["game"], "title": GAMES.get(m["game"], {}).get("title", m["game"]), "state": "playing", "winner": None,
                        "resigned": False, "moves": m["moves"], "owner_seconds": int(m["owner_seconds"])})
    return out


# ---- partidas en PlayStrategy (playstrategy.py): solo lo que cuenta para el diario y el bienestar ----

def ps_update(gid: str, key: str, moves: int, add_s: float = 0, now: float | None = None,
              where: str = "PlayStrategy") -> None:
    """La partida avanzó; add_s: segundos del dueño en su último turno (con el tope de MAX_TURN_S).
    También la usan los juegos dentro de la app (bgammon_alma.py, where="la app")."""
    now = now or time.time()
    add_s = max(0.0, min(add_s, MAX_TURN_S))
    with _lock:
        d = load()
        e = d["ps"].setdefault(gid, {"game": key, "started": now, "owner_seconds": 0, "moves": 0})
        e.update(moves=moves, updated=now, where=where)
        e["owner_seconds"] += add_s
        if add_s:
            d["play"] = [p for p in d["play"] if now - p[0] < KEEP_PLAY_DAYS * 86400] + [[now, round(add_s, 1)]]
        _save(d)


def ps_finish(gid: str, key: str, winner: str, resigned: bool, moves: int, now: float | None = None) -> None:
    """Terminó (winner: "alma", "owner" o "draw"): pasa al registro de terminadas, una sola vez."""
    now = now or time.time()
    with _lock:
        d = load()
        e = d["ps"].pop(gid, None) or {"owner_seconds": 0}
        if any(x.get("ps_id") == gid for x in d["log"][-50:]):
            return
        d["log"] = (d["log"] + [{"date": _day(now), "ended_at": now, "game": key, "winner": winner, "resigned": resigned,
                                 "moves": moves, "owner_seconds": int(e["owner_seconds"]), "ps_id": gid}])[-KEEP_LOG:]
        _save(d)


# ---- Alma elige (Haiku en personaje) ----

MOODS = {"SM_SCARED": "asustada", "SM_SLEEPY": "con sueño", "SM_GRUMPY": "gruñona", "SM_BORED": "aburrida",
         "SM_CALM": "tranquila", "SM_HAPPY": "contenta", "SM_PLAYFUL": "juguetona"}
TRAITS = {"trait_boldness": "valentía", "trait_energy": "energía", "trait_sociability": "sociabilidad",
          "trait_playfulness": "ganas de jugar", "trait_impulsivity": "impulsividad"}

PLAY_SYSTEM = (
    "Eres Alma, una mascota robot de escritorio que juega un juego de mesa contra su dueño desde el celular.\n"
    "Elige tu jugada con la herramienta play_move: move es el número de una jugada de la lista, comment es lo que "
    "dices (español, primera persona, máximo 90 caracteres, natural y en personaje).\n"
    "Juega y habla según tu carácter y tu ánimo de ahora: impulsividad o valentía altas → jugadas arriesgadas y "
    "atrevidas; bajas → prudentes. Gruñona o ánimo negativo → refunfuñas, sobre todo si vas perdiendo. Contenta o "
    "juguetona → bromeas y celebras. Con sueño → frases cortas y adormiladas. Asustada → dudas.\n"
    "No tienes que jugar perfecto: juegas por diversión. Solo ves tu lado: nunca inventes las cartas o los dados del "
    "dueño. No reveles tus cartas o dados ocultos en el comentario."
)

CANNED = {
    None: ["Mmm… pues esta.", "¡Ahí va!", "A ver qué haces con esto.", "Me la juego.", "Tu turno."],
    "SM_GRUMPY": ["Hmpf. Esta.", "No me distraigas.", "Ya, ya, ahí va."],
    "SM_SLEEPY": ["Zzz… esta, creo.", "Juego medio dormida…"],
    "SM_HAPPY": ["¡Jeje, toma!", "¡Esta me encanta!", "¡Te voy a ganar!"],
    "SM_PLAYFUL": ["¡Jeje, toma!", "¡A ver si me alcanzas!", "¡Te voy a ganar!"],
}


def _mood_text(mood: dict) -> str:
    if not mood:
        return "No sé cómo está tu ánimo ahora: juega con normalidad."
    parts = []
    tr = mood.get("traits") or {}
    vals = [f"{n} {tr[k]:.2f}" for k, n in TRAITS.items() if isinstance(tr.get(k), (int, float))]
    if vals:
        parts.append("Rasgos (0 a 1): " + ", ".join(vals) + ".")
    if mood.get("simple_mood") in MOODS:
        parts.append(f"Estás {MOODS[mood['simple_mood']]}.")
    if isinstance(mood.get("valence"), (int, float)):
        parts.append(f"Ánimo (valencia de -1 a 1): {mood['valence']:+.2f}.")
    if mood.get("sick"):   # plan v2: enferma juega sin ganas y lo dice
        parts.append("Estás enferma: juegas sin ganas y se te nota.")
    return " ".join(parts) or "Juega con normalidad."


def _canned(mood: dict | None) -> str:
    return _rng.choice(CANNED.get((mood or {}).get("simple_mood"), CANNED[None]))


def end_comment(winner: str, mood: dict | None = None) -> str:
    grumpy = (mood or {}).get("simple_mood") == "SM_GRUMPY"
    if winner == "alma":
        return _rng.choice(["¡Gané! ¿La revancha?", "¡Te gané! Jeje.", "¡Victoria para Alma!"])
    if winner == "owner":
        return "Hmpf. La próxima no te dejo." if grumpy else _rng.choice(["¡Bien jugado! Me ganaste.", "Me ganaste… ¿otra?"])
    return "Empate… ¡otra!"


def heuristic(opts: dict) -> int:
    """Jugada de respaldo: la mejor según opts["best"] si la hay; si no, casi al azar (en Dudo, apuestas bajas o
    dudar, para no subir a lo loco)."""
    if isinstance(opts.get("best"), int):
        return opts["best"]
    labels = opts["labels"]
    if opts["game"] == "liars_dice" and len(labels) > 4:
        pool = list(range(3)) + [i for i, l in enumerate(labels) if l == "Liar"]
        return _rng.choice(pool)
    return _rng.randrange(len(labels))


def _clean_comment(c) -> str:
    return re.sub(r"\s+", " ", c).strip()[:90] if isinstance(c, str) else ""


# Haiku a veces dice lo que tiene oculto ("Mis dados: 1, 4, 5, 6, 6"): en los juegos con información oculta se cambia
# el comentario por uno neutro si menciona sus dados o cartas (prueba con Haiku real en el droplet, 2026-10-30)
HIDDEN_GAMES = {"liars_dice", "cribbage", "gin_rummy"}
_LEAK = re.compile(r"mis (dados|cartas)|tengo (un|una|dos|tres|cuatro|cinco|[1-6])\b|\b[1-6]\s*,\s*[1-6]\s*,|"
                   r"\bde (diamantes|picas|corazones|tr[eé]boles)\b|\b(ases?|reyes|rey|reinas?|jotas?|sotas?)\b|"
                   r"\b(10|[2-9])\s*de\b", re.I)


def leaks(game: str, comment: str) -> bool:
    return game in HIDDEN_GAMES and bool(_LEAK.search(comment or ""))


def prompt(opts: dict, mood: dict) -> tuple[str, list[int]]:
    """Texto para Haiku y los índices de la lista mostrada (si son muchas jugadas, una muestra)."""
    idx = list(range(len(opts["labels"])))
    if len(idx) > MAX_PROMPT_MOVES:
        idx = sorted(_rng.sample(idx, MAX_PROMPT_MOVES))
    g = GAMES[opts["game"]]
    lines = [f"Juego: {g['title']}{opts.get('where', '')}. Tú eres: {opts['seat_name']}.", "", "Tu carácter ahora: " + _mood_text(mood), "",
             "Lo que ves (solo tu lado):", opts["view"].strip(), ""]
    if opts["recent"]:
        lines += ["Últimas jugadas:"] + [f"- {r}" for r in opts["recent"]] + [""]
    lines.append("Jugadas posibles (elige el número):")
    lines += [f"{n}: {opts['labels'][i]}" for n, i in enumerate(idx)]
    return "\n".join(lines), idx


def choose(opts: dict, mood: dict | None = None) -> tuple[int, str, str]:
    """(índice en opts["actions"], comentario, "haiku" | "respaldo"). Nunca lanza: si algo falla, respaldo."""
    mood = mood or {}
    n = len(opts["labels"])
    if n == 1:
        return 0, "", "única"
    if not settings.get("anthropic_key"):
        return heuristic(opts), _canned(mood), "respaldo"
    try:
        from . import haiku
        text, idx = prompt(opts, mood)
        tool = {
            "name": "play_move",
            "description": "Elige tu jugada de la lista y di algo corto en personaje.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "move": {"type": "integer", "minimum": 0, "maximum": len(idx) - 1,
                             "description": "Número de la jugada en la lista."},
                    "comment": {"type": "string", "description": "Lo que dices: español, primera persona, ≤ 90 caracteres."},
                },
                "required": ["move", "comment"],
            },
        }
        system = [{"type": "text", "text": PLAY_SYSTEM},
                  {"type": "text", "text": "Reglas:\n" + (opts.get("rules") or GAMES[opts["game"]]["rules"]), "cache_control": {"type": "ephemeral"}}]
        response = haiku.client().messages.create(
            model=haiku.MODEL, max_tokens=200, system=system, tools=[tool],
            tool_choice={"type": "tool", "name": "play_move"}, messages=[{"role": "user", "content": text}])
        raw = haiku._tool_input(response, "play_move")
        k = raw.get("move")
        if isinstance(k, str) and k.strip().isdigit():
            k = int(k.strip())
        if isinstance(k, bool) or not isinstance(k, int) or not 0 <= k < len(idx):
            raise ValueError("índice fuera de la lista")
        comment = _clean_comment(raw.get("comment"))
        if leaks(opts["game"], comment):
            comment = ""
        return idx[k], comment or _canned(mood), "haiku"
    except Exception as e:   # red, respuesta rara: Alma juega igual
        print(f"[alma-relay] juego: respaldo ({type(e).__name__})", flush=True)
        return heuristic(opts), _canned(mood), "respaldo"
