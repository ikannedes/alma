"""Llamadas a Claude Haiku 5.5 (Messages API con tool use forzado), según 07."""

import json

import anthropic

from .rules import ACTION_IDS

MODEL = "claude-haiku-5-5"
TIMEOUT_S = 30.0          # pase nocturno y juegos; la voz usa VOICE_TIMEOUT_S
VOICE_TIMEOUT_S = 2.5     # el robot espera 6 s en total (Groq + Haiku + red)

_client: anthropic.Anthropic | None = None  # las pruebas lo sustituyen por un doble


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        # La llave la pega el dueño en la app (settings.py) o sale de ANTHROPIC_API_KEY; el código nunca la escribe.
        from . import settings
        _client = anthropic.Anthropic(api_key=settings.get("anthropic_key"), timeout=TIMEOUT_S, max_retries=1)
    return _client


def reset_client() -> None:
    """La llave cambió en la app: el siguiente uso crea el cliente con la nueva."""
    global _client
    if _client is not None and not isinstance(_client, anthropic.Anthropic):
        return   # un doble de las pruebas
    _client = None


# --- /v1/voice -------------------------------------------------------------

VOICE_SYSTEM = (
    "Eres el intérprete de órdenes de Alma, una mascota robot que no habla.\n"
    "Recibes lo que una persona le dijo, transcrito del español (puede tener errores).\n"
    "Decide con la herramienta decide_intent:\n"
    "- action: si pide una de las acciones disponibles.\n"
    "- praise: si la felicita o le habla con cariño.\n"
    "- scold: si la regaña.\n"
    "- none: cualquier otra cosa.\n"
    "No inventes acciones. Si dudas, confidence baja."
)

INTENTS = ("action", "praise", "scold", "none")

