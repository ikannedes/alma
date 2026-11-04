"""Comida, peso y salud de Alma: los lleva el servidor (dueño, 2026-10-31, plan v2 aprobado: "sí, me encanta").

Antes el robot decidía todo (alma_care.c). Ahora el servidor lleva el hambre, las calorías, el peso, la enfermedad y
los gustos, y decide si acepta una comida (reglas + Haiku en personaje). Al robot le manda el resultado
({"t":"care_feed"}: animación, alegría, amistad) y su estado ({"t":"care_state"}: hambre, enferma, peso, energía) para
que lo viva: enferma no baila ni juega y camina como zombie, con sobrepeso se cansa, etc. El robot le cuenta cuánto
ejercicio hizo (campo "exercise" del estado) y los juegos de la app suman un poco.

Calorías y llenado son cosas distintas: los dulces engordan mucho y casi no llenan; la verdura llena y casi no engorda.
El peso sale del balance de varios días (lo que come menos lo que gasta), así que un día de muchos dulces se compensa
jugando. Solo corre cuando el robot tiene el firmware que lo entiende (estado con "care_v" >= 2); antes, la comida
sigue como estaba (el robot decide).
"""

import datetime as dt
import json
import os
import random
import re
import threading
import time

from . import settings

CARE_V = 2

# id, emoji, nombre, tipo, llena (baja el hambre), kcal, gusto de base, dulce, bebida
FOODS = [
    ("manzana", "🍎", "Manzana", "sana", 0.35, 70, 0.10, False, False),
    ("platano", "🍌", "Plátano", "sana", 0.40, 100, 0.10, False, False),
    ("zanahoria", "🥕", "Zanahoria", "sana", 0.30, 40, -0.10, False, False),
    ("brocoli", "🥦", "Brócoli", "sana", 0.35, 35, -0.30, False, False),
    ("sopa", "🍜", "Sopa", "normal", 0.50, 150, 0.00, False, False),
    ("sushi", "🍣", "Sushi", "normal", 0.55, 200, 0.10, False, False),
    ("pizza", "🍕", "Pizza", "chatarra", 0.70, 400, 0.40, False, False),
    ("hamburguesa", "🍔", "Hamburguesa", "chatarra", 0.75, 450, 0.35, False, False),
    ("tacos", "🌮", "Tacos", "chatarra", 0.70, 380, 0.35, False, False),
    ("galleta", "🍪", "Galleta", "dulce", 0.10, 150, 0.40, True, False),
    ("helado", "🍦", "Helado", "dulce", 0.10, 250, 0.50, True, False),
    ("pastel", "🍰", "Pastel", "dulce", 0.15, 320, 0.45, True, False),
    ("leche", "🥛", "Leche", "bebida", 0.20, 100, 0.00, False, True),
    ("jugo", "🧃", "Jugo", "dulce", 0.10, 120, 0.25, True, True),
    ("te", "🍵", "Té", "bebida", 0.05, 5, 0.00, False, True),
    ("medicina", "💊", "Medicina", "medicina", 0.0, 0, -0.60, False, True),
]
FOOD = {f[0]: dict(zip(("id", "emoji", "name", "kind", "fill", "kcal", "appeal", "sweet", "drink"), f)) for f in FOODS}
KIND_TAG = {"sana": "🥦 sana", "normal": "🍽️ normal", "chatarra": "🍕 llenadora", "dulce": "🍰 dulce",
            "bebida": "🥤 bebida", "medicina": "💊 medicina"}

