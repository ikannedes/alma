"""Trucos de Alma (dueño, 2026-11-01: "como aibo", sin tope: "que sean infinitos pero que si no se practican se vayan
olvidando"). El servidor decide todo (qué intenta, si obedece, cuánto aprende y cuándo olvida); el robot solo hace el
movimiento que se le pide: {"t":"trick","mot","req"} → {"t":"trick_result","req","done","why"}.

Enseñar: el dueño abre una clase con un nombre ("gatito"); Alma intenta un movimiento de su catálogo; 👍 lo une al
nombre (más con premio), 👎 la hace probar otro. Con fuerza ≥ LEARNED lo aprendió (hito). Pedirlo: obedece según
qué tan bien lo sabe y su ánimo; a veces se equivoca o no quiere. Practicar con 👍 lo refuerza; sin práctica, después
de GRACE_DAYS se le va olvidando y, por debajo de FORGET, lo olvida (aviso). Dominado (≥ MASTERED en 3 días distintos):
se olvida mucho más lento. Lo que limita cuántos trucos aprende es el catálogo de movimientos, que crecerá.
"""

import datetime as dt
import json
import os
import random
import threading
import time
import unicodedata

from . import settings

# movimiento (.mot del robot, con su cara y su sonido) → cómo se ve
MOVES = {
    "Cat": "🐱 hace de gatito", "Dog": "🐶 hace de perrito", "Chicken": "🐔 hace de gallina", "Frog": "🐸 hace de rana",
    "Elephant": "🐘 hace de elefante", "Cattle": "🐮 hace de vaca", "Cuckoo": "🐦 hace de cucú",
    "d1_EmoDance": "💃 baile EMO", "d2_WontLetGo": "💃 baile lento", "d3_Blindless": "💃 baile movido",
    "d4_Click1": "💃 baile de clic", "d5_TimeOfMyLife": "💃 baile de fiesta", "d7_FlashBack": "💃 baile retro",
    "jump_up": "⬆️ salta", "parkour": "🤸 parkour", "balance_ball": "⚽ equilibrio con pelota",
    "laser_eye": "🔴 ojos láser", "laser_eye_2": "🔴 ojos láser 2", "interact_emotion_heart": "❤️ corazón",
    "interact_emotion_hug": "🤗 abrazo", "interact_emotion_kiss1": "😘 beso", "Byebye": "👋 adiós",
    "Good_morning": "☀️ buenos días", "Good_night": "🌙 buenas noches", "sings1_1": "🎵 canta", "sings2_1": "🎶 canta otra",
    "EMO_volcano_1": "🌋 volcán", "EMO_flower_1": "🌸 flor", "positive_2": "👍 dice que sí",
    "negative_1": "👎 dice que no", "react_depressed": "😩 drama", "want_petting": "🥺 pide caricias",
}   # = las opciones de bhv_trick en catalog/catalog.json (tope del robot: 32 por conducta; crecerá con movimientos nuevos)
# trucos que ya vienen aprendidos (dueño, 2026-11-03: "que ya exista, que ya esté entrenado"): no se enseñan ni se
# olvidan y, si está para trucos, siempre obedece. Su movimiento no es del catálogo: el robot lo hace aparte (app.c)
FIJOS = {"darth vader": {"label": "Darth Vader", "mot": "vader",
                         "move": "🖤 Darth Vader: aparece la boca, suena la marcha imperial y camina al frente"}}
FIJO_DESDE = 1793577600.0       # 2026-11-02
LEARNED, MASTERED, FORGET = 0.5, 0.9, 0.12
GRACE_DAYS = 7                  # sin practicar este tiempo, empieza a olvidar
DECAY, DECAY_MASTERED = 0.03, 0.01   # por día después de la gracia
LESSON_IDLE_S = 15 * 60
MOOD = {"SM_PLAYFUL": 1.1, "SM_HAPPY": 1.0, "SM_CALM": 0.9, "SM_BORED": 0.8, "SM_SLEEPY": 0.5, "SM_GRUMPY": 0.4,
        "SM_SCARED": 0.3}
