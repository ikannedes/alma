"""Límites del pase nocturno (07, tabla de /v1/night), aplicados en el servidor."""

from .haiku import TRAIT_IDS

JOURNAL_MAX = 600
NUDGE_MAX = 0.01
TAGS_MAX = 5
WELLBEING_ADJ_MAX = 10   # 04, "Bienestar": Haiku mueve los puntos del día ±10; el ESP32 vuelve a recortar
REASON_MAX = 200
FORBIDDEN_MOT_PREFIXES = ("struggle_", "shake_")


def _valid_composition(comp, assets: list[str]) -> bool:
    # Validación estructural; la de duración y servo_cost_s la hace el ESP32 (05).
    if not isinstance(comp, dict) or not isinstance(comp.get("name"), str) or not comp["name"]:
        return False
    mot = comp.get("mot")
    if not isinstance(mot, list) or not mot or not all(isinstance(m, str) for m in mot):
        return False
    if any(m.startswith(FORBIDDEN_MOT_PREFIXES) for m in mot):
        return False
    names = list(mot) + [comp[k] for k in ("avi", "mp3") if k in comp]
    if not all(isinstance(n, str) for n in names):
        return False
    if assets and any(n not in assets for n in names):
        return False
    return True


def apply_limits(raw: dict, assets: list[str]) -> dict:
    journal = raw.get("journal_es")
    journal = journal[:JOURNAL_MAX] if isinstance(journal, str) else ""

    nudges = {}
    raw_nudges = raw.get("trait_nudges")
    if isinstance(raw_nudges, dict):
        for trait, value in raw_nudges.items():
            if trait in TRAIT_IDS and isinstance(value, (int, float)) and not isinstance(value, bool):
                nudges[trait] = max(-NUDGE_MAX, min(NUDGE_MAX, float(value)))

    comp = raw.get("composition")
    composition = {k: comp[k] for k in ("name", "mot", "avi", "mp3") if k in comp} if _valid_composition(comp, assets) else None

    tags = raw.get("tags")
    tags = [t for t in tags if isinstance(t, str)][:TAGS_MAX] if isinstance(tags, list) else []

    adj = raw.get("wellbeing_adjust")
    adj = max(-WELLBEING_ADJ_MAX, min(WELLBEING_ADJ_MAX, int(round(adj)))) if isinstance(adj, (int, float)) and not isinstance(adj, bool) else 0
    reason = raw.get("wellbeing_reason")
    reason = reason[:REASON_MAX] if isinstance(reason, str) else ""

    return {"journal_es": journal, "trait_nudges": nudges, "composition": composition, "tags": tags,
            "wellbeing_adjust": adj, "wellbeing_reason": reason}