# hambre (0 llena … 1 muerta de hambre); simulado con días completos (2026-10-31): unas 4 o 5 comidas al día
HUNGER_RISE_PER_H = 0.10      # × (0.8 + 0.4·energía); dormida × HUNGER_SLEEP_F; enferma × 0.5
HUNGER_SLEEP_F = 0.2          # dueño, 2026-11-01: de noche nadie le da de comer (12 h → +0.24)
NIGHT_HOURS = (20, 8)         # dueño, 2026-11-01: duerme de 20:00 a 8:00 (igual que el robot)
FULL_AT = 0.12                # llena: casi no acepta comida normal (las golosinas sí, a veces)
STARVING_AT = 0.95
STARVE_SICK_MIN = 120         # minutos muerta de hambre en el día → se enferma (débil)
# calorías y peso ("kg de Alma"; solo importa la zona)
KCAL_AWAKE_H, KCAL_ASLEEP_H = 28.0, 10.0     # ~470 al día sin ejercicio; un día sano (~600) + 20 min de baile: parejo
KCAL_PER_KG = 3000.0                          # un día de chatarra y dulces (~+800) → +0,27 kg
WEIGHT_START, HEALTHY = 5.0, (4.4, 5.6)
OBESE_AT = 6.5
# ejercicio que cuenta el robot (segundos por tipo de conducta) y kcal por minuto
EXERCISE_KCAL_MIN = {"dance": 6.0, "activity": 6.0, "routine": 3.0, "play": 3.0, "explore": 2.5, "juegos": 0.5,
                     "paseo": 3.0}   # paseo: los pasos del dueño con Alma en el reloj (PLAN-RELOJ-v2, 13)
EXERCISE_NAME = {"dance": "bailar", "activity": "actividades", "routine": "rutinas", "play": "jugar",
                 "explore": "explorar", "juegos": "juegos en la app", "paseo": "pasear contigo"}
# enfermedad
TREATS_BEFORE_SICK, SICK_P = 3, 0.5           # más golosinas en el día: empacho con probabilidad SICK_P
SICK_CURE_S = 24 * 3600.0                     # empacho o débil: se le pasa sola
# enfermarse "de la nada" (dueño, 2026-10-31): una vez por noche Haiku decide, con la propensión del momento (tristeza,
# hambre seguida, sobrepeso, poco ejercicio, dulces); nunca tan seguido ni tan estricto
ILL_MIN_P, ILL_MAX_P = 0.03, 0.35             # con menos riesgo ni se pregunta; tope de la propensión
ILL_COOLDOWN_DAYS = 7                         # días tranquilos después de una enfermedad
ILL_MAX_DAYS = 3
ILL_MED_LEFT_S = 6 * 3600.0                   # la medicina no la cura de golpe: le deja unas horas
FOOD_LIKE_LEARN = 0.03                        # comer con hambre algo que no le gusta: le gusta un poco más
STATE_RESEND_S = 300

_lock = threading.Lock()
_rng = random.Random()


# ---- almacén ----

def _path() -> str:
    return os.path.join(settings.data_dir(), "care.json")


def load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
    except (FileNotFoundError, ValueError):
        d = {}
    if not isinstance(d, dict):
        d = {}
    d.setdefault("hunger", 0.3)
    d.setdefault("weight", WEIGHT_START)
    d.setdefault("sick", None)            # {"since", "cause": empacho|debil|resfriado; las de días, "until" y "what"}
    d.setdefault("last_ill_until", 0.0)   # fin de la última enfermedad de días (para no repetir pronto)
    d.setdefault("likes", {})
    d.setdefault("likes_from", None)      # "robot" (importados) | "servidor" (nacieron aquí)
    d.setdefault("last_food", None)
    d.setdefault("streak", 0)
    d.setdefault("ticked", 0.0)
    d.setdefault("today", {})
    d.setdefault("days", [])              # resumen de días anteriores (para el diario), los últimos 14
    d.setdefault("robot_ex", {})          # últimos contadores de ejercicio del robot (para sacar la diferencia)
    d.setdefault("sent", {})              # último care_state mandado al robot
    return d


def _save(d: dict) -> None:
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, _path())


def _day(ts: float) -> str:
    from . import alarms
    return dt.datetime.fromtimestamp(ts, alarms.tz()).date().isoformat()


def _today(d: dict, now: float) -> dict:
    """Los contadores del día; al cambiar de día, el anterior pasa a "days"."""
    day = _day(now)
    t = d["today"]
    if t.get("date") != day:
        if t.get("date"):
            d["days"] = (d["days"] + [{**t, "weight": round(d["weight"], 2)}])[-14:]
        t = d["today"] = {"date": day, "kcal_in": 0.0, "kcal_out": 0.0, "treats": 0, "meals": 0, "refused": 0,
                          "starve_min": 0.0, "exercise_s": {}, "log": []}
    return t