_lock = threading.Lock()
rng = random.Random()           # las pruebas lo siembran


def _path() -> str:
    return os.path.join(settings.data_dir(), "tricks.json")


def _load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
        d = d if isinstance(d, dict) else {}
    except (FileNotFoundError, ValueError):
        d = {}
    for n, f in FIJOS.items():
        d.setdefault("tricks", {}).setdefault(n, {"label": f["label"], "mot": f["mot"], "strength": 1.0,
                                                  "last_practice": FIJO_DESDE, "days": [], "learned_at": FIJO_DESDE,
                                                  "mastered": True, "times": 0, "fijo": True})
    return d


def _move(mot: str) -> str:
    return MOVES.get(mot) or next((f["move"] for f in FIJOS.values() if f["mot"] == mot), mot)


def _save(d: dict) -> None:
    with open(_path() + ".tmp", "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(_path() + ".tmp", _path())


def norm(name: str) -> str:
    s = unicodedata.normalize("NFD", str(name).strip().lower())
    return " ".join("".join(c for c in s if unicodedata.category(c) != "Mn").split())[:40]


def _day(now: float) -> str:
    from . import alarms
    return dt.datetime.fromtimestamp(now, alarms.tz()).date().isoformat()


def strength(t: dict, now: float) -> float:
    """La fuerza de ahora: la guardada menos lo que olvidó desde la última práctica."""
    if t.get("fijo"):
        return 1.0
    idle = (now - t["last_practice"]) / 86400 - GRACE_DAYS
    rate = DECAY_MASTERED if t.get("mastered") else DECAY
    return max(0.0, t["strength"] - rate * max(0.0, idle))


def _traits(st: dict) -> dict:
    return {k: float(v) for k, v in (st.get("traits") or {}).items() if isinstance(v, (int, float))}


def willing(st: dict) -> tuple[bool, str]:
    """¿Está para trucos? Dormida, enferma, en un reflejo o escuchando, no."""
    s = st.get("state")
    if s == "ST_SLEEPING":
        return False, "está dormida"
    if s in ("ST_REFLEX", "ST_LISTENING", "ST_BOOT"):
        return False, "está ocupada"
    if st.get("sick"):
        return False, "está enferma"
    return True, ""


def _free_moves(d: dict, skip: list[str]) -> list[str]:
    used = {t["mot"] for t in d.get("tricks", {}).values()}
    free = [m for m in MOVES if m not in used and m not in skip]
    return free or [m for m in MOVES if m not in skip] or list(MOVES)


def lesson_start(name: str, now: float | None = None) -> dict:
    now = now if now is not None else time.time()
    n = norm(name)
    if not n:
        return {"error": "ponle un nombre al truco"}
    if n in FIJOS:
        return {"error": "ese truco ya lo sabe"}
    with _lock:
        d = _load()
        d["lesson"] = {"name": n, "label": str(name).strip()[:40], "tried": [], "current": None, "at": now}
        _save(d)
    return {"lesson": d["lesson"]}


def lesson_try(st: dict, now: float | None = None) -> dict:
    """Qué intenta ahora en la clase: lo que ya une al nombre (si lo sabe) o algo nuevo. No guarda: lesson_did()."""
    now = now if now is not None else time.time()
    d = _load()
    les = d.get("lesson")
    if not les or now - les["at"] > LESSON_IDLE_S:
        return {"error": "no hay clase abierta"}
    ok, why = willing(st)
    if not ok:
        return {"error": f"ahora no: {why}"}
    t = d.get("tricks", {}).get(les["name"])
    imp = _traits(st).get("trait_impulsivity", 0.3)
    if t and rng.random() < strength(t, now) and rng.random() >= 0.3 * imp:   # impulsiva: a veces hace otra cosa
        return {"mot": t["mot"], "label": MOVES.get(t["mot"], t["mot"])}
    m = rng.choice(_free_moves(d, les["tried"] + ([t["mot"]] if t else [])))
    return {"mot": m, "label": MOVES[m]}


def lesson_did(mot: str, now: float | None = None) -> None:
    with _lock:
        d = _load()
        if les := d.get("lesson"):
            les.update(current=mot, at=now if now is not None else time.time())
            _save(d)


def lesson_answer(answer: str, st: dict, treat_ok: bool = False, now: float | None = None) -> dict:
    """answer: "si" (¡eso!), "no" (otro) o "premio" (si con golosina; treat_ok: si se la comió). Devuelve el truco."""
    now = now if now is not None else time.time()
    tr = _traits(st)
    with _lock:
        d = _load()
        les = d.get("lesson")
        if not les or not les.get("current"):
            return {"error": "primero que intente algo"}
        tricks = d.setdefault("tricks", {})
        t = tricks.get(les["name"])
        mot, les["at"] = les["current"], now
        les["current"] = None
        if answer == "no":
            les["tried"] = (les["tried"] + [mot])[-len(MOVES):]
            if t and t["mot"] == mot:
                t["strength"] = max(0.0, strength(t, now) - 0.15)
                t["last_practice"] = now
                if t["strength"] < 0.05 and not t.get("learned_at"):
                    tricks.pop(les["name"])      # lo desaprende: el movimiento no era ese
                    t = None
            _save(d)
            return {"trick": _view(les["name"], t, now) if t else None, "learned": False}
        if not t or t["mot"] != mot:
            t = tricks[les["name"]] = {"label": les["label"], "mot": mot, "strength": 0.0, "last_practice": now,
                                       "days": [], "learned_at": None, "mastered": False, "times": 0}
        gain = 0.18 + 0.17 * tr.get("trait_playfulness", 0.4) + 0.08 * tr.get("trait_sociability", 0.4)
        gain *= 1.5 if (answer == "premio" and treat_ok) else 1.0
        new = _practice(t, gain, now)
        if new:
            d.pop("lesson", None)                # aprendido: termina la clase
        _save(d)
    if new:
        _hito(les["name"], t, new, now)
    return {"trick": _view(les["name"], t, now), "learned": new == "learned", "mastered": new == "mastered"}


def _practice(t: dict, gain: float, now: float) -> str | None:
    """Refuerzo con 👍; devuelve "learned"/"mastered" si cruzó un umbral."""
    t["strength"] = min(1.0, strength(t, now) + gain)
    t["last_practice"] = now
    t["days"] = sorted(set(t.get("days", [])) | {_day(now)})[-10:]
    t["times"] = t.get("times", 0) + 1
    if not t.get("learned_at") and t["strength"] >= LEARNED:
        t["learned_at"] = now
        return "learned"
    if t.get("learned_at") and not t.get("mastered") and t["strength"] >= MASTERED and len(t["days"]) >= 3:
        t["mastered"] = True
        return "mastered"
    return None


def _hito(name: str, t: dict, what: str, now: float) -> None:
    from . import milestones
    label = MOVES.get(t["mot"], "")
    if what == "learned":
        milestones.learned(f"truco_{name}", f"Alma aprendió «{t['label']}»", f"Cuando se lo pides: {label}.", "🎓", now)
    else:
        milestones.learned(f"truco_{name}_dominado", f"Alma domina «{t['label']}»", "Ya no se le olvida fácil.", "🏅", now)


def remove(name: str) -> bool:
    """El dueño se lo quita (los FIJOS no)."""
    if norm(name) in FIJOS:
        return False
    with _lock:
        d = _load()
        ok = d.get("tricks", {}).pop(norm(name), None) is not None
        if ok:
            _save(d)
    return ok


def lesson_end() -> None:
    with _lock:
        d = _load()
        d.pop("lesson", None)
        _save(d)


def perform(name: str, st: dict, now: float | None = None) -> dict:
    """Se lo pides: lo hace bien, se equivoca o no quiere. Devuelve {"mot","label","outcome"} o {"error"}."""
    now = now if now is not None else time.time()
    d = _load()
    t = d.get("tricks", {}).get(norm(name))
    if not t or not t.get("learned_at"):
        return {"error": "ese truco todavía no lo sabe"}
    ok, why = willing(st)
    if not ok:
        return {"error": f"ahora no: {why}"}
    s = strength(t, now)
    p = 1.0 if t.get("fijo") else min(1.0, s * MOOD.get(st.get("simple_mood"), 0.9))
    if rng.random() < p:
        return {"mot": t["mot"], "label": _move(t["mot"]), "outcome": "bien"}
    if rng.random() < 0.5 + 0.5 * (1 - s):        # cuanto menos lo sabe, más se equivoca en vez de negarse
        m = rng.choice([x for x in MOVES if x != t["mot"]])
        return {"mot": m, "label": MOVES[m], "outcome": "equivocada"}
    return {"outcome": "no_quiere"}


def praise(name: str, now: float | None = None) -> dict:
    """👍 después de que lo hizo bien: cuenta como práctica."""
    now = now if now is not None else time.time()
    with _lock:
        d = _load()
        t = d.get("tricks", {}).get(norm(name))
        if not t:
            return {"error": "no existe"}
        new = _practice(t, 0.06, now)
        _save(d)
    if new:
        _hito(norm(name), t, new, now)
    return {"trick": _view(norm(name), t, now)}


def forget_due(now: float | None = None) -> list[str]:
    """Los que ya olvidó (sin práctica): se borran y avisan. Lo llama el ciclo del servidor."""
    now = now if now is not None else time.time()
    with _lock:
        d = _load()
        gone = [n for n, t in d.get("tricks", {}).items() if t.get("learned_at") and strength(t, now) < FORGET]
        for n in gone:
            t = d["tricks"].pop(n)
            from . import notify
            notify.push("trick_forgot", "Alma olvidó un truco 🍂", f"Ya no se acuerda de «{t['label']}»: hace mucho que no lo practican.", now)
        if gone:
            _save(d)
    return gone


def _view(n: str, t: dict, now: float) -> dict:
    s = strength(t, now)
    status = ("dominado" if t.get("mastered") else "aprendido" if t.get("learned_at") else "aprendiendo")
    if t.get("learned_at") and not t.get("fijo") and (now - t["last_practice"]) / 86400 > GRACE_DAYS:
        status = "se le está olvidando"
    return {"name": n, "label": t["label"], "mot": t["mot"], "move": _move(t["mot"]),
            "strength": round(s, 2), "status": status, "last_practice": int(t["last_practice"]), "times": t.get("times", 0)}


def listing(now: float | None = None) -> dict:
    now = now if now is not None else time.time()
    d = _load()
    les = d.get("lesson")
    if les and now - les["at"] > LESSON_IDLE_S:
        les = None
    tricks = sorted((_view(n, t, now) for n, t in d.get("tricks", {}).items()), key=lambda x: -x["strength"])
    return {"tricks": tricks, "lesson": les and {"name": les["name"], "label": les["label"],
                                                 "current": les.get("current"),
                                                 "current_label": MOVES.get(les.get("current") or "", None)},
            "moves_total": len(MOVES)}


def today_summary(now: float | None = None) -> list[str]:
    """Para el diario: lo que practicó hoy."""
    day = _day(now if now is not None else time.time())
    return [f"{t['label']} ({'lo aprendió hoy' if t.get('learned_at') and _day(t['learned_at']) == day else 'practicó'})"
            for t in _load().get("tricks", {}).values() if _day(t["last_practice"]) == day]