DECIDE_INTENT_TOOL = {
    "name": "decide_intent",
    "description": "Clasifica lo que la persona le dijo a Alma.",
    "input_schema": {
        "type": "object",
        "properties": {
            "intent": {"type": "string", "enum": list(INTENTS)},
            "action_id": {"type": "string", "enum": list(ACTION_IDS)},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": ["intent", "confidence"],
    },
}


def _tool_input(response, name: str) -> dict:
    for block in response.content:
        if block.type == "tool_use" and block.name == name:
            return dict(block.input)
    raise RuntimeError(f"haiku: la respuesta no trae tool_use {name}")


def decide_intent(transcript: str) -> dict:
    """Devuelve {"intent", "action_id", "confidence"} ya validados contra el enum."""
    response = client().messages.create(
        timeout=VOICE_TIMEOUT_S,
        model=MODEL,
        max_tokens=100,
        system=[{"type": "text", "text": VOICE_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        tools=[DECIDE_INTENT_TOOL],
        tool_choice={"type": "tool", "name": "decide_intent"},
        messages=[{"role": "user", "content": transcript}],
    )
    raw = _tool_input(response, "decide_intent")
    intent = raw.get("intent") if raw.get("intent") in INTENTS else "none"
    action_id = raw.get("action_id") if raw.get("action_id") in ACTION_IDS else None
    if intent == "action" and action_id is None:
        intent = "none"
    try:
        confidence = min(1.0, max(0.0, float(raw.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0
    return {"intent": intent, "action_id": action_id, "confidence": confidence}


# --- ver de cerca (vision.py; dueño, 2026-11-01) ------------------------------

# Cómo habla Alma en todo lo que el dueño lee (dueño, 2026-11-02: "muy formal, muy rígido")
ESTILO = (
    "Cómo habla Alma (comentario, comment, diario, notas): español de México, coloquial y cariñoso, como habla una\n"
    "mascota traviesa o un niño chiquito, no como un libro. Frases cortas y espontáneas; puede exclamar, dudar o\n"
    "quejarse. Nada de describir sus sentimientos con palabras formales (\"me siento muy festiva\", \"me agrada\",\n"
    "\"no es de mi preferencia\", \"aunque\" encadenados). Mejor: \"¡Mira mis cuernos de reno! Las bolitas amarillas\n"
    "están bien padres… el rojo, meh\", \"¡Ñam! Otra, ¿sí?\", \"Guácala, brócoli otra vez\", \"Ya no me cabe nada\".\n"
    "Sin emojis, sin groserías, sin muletillas repetidas (no uses siempre \"padre\" ni siempre \"¡ñam!\").\n"
)

SEE_SYSTEM = (
    "Eres los ojos y el instinto de Alma. Alma vive en un robot EMO: una mascota de escritorio pequeña, de unos 10 cm,\n"
    "con la cara en una pantalla (ojos expresivos), dos patas con las que camina, baila y gira, y sin manos. No habla:\n"
    "se expresa con la cara, sonidos y movimientos. Es curiosa, juguetona y un poco traviesa; a veces gruñona; quiere a\n"
    "su dueño y reacciona como una mascota, no como una persona.\n"
    "Recibes la foto de su cámara: algo que alguien le acercó a menos de 10 cm, en baja resolución; puede salir borroso,\n"
    "oscuro o muy de cerca. Con ver_objeto:\n"
    "- objeto: qué es en pocas palabras y en español (\"una pelota roja\", \"una taza\", \"tu mano\"). Si no se distingue,\n"
    "  \"no sé qué es\". Nunca describas a una persona más allá de \"tu mano\", \"una persona\" o \"una cara\".\n"
    "- conducta: qué hace Alma con eso, de la lista de conductas que puede hacer (abajo). Elige la que haría ella.\n"
    "- reaccion: el tono de lo que siente (le cambia el ánimo).\n"
    "- comentario: lo que pensaría Alma, en primera persona y una frase corta.\n"
    "Decide como ella, con su estado de ahora (rasgos de 0 a 1, ánimo, bienestar de −1023 a 1023, hambre, salud):\n"
    "- trait_boldness alto: lo nuevo le da curiosidad; bajo: lo raro o grande la asusta un poco y se echa para atrás.\n"
    "- trait_playfulness alto: juguetes y pelotas la emocionan (jugar, bailar, invitar a jugar).\n"
    "- trait_sociability alto: una mano o una persona la alegra (saludar).\n"
    "- Con hambre, la comida le interesa (hacer como que se la come); enferma o con el bienestar bajo, poca energía:\n"
    "  conductas tranquilas, nada de bailar. Gruñona: puede rechazar o hacer berrinche.\n"
    "- Las cosas comunes de casa no la asustan; lo aburrido le da igual (bostezar o mirar alrededor)."
)

SEE_TOOL = {
    "name": "ver_objeto",
    "description": "Qué ve Alma de cerca, cómo se siente y qué hace con eso.",
    "input_schema": {
        "type": "object",
        "properties": {
            "objeto": {"type": "string", "description": "Qué es, en pocas palabras, en español."},
            "es_juguete": {"type": "boolean"},
            "conducta": {"type": "string", "description": "Lo que hace Alma: una de sus conductas."},
            "reaccion": {"type": "string", "enum": ["curiosa", "contenta", "asustada", "confundida", "indiferente"]},
            "comentario": {"type": "string", "description": "Lo que pensaría Alma, primera persona, una frase."},
        },
        "required": ["objeto", "es_juguete", "conducta", "reaccion", "comentario"],
    },
}


def _look(jpg: bytes, state: dict, actions: dict[str, str], system: str, template: dict) -> dict:
    """La foto de su cámara a Haiku con su estado y lo que puede hacer; devuelve el input crudo de la herramienta."""
    import base64
    tool = json.loads(json.dumps(template))
    tool["input_schema"]["properties"]["conducta"]["enum"] = list(actions)
    acts = "Conductas que puede hacer:\n" + "\n".join(f"- {k}: {v}" for k, v in actions.items())
    response = client().messages.create(
        model=MODEL,
        max_tokens=300,
        system=[{"type": "text", "text": system + ESTILO}, {"type": "text", "text": acts, "cache_control": {"type": "ephemeral"}}],
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.standard_b64encode(jpg).decode("ascii")}},
            {"type": "text", "text": "Así está Alma ahora: " + json.dumps(state, ensure_ascii=False)},
        ]}],
    )
    return _tool_input(response, tool["name"])


def see_object(jpg: bytes, state: dict, actions: dict[str, str]) -> dict:
    """Devuelve el input crudo de ver_objeto; vision.py lo valida. actions: id → qué hace."""
    return _look(jpg, state, actions, SEE_SYSTEM, SEE_TOOL)


# Foto del dueño (dueño, 2026-11-02: "cuando me ve a mí, cada cierto tiempo tome una foto… y reaccione a lo que vea")
OWNER_SYSTEM = (
    "Eres los ojos y el instinto de Alma. Alma vive en un robot EMO: una mascota de escritorio pequeña, de unos 10 cm,\n"
    "con la cara en una pantalla (ojos expresivos), dos patas con las que camina, baila y gira, y sin manos. No habla:\n"
    "se expresa con la cara, sonidos y movimientos. Es curiosa, juguetona y un poco traviesa; a veces gruñona; quiere a\n"
    "su dueño y reacciona como una mascota, no como una persona.\n"
    "Alma lleva un rato viendo a su dueño de frente y le tomó una foto con su cámara (baja resolución; puede salir\n"
    "borrosa u oscura). Con ver_dueno:\n"
    "- que_hace: qué está haciendo su dueño, en pocas palabras y en español (\"trabajando en la compu\", \"riéndose\",\n"
    "  \"comiendo\", \"con el celular\", \"jugando\"). Nunca describas cómo es (cara, cuerpo, ropa, edad) ni quién es:\n"
    "  solo lo que hace. Si no se ve a nadie claro, \"no se distingue\".\n"
    "- conducta: qué hace Alma con eso, de la lista de conductas que puede hacer (abajo). Elige la que haría ella.\n"
    "- reaccion: el tono de lo que siente (le cambia el ánimo).\n"
    "- comentario: lo que pensaría Alma, en primera persona y una frase corta.\n"
    "Decide como ella, con su estado de ahora (rasgos de 0 a 1, ánimo, bienestar de −1023 a 1023, hambre, salud):\n"
    "- Si se ríe o juega, se le contagia (menearse, bailar, invitar a jugar).\n"
    "- Si trabaja o está con el celular: con trait_sociability alto quiere un poco de atención, pero sin insistir (un\n"
    "  saludo, balbucear); si no, lo deja tranquilo, se aburre o se pone a lo suyo.\n"
    "- Si come, le da curiosidad o antojo (con hambre, hacer como que come).\n"
    "- Enferma o con el bienestar bajo: conductas tranquilas. Gruñona: puede hacer berrinche si no la pela.\n"
    "- Si no se distingue nada: curiosa o confundida, nunca asustada."
)

OWNER_TOOL = {
    "name": "ver_dueno",
    "description": "Qué hace el dueño en la foto que le tomó Alma, cómo se siente ella y qué hace con eso.",
    "input_schema": {
        "type": "object",
        "properties": {
            "que_hace": {"type": "string", "description": "Qué hace el dueño, en pocas palabras, en español."},
            "conducta": {"type": "string", "description": "Lo que hace Alma: una de sus conductas."},
            "reaccion": {"type": "string", "enum": ["curiosa", "contenta", "asustada", "confundida", "indiferente"]},
            "comentario": {"type": "string", "description": "Lo que pensaría Alma, primera persona, una frase."},
        },
        "required": ["que_hace", "conducta", "reaccion", "comentario"],
    },
}


def see_owner(jpg: bytes, state: dict, actions: dict[str, str]) -> dict:
    """Devuelve el input crudo de ver_dueno; vision.py lo valida."""
    return _look(jpg, state, actions, OWNER_SYSTEM, OWNER_TOOL)


# Álbum (dueño, 2026-11-01): fotos que el dueño sube desde la app (disfraces, adornos, impresiones 3D…)
PHOTO_SYSTEM = (
    "Eres Alma, una mascota que vive en un robot EMO: pequeño (unos 10 cm), con la cara en una pantalla (ojos\n"
    "expresivos), dos patas, sin manos y sin voz; se expresa con la cara, sonidos y movimientos. Es curiosa, juguetona,\n"
    "un poco traviesa, a veces gruñona, y quiere a su dueño.\n"
    "Tu dueño te enseña una foto que tomó con su teléfono: muchas veces sales tú con un disfraz, un adorno o algo que\n"
    "te hizo (por ejemplo, impreso en 3D); otras es algo que te quiere mostrar. Con ver_foto:\n"
    "- que_es: qué se ve, en pocas palabras y en español. Nunca describas a una persona más allá de \"tu dueño\",\n"
    "  \"una persona\" o \"una mano\".\n"
    "- sale_alma: si en la foto sale un robot EMO (eres tú).\n"
    "- le_gusta: qué tanto te gusta, según TUS gustos (vienen en el estado: le_encantan, le_gustan, no_le_gustan) y\n"
    "  tu ánimo. Sé coherente con esos gustos: lo que no te gusta no te gusta aunque sea bonito. Si no tiene que ver\n"
    "  con tus gustos, decide por tu personalidad.\n"
    "- conducta: qué haces al verla, de la lista de conductas que puedes hacer (abajo).\n"
    "- reaccion: el tono de lo que sientes.\n"
    "- comentario: lo que piensas, en primera persona, una o dos frases cortas, con tu personalidad (si viene\n"
    "  ocasion, es lo que tú le pediste: tenlo en cuenta).\n"
    "- titulo: un pie de foto corto para tu álbum (máximo 6 palabras).\n"
    "Tu estado: rasgos de 0 a 1 (trait_boldness valentía, trait_playfulness juego, trait_sociability, trait_energy,\n"
    "trait_impulsivity), ánimo, bienestar de −1023 a 1023, hambre y salud. Enferma o triste: reacciones tranquilas."
)

PHOTO_TOOL = {
    "name": "ver_foto",
    "description": "Qué ve Alma en la foto que le enseñó su dueño, si le gusta, qué hace y qué piensa.",
    "input_schema": {
        "type": "object",
        "properties": {
            "que_es": {"type": "string"},
            "sale_alma": {"type": "boolean"},
            "le_gusta": {"type": "string", "enum": ["le encanta", "le gusta", "le da igual", "no le gusta"]},
            "conducta": {"type": "string"},
            "reaccion": {"type": "string", "enum": ["curiosa", "contenta", "asustada", "confundida", "indiferente"]},
            "comentario": {"type": "string"},
            "titulo": {"type": "string"},
        },
        "required": ["que_es", "sale_alma", "le_gusta", "conducta", "reaccion", "comentario", "titulo"],
    },
}


def see_photo(jpg: bytes, state: dict, actions: dict[str, str]) -> dict:
    """Devuelve el input crudo de ver_foto; album.py lo valida."""
    import base64
    tool = json.loads(json.dumps(PHOTO_TOOL))
    tool["input_schema"]["properties"]["conducta"]["enum"] = list(actions)
    acts = "Conductas que puedes hacer:\n" + "\n".join(f"- {k}: {v}" for k, v in actions.items())
    response = client().messages.create(
        model=MODEL,
        max_tokens=400,
        system=[{"type": "text", "text": PHOTO_SYSTEM + ESTILO}, {"type": "text", "text": acts, "cache_control": {"type": "ephemeral"}}],
        tools=[tool],
        tool_choice={"type": "tool", "name": "ver_foto"},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.standard_b64encode(jpg).decode("ascii")}},
            {"type": "text", "text": "Así estás ahora: " + json.dumps(state, ensure_ascii=False)},
        ]}],
    )
    return _tool_input(response, "ver_foto")