def enabled(robot_state: dict | None) -> bool:
    return int((robot_state or {}).get("care_v") or 0) >= CARE_V


# ---- cálculos ----

def band(weight: float) -> str:
    if weight < HEALTHY[0]:
        return "bajo"
    if weight <= HEALTHY[1]:
        return "sano"
    return "sobrepeso" if weight < OBESE_AT else "obesidad"


def energy(d: dict) -> float:
    """Cuánta energía tiene para moverse (1 normal). El robot la usa para cuánto baila, juega y explora."""
    if d["sick"]:
        return 0.35
    e = 1.0
    w = d["weight"]
    if w > HEALTHY[1]:
        e -= min(0.45, (w - HEALTHY[1]) * 0.4)
    elif w < HEALTHY[0]:
        e -= min(0.3, (HEALTHY[0] - w) * 0.4)
    if d["hunger"] > 0.8:
        e *= 0.8
    ex_min = sum((d["today"].get("exercise_s") or {}).values()) / 60
    if band(w) == "sano" and ex_min >= 30:
        e += 0.1   # en forma
    return round(max(0.2, min(1.2, e)), 2)


def _like(d: dict, food: str) -> float:
    if food not in d["likes"]:
        d["likes"][food] = round(max(-1.0, min(1.0, FOOD[food]["appeal"] + 1.2 * (_rng.random() - 0.5))), 3)
        d["likes"]["medicina"] = -0.6
        d["likes_from"] = d["likes_from"] or "servidor"
    return d["likes"][food]


def _burn(d: dict, kcal: float) -> None:
    _today(d, d["ticked"] or time.time())["kcal_out"] += kcal
    d["weight"] -= kcal / KCAL_PER_KG   # sin redondear: cada estado (5 s) mueve muy poco


def _make_sick(d: dict, cause: str, now: float) -> None:
    if not d["sick"]:
        d["sick"] = {"since": now, "cause": cause}


def is_night(now: float) -> bool:
    """De 20:00 a 8:00 en la zona del dueño: cuenta como dormida aunque el robot aún vaya camino a la base."""
    from . import alarms
    h = dt.datetime.fromtimestamp(now, alarms.tz()).hour
    return h >= NIGHT_HOURS[0] or h < NIGHT_HOURS[1]


def tick(d: dict, robot_state: dict, now: float) -> None:
    """Pasa el tiempo (solo mientras el robot está conectado: el estado llega cada 5 s; un hueco largo no cuenta)."""
    dt_s = max(0.0, min(60.0, now - (d["ticked"] or now)))
    d["ticked"] = now
    t = _today(d, now)
    if not dt_s:
        return
    asleep = robot_state.get("state") == "ST_SLEEPING" or is_night(now)
    tr = (robot_state.get("traits") or {}).get("trait_energy", 0.5)
    k = HUNGER_RISE_PER_H * (0.8 + 0.4 * (tr if isinstance(tr, (int, float)) else 0.5))
    if asleep:
        k *= HUNGER_SLEEP_F
    if d["sick"]:
        k *= 0.5
    d["hunger"] = min(1.0, d["hunger"] + k * dt_s / 3600)
    _burn(d, (KCAL_ASLEEP_H if asleep else KCAL_AWAKE_H) * dt_s / 3600)
    if d["hunger"] >= STARVING_AT and not asleep:   # dormida no cuenta como pasar hambre
        t["starve_min"] += dt_s / 60
        if t["starve_min"] >= STARVE_SICK_MIN:
            _make_sick(d, "debil", now)
    sick = d["sick"]
    if sick and now > (sick.get("until") or sick["since"] + SICK_CURE_S):
        d["sick"] = None   # se le pasó sola


