"""Normalización y tabla de reglas (05, "Órdenes de voz"; 07, "Ruta de reglas")."""

import pytest

from alma_relay import rules
from alma_relay.haiku import DECIDE_INTENT_TOOL

ACTION_CASES = [(p, a) for a, phrases in rules.ACTION_PHRASES.items() for p in phrases]


@pytest.mark.parametrize("phrase,action_id", ACTION_CASES)
def test_action_phrase_matches(phrase, action_id):
    assert rules.match(rules.normalize(phrase)) == {"intent": "action", "action_id": action_id}


@pytest.mark.parametrize("phrase", rules.PRAISE_PHRASES)
def test_praise_phrase_matches(phrase):
    assert rules.match(rules.normalize(phrase)) == {"intent": "praise", "action_id": None}


@pytest.mark.parametrize("phrase", rules.SCOLD_PHRASES)
def test_scold_phrase_matches(phrase):
    assert rules.match(rules.normalize(phrase)) == {"intent": "scold", "action_id": None}


@pytest.mark.parametrize("text,expected", [
    ("Alma, ¡baila!", "baila"),
    ("Oye Alma, ven aquí por favor", "ven aqui"),
    ("ya, baila", "baila"),
    ("baila ya", "baila"),
    ("por favor Alma, mírame ahora", "mirame"),
    ("Emo, detente.", "detente"),
    ("Buena niña", "buena nina"),
    ("Alma", ""),
])
def test_normalize(text, expected):
    assert rules.normalize(text) == expected


@pytest.mark.parametrize("text", ["no bailes", "deja de bailar", "nunca gires", "ya no juegues", "sin bailar", "tampoco gires"])
def test_negation_does_not_match_rule(text):
    norm = rules.normalize(text)
    assert rules.has_negation(norm)
    assert rules.match(norm) is None


@pytest.mark.parametrize("text", ["quiero que bailes", "cuéntame algo", "baila mucho", "ven y baila"])
def test_partial_phrase_does_not_match(text):
    assert rules.match(rules.normalize(text)) is None


def test_action_enum_matches_table():
    assert set(rules.ACTION_IDS) == set(rules.ACTION_PHRASES)
    assert DECIDE_INTENT_TOOL["input_schema"]["properties"]["action_id"]["enum"] == list(rules.ACTION_IDS)