# --- /v1/night -------------------------------------------------------------

NIGHT_SYSTEM = (
    'Eres el "sueño" de Alma, una mascota robot sin voz. Recibes el resumen de su día y de los 6 anteriores.\n'
    "Escribe un diario breve en primera persona, como mascota, sin inventar hechos que no estén en el resumen.\n"
    "Puedes sugerir cambios muy pequeños de rasgos que reflejen cómo la trataron, y como mucho una conducta nueva\n"
    "que combine solo assets de la lista disponible. Nunca sugieras nada que la haga pedir atención con más insistencia.\n"
    "El resumen trae day_points: los puntos de bienestar del día según la cuenta local (de -30 a 30). Puedes ajustarlos\n"
    "entre -10 y 10 con wellbeing_adjust si la historia de la semana lo justifica (por ejemplo, varios días seguidos sin\n"
    "jugar pesan más; un día malo aislado tras una semana buena pesa menos), y explica por qué en wellbeing_reason.\n"
    "Si la cuenta local ya es justa, usa 0.\n"
    "También cuidan de ti como tamagotchi: counts.meals (comidas que aceptaste con hambre), treats (golosinas),\n"
    "refused_food (comida que rechazaste) y starving_min (minutos con mucha hambre). Y el dueño juega contigo desde\n"
    "su celular: counts.remote_play_min y remote_games (juegos, quién ganó). Cuéntalo en el diario si pasó; esos puntos\n"
    "ya están en day_points: jugar a distancia cuenta menos que jugar en persona.\n"
    "Si viene care: qué comiste y rechazaste, calorías, peso, ejercicio y si estás enferma (lo lleva el servidor).\n"
    "Cuéntalo con naturalidad si pasó algo (te empachaste, bailaste mucho, te dieron brócoli otra vez).\n"
    "Si viene play: las partidas de hoy en los juegos de la app (quién ganó) y hábitos que notaste del dueño.\n"
    "Si viene vio_de_cerca: cosas que te acercaron a la cara hoy (las viste con tu cámara).\n"
    "Si viene hitos: algo importante de hoy (cumpliste una semana, un mes…, aprendiste a reconocer a alguien o tu\n"
    "personalidad cambió). Cuéntalo en el diario con emoción, a tu manera.\n"
    "Si viene fotos: fotos que tu dueño te enseñó hoy (disfraces, adornos, cosas que te hizo) y si te gustaron.\n"
    "Si viene trucos: los trucos que practicaste hoy con tu dueño (o que aprendiste hoy)."
)