def robot_exercise(d: dict, counters: dict, now: float) -> None:
    """counters: segundos acumulados por tipo desde que arrancó el robot; se suma la diferencia."""
    if not isinstance(counters, dict):
        return
    t = _today(d, now)
    for kind, secs in counters.items():
        if kind not in EXERCISE_KCAL_MIN or not isinstance(secs, (int, float)):
            continue
        prev = d["robot_ex"].get(kind, 0)
        add = secs - prev if secs >= prev else secs   # bajó: el robot se reinició
        d["robot_ex"][kind] = secs
        if 0 < add < 3600:
            t["exercise_s"][kind] = t["exercise_s"].get(kind, 0) + add
            _burn(d, EXERCISE_KCAL_MIN[kind] * add / 60)


def import_robot(d: dict, payload: dict) -> bool:
    """Una sola vez: los gustos (y el hambre y si estaba enferma) que traía el robot, para que no "renazca"."""
    if d["likes_from"] == "robot":
        return False
    likes = payload.get("likes") or {}
    d["likes"] = {k: round(max(-1.0, min(1.0, float(v))), 3) for k, v in likes.items()
                  if k in FOOD and isinstance(v, (int, float))}
    if isinstance(payload.get("hunger"), (int, float)) and 0 <= payload["hunger"] <= 1:
        d["hunger"] = payload["hunger"]
    if payload.get("sick"):
        d["sick"] = {"since": time.time(), "cause": "empacho"}
    d["likes_from"] = "robot"
    return True


def import_payload(payload: dict) -> bool:
    with _lock:
        d = load()
        ok = import_robot(d, payload)
        _save(d)
        return ok


def accept_p(d: dict, food: str, robot_state: dict) -> float:
    """Qué tan probable es que acepte (las mismas reglas que tenía el robot, con la tendencia del día)."""
    f, h, like = FOOD[food], d["hunger"], _like(d, food)
    p = 0.15 + 0.7 * h + 0.35 * like
    if h < FULL_AT and not f["sweet"]:
        p *= 0.3
    if f["sweet"]:
        p += 0.25 * (1.0 - h)
    if food == d["last_food"] and d["streak"] >= 2:
        p -= 0.3
    if robot_state.get("simple_mood") == "SM_GRUMPY":
        p -= 0.25
    if d["sick"] and d["sick"]["cause"] != "debil" and not f["drink"]:
        p -= 0.15   # empachada o enferma: sin ganas (débil de hambre, en cambio, come)
    v = robot_state.get("valence")
    if isinstance(v, (int, float)):
        p += 0.1 * v
    return max(0.03, min(0.97, p))


def why_refused(d: dict, food: str) -> str:
    f, like = FOOD[food], d["likes"].get(food, 0)
    if d["hunger"] < FULL_AT and not f["sweet"]:
        return "llena"
    if food == d["last_food"] and d["streak"] >= 2:
        return "otra_vez_lo_mismo"
    if d["sick"] and d["sick"]["cause"] != "debil" and not f["drink"]:
        return "enferma"
    return "no_le_gusta" if like < -0.2 else "berrinche"


# ---- Haiku decide en personaje (solo en los casos dudosos) ----

FEED_SYSTEM = (
    "Eres Alma, una mascota robot de escritorio. Tu dueño te ofrece algo de comer desde su celular. Decide con la "
    "herramienta decide_food si lo aceptas (accept) y di algo corto en personaje (comment: español, primera persona, "
    "máximo 90 caracteres, natural; sin emojis). Decide según tu hambre, si te gusta, lo que ya comiste hoy, cómo te "
    "sientes y tu carácter: impulsiva → caprichos; gruñona → refunfuñas; enferma → sin ganas. La tendencia (0 a 1) "
    "es qué tan probable es que lo aceptes: respétala a grandes rasgos. Si lo aceptas sin que te guste, puedes "
    "comerlo de mala gana; si es dulce y estás llena, se vale el antojo."
)


