"""POST /v1/night: llamada a Haiku con night_report forzado y límites de 07."""

from alma_relay import night
from tests.conftest import post_night

SUMMARY = {
    "date": "2026-11-03",
    "age_days": 12,
    "traits": {"trait_boldness": 0.41, "trait_energy": 0.63, "trait_sociability": 0.72,
               "trait_playfulness": 0.55, "trait_impulsivity": 0.38},
    "mood_end": 0.21,
    "counts": {"pets": 14, "praises": 3, "scolds": 1},
    "behaviors": {"bhv_greet": 3},
    "people": [{"person_id": 1, "minutes_present": 145, "pets": 11}],
    "moments": [{"t": "08:12", "type": "greet", "person_id": 1, "intensity": 0.8}],
    "servo_active_s": 3120,
    "wellbeing": 212, "day_points": 14, "absent_days": 0,
}
ASSETS = ["dance1.mot", "greet.mot", "happy.avi", "purr.mp3", "struggle_1.mot"]


def test_night_calls_haiku_and_applies_limits(client, haiku_double):
    haiku_double.tool_input = {
        "journal_es": "x" * 900,
        "trait_nudges": {"trait_sociability": 0.05, "trait_energy": -0.3, "trait_playfulness": 0.004, "trait_fake": 0.001},
        "composition": {"name": "baile_feliz", "mot": ["dance1.mot"], "avi": "happy.avi"},
        "tags": ["a", "b", "c", "d", "e", "f", "g"],
        "wellbeing_adjust": 25,
        "wellbeing_reason": "r" * 300,
    }
    r = post_night(client, {"summary": SUMMARY, "previous": [SUMMARY] * 8, "assets": ASSETS})
    assert r.status_code == 200
    body = r.json()
    assert len(body["journal_es"]) == 600
    assert body["trait_nudges"] == {"trait_sociability": 0.01, "trait_energy": -0.01, "trait_playfulness": 0.004}
    assert body["composition"] == {"name": "baile_feliz", "mot": ["dance1.mot"], "avi": "happy.avi"}
    assert body["tags"] == ["a", "b", "c", "d", "e"]
    assert body["wellbeing_adjust"] == 10 and len(body["wellbeing_reason"]) == 200

    call = haiku_double.calls[0]
    assert call["model"] == "claude-haiku-5-5"
    assert call["tool_choice"] == {"type": "tool", "name": "night_report"}
    assert call["tools"][0]["name"] == "night_report"
    assert call["system"][0]["text"].startswith('Eres el "sueño" de Alma')
    assert "dance1.mot" in call["system"][1]["text"]
    assert call["system"][-1]["cache_control"] == {"type": "ephemeral"}
    assert call["messages"][0]["content"].count('"date": "2026-11-03"') == 1 + 6  # hoy + 6 anteriores


def test_composition_null_when_invalid(client, haiku_double):
    cases = [
        None,
        {"name": "x", "mot": ["inventado.mot"]},  # asset fuera de la lista
        {"name": "x", "mot": ["struggle_1.mot"]},  # prohibido por 05
        {"name": "x", "mot": []},
        {"mot": ["dance1.mot"]},  # sin nombre
        "dance1.mot",
    ]
    for comp in cases:
        haiku_double.tool_input = {"journal_es": "hoy", "trait_nudges": {}, "composition": comp, "tags": []}
        body = post_night(client, {"summary": SUMMARY, "previous": [], "assets": ASSETS}).json()
        assert body["composition"] is None, comp


def test_apply_limits_tolerates_garbage():
    body = night.apply_limits({"journal_es": 5, "trait_nudges": "no", "composition": 1, "tags": "x"}, [])
    assert body == {"journal_es": "", "trait_nudges": {}, "composition": None, "tags": [],
                    "wellbeing_adjust": 0, "wellbeing_reason": ""}
    assert night.apply_limits({"wellbeing_adjust": -14.6}, [])["wellbeing_adjust"] == -10
    assert night.apply_limits({"wellbeing_adjust": True}, [])["wellbeing_adjust"] == 0


def test_night_haiku_failure_502(client, haiku_double):
    haiku_double.error = RuntimeError("caído")
    r = post_night(client, {"summary": SUMMARY})
    assert r.status_code == 502
    assert "error" in r.json()


def test_night_bad_token_401(client, haiku_double):
    assert post_night(client, {"summary": SUMMARY}, token="otro").status_code == 401
    assert haiku_double.calls == []


def test_night_missing_summary_400(client, haiku_double):
    assert post_night(client, {"previous": []}).status_code == 400