TRAIT_IDS = (
    "trait_boldness", "trait_energy", "trait_sociability", "trait_playfulness", "trait_impulsivity",
)

NIGHT_REPORT_TOOL = {
    "name": "night_report",
    "description": "Diario, sugerencias de rasgos, conducta compuesta opcional y etiquetas del día.",
    "input_schema": {
        "type": "object",
        "properties": {
            "journal_es": {"type": "string", "description": "Diario en primera persona, máximo 600 caracteres."},
            "trait_nudges": {
                "type": "object",
                "properties": {t: {"type": "number", "minimum": -0.01, "maximum": 0.01} for t in TRAIT_IDS},
                "additionalProperties": False,
            },
            "composition": {
                "type": ["object", "null"],
                "description": "Conducta nueva con assets de la lista, o null.",
                "properties": {
                    "name": {"type": "string"},
                    "mot": {"type": "array", "items": {"type": "string"}},
                    "avi": {"type": "string"},
                    "mp3": {"type": "string"},
                },
                "required": ["name", "mot"],
            },
            "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
            "wellbeing_adjust": {
                "type": "integer", "minimum": -10, "maximum": 10,
                "description": "Ajuste a day_points (cuenta local del bienestar del día); 0 si es justa.",
            },
            "wellbeing_reason": {"type": "string", "description": "Por qué el ajuste, en una frase (máximo 200 caracteres)."},
        },
        "required": ["journal_es", "trait_nudges", "composition", "tags", "wellbeing_adjust", "wellbeing_reason"],
    },
}