def _haiku_decide(ctx: str) -> tuple[bool, str] | None:
    if not settings.get("anthropic_key"):
        return None
    try:
        from . import haiku
        tool = {"name": "decide_food", "description": "Acepta o rechaza la comida y di algo corto.",
                "input_schema": {"type": "object", "properties": {
                    "accept": {"type": "boolean"},
                    "comment": {"type": "string", "description": "Español, primera persona, ≤ 90 caracteres."}},
                    "required": ["accept", "comment"]}}
        r = haiku.client().messages.create(
            model=haiku.MODEL, max_tokens=150, system=[{"type": "text", "text": FEED_SYSTEM + "\n" + haiku.ESTILO}], tools=[tool],
            tool_choice={"type": "tool", "name": "decide_food"}, messages=[{"role": "user", "content": ctx}])
        raw = haiku._tool_input(r, "decide_food")
        if not isinstance(raw.get("accept"), bool):
            raise ValueError("accept no es booleano")
        c = re.sub(r"\s+", " ", raw.get("comment") or "").strip()[:90]
        return raw["accept"], c
    except Exception as e:   # red, respuesta rara: deciden los dados
        print(f"[alma-relay] comida: respaldo ({type(e).__name__})", flush=True)
        return None


def _context(d: dict, food: str, p: float, robot_state: dict) -> str:
    from . import games
    f, like, t = FOOD[food], d["likes"].get(food, 0), d["today"]
    eaten = ", ".join(x["food"] for x in t.get("log", [])[-6:] if x.get("ok")) or "nada"
    lines = [f"Te ofrecen: {f['name']} ({KIND_TAG[f['kind']]}).",
             f"Cuánto te gusta (-1 a 1): {like:+.2f}.",
             f"Hambre (0 llena, 1 muerta de hambre): {d['hunger']:.2f}." + (" Estás llena." if d["hunger"] < FULL_AT else ""),
             f"Peso: {band(d['weight'])}. Golosinas hoy: {t.get('treats', 0)}.",
             f"Hoy ya comiste: {eaten}."]
    if d["sick"]:
        lines.append(f"Estás enferma ({d['sick']['cause']}).")
    lines += ["Tu carácter ahora: " + games._mood_text(robot_state), f"Tendencia a aceptarlo: {p:.2f}."]
    return "\n".join(lines)


CANNED = {"eat": ["¡Ñam!", "Gracias.", "Mmm, rico."], "love": ["¡Me encanta!", "¡Ñam ñam ñam!"],
          "meh": ["Bueno… va.", "Si no hay de otra…"], "refuse": ["No, gracias.", "Hmpf, no."],
          "full": ["Ya estoy llena.", "No me cabe nada."], "medicine": ["Guácala… pero bueno."]}


# ---- dar de comer ----

