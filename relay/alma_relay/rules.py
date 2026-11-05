"""Ruta de reglas de /v1/voice (07, "Ruta de reglas").

La tabla es la de 05-catalogo-de-conductas.md, "Órdenes de voz". Para ampliarla
se agrega la frase aquí (la conducta primero en 05). Las frases se comparan
completas y ya normalizadas; lo que no casa va a Haiku.
"""

import re
import unicodedata

# Enum de action_id del tool decide_intent (07). Idéntico a la tabla de 05.
ACTION_IDS = (
    "come",
    "dance",
    "turn_around",
    "sleep",
    "wake_up",
    "look_at_me",
    "play",
    "stop",
    "greet",
    "go_home",
)

# Tabla de 05: action_id -> frases de la regla.
ACTION_PHRASES: dict[str, tuple[str, ...]] = {
    "stop": ("detente", "quieta", "quieto", "alto", "para", "basta", "stop"),
    "come": ("ven", "ven aqui", "ven aca", "acercate", "ven conmigo"),
    "dance": ("baila", "a bailar", "bailemos", "un baile", "aila",   # "aila": la b se corta al empezar a grabar (2026-11-03)
              "alocate", "a locate", "locate", "ponte loca"),          # "EMO, alócate" (dueño, 2026-11-04)
    "turn_around": ("gira", "da una vuelta", "date la vuelta", "da la vuelta", "voltea"),
    "sleep": ("duermete", "a dormir", "descansa", "a descansar", "hora de dormir"),
    "wake_up": ("despierta", "despiertate", "arriba", "levantate"),
    "look_at_me": ("mirame", "mira", "aqui estoy", "voltea a verme"),
    "play": ("juega", "juguemos", "vamos a jugar", "juega conmigo", "a jugar"),
    "greet": ("saluda", "di hola", "hola", "buenos dias", "buenas"),
    "go_home": ("a casa", "ve a casa", "a tu casa", "a tu base", "a cargar", "ve a cargar"),
}

PRAISE_PHRASES = (
    "muy bien", "bien hecho", "buena chica", "buena niña", "que linda",
    "te quiero", "bravo", "excelente", "perfecto",
)

SCOLD_PHRASES = (
    "no", "eso no", "no alma", "mal", "asi no", "no hagas eso", "que haces", "malcriada",
)

# Relleno que se quita al inicio o al final de la frase (07). Los de varias
# palabras van primero para que "oye alma" no quede como "alma" suelto.
FILLERS = ("oye alma", "por favor", "alma", "emo", "oye", "ahora", "ya")

# Palabras de negación: la frase va a Haiku salvo que sea un "no" corto de scold.
NEGATION_WORDS = frozenset({"no", "deja", "nunca", "sin", "tampoco"})


def normalize(text: str) -> str:
    """Minúsculas, sin acentos ni signos, sin relleno al inicio o al final."""
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^a-z0-9ñ ]+", " ", text)
    words = text.split()
    fillers = [f.split() for f in FILLERS]
    changed = True
    while changed and words:
        changed = False
        for f in fillers:
            n = len(f)
            if words[:n] == f:
                words = words[n:]
                changed = True
            if words and words[-n:] == f:
                words = words[:-n]
                changed = True
    return " ".join(words)


def _build_table() -> dict[str, dict]:
    table: dict[str, dict] = {}
    for action_id, phrases in ACTION_PHRASES.items():
        for p in phrases:
            table[normalize(p)] = {"intent": "action", "action_id": action_id}
    for p in PRAISE_PHRASES:
        table[normalize(p)] = {"intent": "praise", "action_id": None}
    for p in SCOLD_PHRASES:
        table[normalize(p)] = {"intent": "scold", "action_id": None}
    return table


# Frase normalizada -> {"intent", "action_id"}.
TABLE = _build_table()


def has_negation(normalized: str) -> bool:
    return any(w in NEGATION_WORDS for w in normalized.split())


def match(normalized: str) -> dict | None:
    """Devuelve {"intent", "action_id"} si la frase completa casa; None si va a Haiku."""
    hit = TABLE.get(normalized)
    if hit and hit["intent"] == "scold":
        return hit  # los "no" cortos de scold son la única excepción a la negación
    if has_negation(normalized):
        return None
    return hit