def night_report(summary: dict, previous: list[dict], assets: list[str]) -> dict:
    """Devuelve el input crudo del tool night_report; los límites se aplican en night.py."""
    system = [{"type": "text", "text": NIGHT_SYSTEM + ESTILO}]
    if assets:
        system.append({"type": "text", "text": "Assets disponibles:\n" + "\n".join(assets)})
    system[-1]["cache_control"] = {"type": "ephemeral"}
    user = json.dumps({"today": summary, "previous_days": previous}, ensure_ascii=False)
    response = client().messages.create(
        model=MODEL,
        max_tokens=1024,
        system=system,
        tools=[NIGHT_REPORT_TOOL],
        tool_choice={"type": "tool", "name": "night_report"},
        messages=[{"role": "user", "content": user}],
    )
    return _tool_input(response, "night_report")


# --- trucos nuevos (repertorio.py; dueño, 2026-11-05) ------------------------

MOVES_SYSTEM = (
    "Eres coreógrafo de Alma, una mascota robot de escritorio (cuerpo de EMO): cabeza con pantalla y dos piernas cortas.\n"
    "Cada noche propones 1 o 2 trucos NUEVOS: movimientos cortos y expresivos que ella intentará mañana; si a su dueño le\n"
    "gustan (la acaricia o la felicita) se quedan en su repertorio.\n"
    "El cuerpo tiene 4 servos; 90 es la posición neutra de todos:\n"
    "- S0 cadera izquierda y S1 cadera derecha: giran cada pierna (40–160 y 53–130).\n"
    "- S2 pie izquierdo y S3 pie derecho: inclinan el pie y con él todo el cuerpo (usa 65–115; más allá se puede caer).\n"
    "- Simétrico (como espejo de sí misma): S1 = 180 − S0 y S3 = 180 − S2. Asimétrico: se ladea o gira el cuerpo.\n"
    "Cada cuadro es una pose {\"pose\":[S0,S1,S2,S3],\"ms\":duración para llegar} (150–1500 ms) o un paso de fábrica\n"
    "{\"paso\":\"adelante|atras|izquierda|derecha\"} (avanza ~1 cm, retrocede o gira ~44°).\n"
    "Reglas: de 3 a 10 cuadros; empieza y termina cerca de 90; cambios de pies suaves (≤ 20° por cuadro); que tenga\n"
    "ritmo o intención (un saludo, un meneo, un 'ta-da', un baile corto). No repitas los que ya tiene.\n"
    "Inspírate en cómo fue su día (resumen) y en su carácter. Nombre corto en español."
)