def feed(food: str, robot_state: dict, now: float | None = None, use_haiku: bool = True) -> dict:
    """Decide y aplica. Devuelve el resultado para la app y el mensaje care_feed para el robot."""
    now = now or time.time()
    with _lock:
        d = load()
        t = _today(d, now)
        f = FOOD[food]
        res = {"food": food, "accepted": False, "why": "ok", "comment": "", "src": "reglas", "got_sick": False,
               "joy": 0.0, "bond": 0.0, "frust": 0.0}
        if food == "medicina":
            if not d["sick"]:
                res.update(why="no_esta_enferma", frust=0.05, comment=_rng.choice(CANNED["refuse"]))
            elif d["sick"].get("until"):   # enfermedad de días: la alivia, pero le quedan unas horas
                d["sick"]["until"] = min(d["sick"]["until"], now + ILL_MED_LEFT_S)
                res.update(accepted=True, why="medicina_alivia", joy=-0.2, comment=_rng.choice(CANNED["medicine"]))
            else:
                d["sick"] = None
                res.update(accepted=True, why="medicina", joy=-0.2, comment=_rng.choice(CANNED["medicine"]))
        else:
            p = accept_p(d, food, robot_state)
            decided = None
            if use_haiku and 0.1 < p < 0.9:
                decided = _haiku_decide(_context(d, food, p, robot_state))
            if decided is not None:
                ok, res["comment"] = decided
                res["src"] = "haiku"
            else:
                imp = (robot_state.get("traits") or {}).get("trait_impulsivity", 0.5)
                ok = _rng.random() < max(0.03, min(0.97, p + (_rng.random() - 0.5) * 0.3 * (imp if isinstance(imp, (int, float)) else 0.5)))
            like = d["likes"][food]
            if not ok:
                res.update(why=why_refused(d, food), frust=0.1)
                res["comment"] = res["comment"] or _rng.choice(CANNED["full" if res["why"] == "llena" else "refuse"])
                t["refused"] += 1
            else:
                res.update(accepted=True, why="le_encanta" if like > 0.5 else "de_mala_gana" if like < -0.2 else "ok")
                if not res["comment"]:
                    res["comment"] = _rng.choice(CANNED["love" if like > 0.5 else "meh" if like < -0.2 else "eat"])
                h = d["hunger"]
                # al momento: lo que le gusta la alegra (más si es dulce); lo que no, la desanima un poco
                res["joy"] = round(0.15 + 0.25 * like + (0.1 if f["sweet"] else 0) if like >= 0 else 0.25 * like, 3)
                res["bond"] = 0.01 if like > 0.5 else -0.01 if like < -0.2 else 0.0
                d["hunger"] = max(0.0, h - f["fill"])
                t["kcal_in"] += f["kcal"]
                d["weight"] += f["kcal"] / KCAL_PER_KG
                if h > 0.4:
                    t["meals"] += 1
                    if like < 0.5:   # el hambre enseña
                        d["likes"][food] = round(min(1.0, like + FOOD_LIKE_LEARN), 3)
                d["streak"] = d["streak"] + 1 if food == d["last_food"] else 1
                d["last_food"] = food
                if d["sick"] and d["sick"]["cause"] == "debil" and d["hunger"] < 0.5:
                    d["sick"] = None   # débil de hambre: comiendo bien se le pasa
                if f["sweet"]:
                    t["treats"] += 1
                    if t["treats"] > TREATS_BEFORE_SICK and not d["sick"] and _rng.random() < SICK_P:
                        _make_sick(d, "empacho", now)
                        res["got_sick"] = True
        t["log"] = (t["log"] + [{"at": int(now), "food": f["name"], "ok": res["accepted"], "why": res["why"]}])[-40:]
        _save(d)
        res["anim"] = ("drink" if f["drink"] else "eat") if res["accepted"] else "refuse"
        res["state"] = snapshot(d)
        return res


def robot_feed_msg(res: dict) -> dict:
    return {**robot_state_msg(res["state"]), "t": "care_feed", "food": res["food"], "accepted": res["accepted"],
            "anim": res["anim"], "joy": res["joy"], "bond": res["bond"], "frust": res["frust"], "got_sick": res["got_sick"]}


def _hours_left(d: dict) -> int | None:
    until = (d["sick"] or {}).get("until")
    return round(max(0.0, until - time.time()) / 3600) if until else None


def snapshot(d: dict | None = None) -> dict:
    d = d or load()
    t = d["today"] or {}
    ex = t.get("exercise_s") or {}
    return {"hunger": round(d["hunger"], 3), "weight": round(d["weight"], 2), "band": band(d["weight"]),
            "healthy": list(HEALTHY), "sick": bool(d["sick"]), "cause": (d["sick"] or {}).get("cause"),
            "what": (d["sick"] or {}).get("what"), "sick_hours_left": _hours_left(d),
            "energy": energy(d), "kcal_in": round(t.get("kcal_in", 0)), "kcal_out": round(t.get("kcal_out", 0)),
            "treats": t.get("treats", 0), "exercise_min": round(sum(ex.values()) / 60),
            "exercise": {EXERCISE_NAME.get(k, k): round(v / 60) for k, v in ex.items() if v >= 30},
            "log": (t.get("log") or [])[-8:]}


def robot_state_msg(s: dict) -> dict:
    return {"t": "care_state", "hunger": s["hunger"], "sick": s["sick"], "cause": s["cause"] or "",
            "weight_band": s["band"], "energy": s["energy"]}


