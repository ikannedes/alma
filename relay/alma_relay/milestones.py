"""Hitos de Alma (dueño, 2026-11-01: "no se nota que crezca; agrega hitos"): cumple 1 semana, 1 mes, 6 meses, 1 año
(y cada año después), y cuando aprende algo nuevo. Se guardan en data/milestones.json, avisan al teléfono (de día:
si se alcanzan de noche, el aviso espera a las 8) y el diario de esa noche los cuenta.

La edad es la del robot (age_days: noches vividas, sube en cada pase nocturno), la misma que muestra la app.
Lo que aprende hoy: a reconocer a alguien nuevo y los cambios de su personalidad. learned() es la entrada para lo
que se invente después.
"""

import json
import os
import threading
import time

from . import notify, settings

AGES = [(7, "1 semana", "🐣"), (30, "1 mes", "🌱"), (182, "6 meses", "🌿"), (365, "1 año", "🎂")]
TRAIT_STEP = 0.05   # cuánto tiene que moverse un rasgo para contar como cambio de personalidad
TRAITS = {"trait_boldness": ("más valiente", "más prudente"), "trait_energy": ("con más energía", "más tranquila"),
          "trait_sociability": ("más sociable", "más reservada"), "trait_playfulness": ("más juguetona", "más seria"),
          "trait_impulsivity": ("más impulsiva", "más paciente")}
_lock = threading.Lock()


def _path() -> str:
    return os.path.join(settings.data_dir(), "milestones.json")


def _load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def _save(d: dict) -> None:
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, _path())


def age_goals(age: int) -> list[tuple[int, str, str]]:
    """Los cumpleaños hasta un año más allá de la edad actual: 1 semana, 1 mes, 6 meses y cada año."""
    out = list(AGES)
    for y in range(2, age // 365 + 2):
        out.append((365 * y, f"{y} años", "🎂"))
    return out


def _add(d: dict, key: str, kind: str, emoji: str, title: str, body: str, now: float, age) -> bool:
    items = d.setdefault("items", [])
    if any(x["key"] == key for x in items):
        return False
    items.append({"key": key, "kind": kind, "emoji": emoji, "title": title, "body": body, "at": int(now),
                  "age_days": age, "notified": False})
    return True


def _flush(d: dict, now: float) -> None:
    """Avisa los hitos pendientes, salvo de noche (duerme; el aviso llega a las 8)."""
    from . import care
    if care.is_night(now):
        return
    for x in d.get("items", []):
        if not x["notified"]:
            notify.push("milestone", f"{x['emoji']} {x['title']}", x["body"], now)
            x["notified"] = True


def on_state(st: dict, now: float | None = None) -> list[str]:
    """Con cada estado del robot: cumpleaños por edad y cambios de personalidad. Devuelve las llaves nuevas."""
    now = now if now is not None else time.time()
    age = st.get("age_days")
    if not isinstance(age, int):
        return []
    traits = st.get("traits") or {}
    new = []
    with _lock:
        d = _load()
        before = json.dumps(d, sort_keys=True)
        last_age = d.get("age")
        reset = isinstance(last_age, int) and age < last_age   # robot nuevo o memoria borrada: no es que cambió
        d["age"] = age
        for days, name, emoji in age_goals(age):
            if age >= days and not reset and _add(d, f"edad_{days}", "edad", emoji, f"¡Alma cumple {name}!",
                                                  f"Lleva {days} noches contigo.", now, age):
                new.append(f"edad_{days}")
        if all(isinstance(traits.get(k), (int, float)) for k in TRAITS):
            base = d.get("traits_base")
            if not base or reset:
                d["traits_base"] = {k: traits[k] for k in TRAITS}
            else:
                for k, (up, down) in TRAITS.items():
                    diff = traits[k] - base[k]
                    if abs(diff) >= TRAIT_STEP:
                        word = up if diff > 0 else down
                        key = f"rasgo_{k}_{int(now)}"
                        _add(d, key, "personalidad", "✨", f"Alma se está volviendo {word}",
                             f"Su personalidad cambió con lo que ha vivido ({base[k]:.2f} → {traits[k]:.2f}).", now, age)
                        base[k] = traits[k]
                        new.append(key)
        _flush(d, now)
        if json.dumps(d, sort_keys=True) != before:   # llega un estado cada pocos segundos: solo se escribe si cambió
            _save(d)
    return new


def learned(key: str, title: str, body: str, emoji: str = "💡", now: float | None = None, age=None,
            kind: str = "aprende") -> bool:
    """Aprendió algo nuevo, o un recuerdo (kind="recuerdo"): una sola vez por llave."""
    now = now if now is not None else time.time()
    with _lock:
        d = _load()
        ok = _add(d, "aprende_" + key, kind, emoji, title, body, now, age if age is not None else d.get("age"))
        _flush(d, now)
        _save(d)
    return ok


def on_robot_message(msg: dict, now: float | None = None) -> None:
    if msg.get("t") == "state":
        on_state(msg, now)
    elif msg.get("t") == "event" and msg.get("ev") == "new_face" and msg.get("name"):
        n = str(msg["name"])
        learned(f"cara_{n}", f"Alma aprendió a reconocer a {n}", "Ya se sabe su cara: la va a saludar cuando la vea.", "👤", now)


def listing() -> dict:
    """Para la app: la edad, los hitos (el más nuevo primero) y el próximo cumpleaños."""
    d = _load()
    age = d.get("age")
    nxt = None
    if isinstance(age, int):
        nxt = next(({"days": n, "name": name, "left": n - age} for n, name, _ in age_goals(age) if n > age), None)
    items = [{k: x[k] for k in ("key", "kind", "emoji", "title", "body", "at", "age_days")} for x in d.get("items", [])]
    return {"age_days": age, "next": nxt, "milestones": sorted(items, key=lambda x: -x["at"])}


def recent(since: float) -> list[str]:
    """Para el diario: los hitos desde `since`."""
    return [x["title"] for x in _load().get("items", []) if x["at"] >= since]