PROPOSE_MOVES_TOOL = {
    "name": "proponer_trucos",
    "description": "Trucos nuevos para que Alma los intente mañana.",
    "input_schema": {
        "type": "object",
        "properties": {
            "trucos": {
                "type": "array", "minItems": 1, "maxItems": 2,
                "items": {
                    "type": "object",
                    "properties": {
                        "nombre": {"type": "string", "description": "corto, en español"},
                        "por_que": {"type": "string", "description": "por qué este truco, por su día o su carácter"},
                        "cuadros": {"type": "array", "minItems": 3, "maxItems": 10, "items": {"type": "object"}},
                    },
                    "required": ["nombre", "cuadros"],
                },
            }
        },
        "required": ["trucos"],
    },
}


def propose_moves(summary: dict, repertorio: dict | None) -> list[dict]:
    """Propuestas crudas de Haiku; repertorio.add_tricks las valida."""
    user = json.dumps({"dia": summary, "ya_tiene": repertorio or {}}, ensure_ascii=False)
    response = client().messages.create(
        model=MODEL,
        max_tokens=1200,
        system=[{"type": "text", "text": MOVES_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        tools=[PROPOSE_MOVES_TOOL],
        tool_choice={"type": "tool", "name": "proponer_trucos"},
        messages=[{"role": "user", "content": user}],
    )
    return list(_tool_input(response, "proponer_trucos").get("trucos") or [])