def on_robot_state(robot_state: dict, now: float | None = None) -> dict | None:
    """Cada estado del robot (cada 5 s): pasa el tiempo, suma su ejercicio y, si cambió algo que el robot deba
    vivir (o pasaron 5 min), devuelve el care_state para mandarle."""
    now = now or time.time()
    with _lock:
        d = load()
        was_sick = bool(d["sick"])
        tick(d, robot_state, now)
        robot_exercise(d, robot_state.get("exercise"), now)
        msg = robot_state_msg(snapshot(d))
        last = d["sent"]
        changed = (not last or last.get("sick") != msg["sick"] or last.get("weight_band") != msg["weight_band"]
                   or abs(last.get("hunger", 0) - msg["hunger"]) >= 0.05 or abs(last.get("energy", 1) - msg["energy"]) >= 0.05
                   or now - last.get("at", 0) >= STATE_RESEND_S)
        if changed:
            d["sent"] = {**msg, "at": now}
        _save(d)
        if msg["sick"] and not was_sick:
            msg["got_sick"] = True
        sick = d["sick"] or {}
        if sick.get("announce") and robot_state.get("state") != "ST_SLEEPING":   # amaneció enferma: avisa al despertar
            sick.pop("announce")
            _save(d)
            msg["got_sick"], changed = True, True
        if msg.get("got_sick"):
            msg["what"] = sick.get("what") or ""
        return msg if changed else None


def add_exercise(kind: str, seconds: float, now: float | None = None) -> None:
    """Ejercicio que no viene del robot (los juegos de la app: casi no se mueve, pero algo cuenta)."""
    now = now or time.time()
    with _lock:
        d = load()
        ex = _today(d, now)["exercise_s"]
        ex[kind] = ex.get(kind, 0) + seconds
        _burn(d, EXERCISE_KCAL_MIN.get(kind, 0) * seconds / 60)
        _save(d)


def day_summary(now: float | None = None) -> str:
    """Para el diario nocturno: cómo comió, se movió y se sintió hoy."""
    d = load()
    t = d["today"] or {}
    if not t.get("log") and not t.get("exercise_s") and d["days"]:
        t = d["days"][-1]   # el pase nocturno es de madrugada: ya cambió el día
    if not t.get("log") and not t.get("exercise_s"):
        return ""
    ate = [x["food"] for x in t.get("log", []) if x.get("ok")]
    refused = [x["food"] for x in t.get("log", []) if not x.get("ok")]
    ex_min = round(sum((t.get("exercise_s") or {}).values()) / 60)
    parts = [f"Comió: {', '.join(ate) or 'nada'}."]
    if refused:
        parts.append(f"Rechazó: {', '.join(refused)}.")
    parts.append(f"Calorías: {round(t.get('kcal_in', 0))} entraron, {round(t.get('kcal_out', 0))} gastó. "
                 f"Peso: {band(d['weight'])}. Ejercicio: {ex_min} min.")
    if d["sick"]:
        parts.append(f"Está enferma ({d['sick']['cause']}).")
    return " ".join(parts)


# ---- enfermarse "de la nada" (dueño, 2026-10-31): Haiku decide una vez por noche, con propensión ----

ILL_SYSTEM = (
    "Eres quien cuida la salud de Alma, una mascota robot de escritorio. Una vez por noche decides si mañana amanece "
    "enferma de algo leve (un resfriado, una gripita, dolor de panza…) y cuántos días le dura (1 a 3). No seas estricto "
    "ni cruel: la gran mayoría de los días NO se enferma. La propensión (0 a 1) es la probabilidad aproximada de hoy y "
    "sale de cómo ha estado (triste, con hambre seguido, con sobrepeso, sin ejercicio, muchos dulces): úsala como guía. "
    "Contesta con la herramienta decide_illness: sick, what (2–4 palabras en español, algo leve), days y note (una "
    "frase corta de por qué, para su diario)."
)


def illness_risk(d: dict, robot_state: dict) -> tuple[float, list[str]]:
    """Propensión de hoy a amanecer enferma y por qué."""
    p, why = 0.02, []
    wb = robot_state.get("wellbeing")
    if isinstance(wb, (int, float)) and wb < 0:
        p += 0.04 + 0.04 * min(1.0, -wb / 500)
        why.append("anda triste (bienestar bajo)")
    v = robot_state.get("valence")
    if isinstance(v, (int, float)) and v < -0.3:
        p += 0.03
        why.append("ánimo bajo hoy")
    week = d["days"][-7:]
    hungry_days = sum(1 for x in week if x.get("starve_min", 0) >= 30)
    if hungry_days:
        p += min(0.12, 0.03 * hungry_days)
        why.append(f"pasó hambre {hungry_days} día(s) esta semana")
    b = band(d["weight"])
    if b != "sano":
        p += 0.08 if b == "obesidad" else 0.04
        why.append("está bajo de peso" if b == "bajo" else f"tiene {b}")
    last3 = week[-3:]
    if len(last3) >= 2 and sum(sum((x.get("exercise_s") or {}).values()) for x in last3) / 60 / len(last3) < 10:
        p += 0.03
        why.append("casi no ha hecho ejercicio")
    if week and week[-1].get("treats", 0) > TREATS_BEFORE_SICK:
        p += 0.02
        why.append("ayer comió muchos dulces")
    return min(ILL_MAX_P, p), why


def _haiku_illness(p: float, why: list[str]) -> dict | None:
    if not settings.get("anthropic_key"):
        return None
    try:
        from . import haiku
        tool = {"name": "decide_illness", "description": "Decide si mañana amanece enferma (algo leve) y cuánto le dura.",
                "input_schema": {"type": "object", "properties": {
                    "sick": {"type": "boolean"}, "what": {"type": "string"},
                    "days": {"type": "integer", "minimum": 1, "maximum": ILL_MAX_DAYS}, "note": {"type": "string"}},
                    "required": ["sick", "what", "days", "note"]}}
        text = f"Propensión de hoy: {p:.2f}.\nPor qué: " + ("; ".join(why) or "nada en especial") + "."
        r = haiku.client().messages.create(
            model=haiku.MODEL, max_tokens=150, system=[{"type": "text", "text": ILL_SYSTEM + "\n" + haiku.ESTILO}], tools=[tool],
            tool_choice={"type": "tool", "name": "decide_illness"}, messages=[{"role": "user", "content": text}])
        raw = haiku._tool_input(r, "decide_illness")
        if not isinstance(raw.get("sick"), bool):
            raise ValueError("sick no es booleano")
        return raw
    except Exception as e:   # red, respuesta rara: deciden los dados con la misma propensión
        print(f"[alma-relay] enfermedad: respaldo ({type(e).__name__})", flush=True)
        return None


def nightly(robot_state: dict, now: float | None = None, use_haiku: bool = True) -> dict:
    """Lo llama el pase nocturno: ¿mañana amanece enferma? Queda en el estado; el aviso sale cuando despierte."""
    now = now or time.time()
    with _lock:
        d = load()
        p, why = illness_risk(d, robot_state)
        out = {"risk": round(p, 3), "why": why, "sick": False, "src": "reglas"}
        if d["sick"] or now < d["last_ill_until"] + ILL_COOLDOWN_DAYS * 86400 or p < ILL_MIN_P:
            return out
        raw = _haiku_illness(p, why) if use_haiku else None
        if raw is None:
            raw = {"sick": _rng.random() < p, "what": "un resfriado", "days": 1 + int(_rng.random() * 2), "note": ""}
        else:
            out["src"] = "haiku"
        if not raw["sick"]:
            return out
        days = max(1, min(ILL_MAX_DAYS, int(raw.get("days") or 1)))
        what = re.sub(r"\s+", " ", str(raw.get("what") or "un resfriado")).strip()[:40]
        until = now + days * 86400
        d["sick"] = {"since": now, "cause": "resfriado", "until": until, "what": what, "announce": True,
                     "note": str(raw.get("note") or "")[:200]}
        d["last_ill_until"] = until
        _save(d)
        return {**out, "sick": True, "what": what, "days": days}
