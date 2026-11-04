"""Ver de cerca (vision.py; dueño, 2026-11-01): la foto llega del robot en trozos, Haiku (un doble) dice qué es y la
reacción vuelve por el enlace. Sin red."""

import base64

from alma_relay import haiku, vision
from tests.test_web import LINK_KEY, _robot, _setup, c  # noqa: F401

JPG = b"\xff\xd8" + bytes(range(256)) * 20 + b"\xff\xd9"


def _send_photo(ws, sess, jpg=JPG, chunk=2400, skip=None):
    parts = [jpg[i:i + chunk] for i in range(0, len(jpg), chunk)]
    for n, p in enumerate(parts):
        if n == skip:
            continue
        ws.send_bytes(sess.seal({"t": "photo", "seq": n, "last": int(n == len(parts) - 1),
                                 "jpg": base64.b64encode(p).decode()}))


def _fake_see(seen):
    def f(jpg, state, actions):
        seen.append((jpg, state, actions))
        return {"objeto": "una pelota roja", "es_juguete": True, "conducta": "bhv_play_bow", "reaccion": "contenta",
                "comentario": "¡Una pelota!"}
    return f


def test_photo_to_seen_and_app(c, monkeypatch):  # noqa: F811
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex(), "anthropic_key": "sk-ant-prueba"})
    seen = []
    monkeypatch.setattr(haiku, "see_object", _fake_see(seen))
    monkeypatch.setattr(vision, "_day", {"date": None, "n": 0, "seen": []})
    ws, sess = _robot(c)
    assert sess.open(ws.receive_bytes())["t"] == "welcome"
    ws.send_bytes(sess.seal({"t": "state", "state": "ST_AWAKE", "traits": {"trait_boldness": 0.7}, "simple_mood": "SM_HAPPY",
                             "wellbeing": 120, "hunger": 0.4, "sick": False}))
    _send_photo(ws, sess)
    r = sess.open(ws.receive_bytes())
    while r["t"] != "seen":
        r = sess.open(ws.receive_bytes())
    assert r["objeto"] == "una pelota roja" and r["reaccion"] == "contenta" and r["conducta"] == "bhv_play_bow"
    jpg, state, actions = seen[0]
    assert jpg == JPG and state["rasgos"] == {"trait_boldness": 0.7} and state["animo"] == "SM_HAPPY"   # la foto entera,
    assert state["hambre"] == 0.4 and state["enferma"] is False and state["bienestar"] == 120          # con cómo está ella
    assert actions is vision.ACTIONS and "bhv_dance" in actions                                        # y lo que puede hacer
    ev = c.get("/app/state").json()["events"][-1]
    assert ev["ev"] == "seen" and ev["objeto"] == "una pelota roja"
    img = c.get("/app/vision/last.jpg")
    assert img.status_code == 200 and img.content == JPG and img.headers["content-type"] == "image/jpeg"
    assert vision.today_summary() == ["una pelota roja"]                    # para el diario
    ws.__exit__(None, None, None)


def test_photo_errors(c, monkeypatch):  # noqa: F811
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex()})
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(haiku, "see_object", _fake_see([]))
    ws, sess = _robot(c)
    sess.open(ws.receive_bytes())
    _send_photo(ws, sess)
    assert sess.open(ws.receive_bytes())["error"] == "falta la llave de Claude en la app"
    c.post("/app/settings", json={"anthropic_key": "sk-ant-prueba"})
    _send_photo(ws, sess, skip=1)
    assert sess.open(ws.receive_bytes())["error"] == "foto incompleta"      # se perdió un trozo
    _send_photo(ws, sess, jpg=b"\x00" * 3000)
    assert sess.open(ws.receive_bytes())["error"] == "no es un JPEG"
    ws.__exit__(None, None, None)


def test_daily_cap_and_bad_reaction(monkeypatch):
    monkeypatch.setattr(vision.settings, "get", lambda k, d=None: "sk-ant-prueba" if k == "anthropic_key" else d)
    monkeypatch.setattr(haiku, "see_object", lambda jpg, s, a: {"objeto": "x" * 200, "reaccion": "furiosa",
                                                                 "conducta": "bhv_reflex_struggle"})
    monkeypatch.setattr(vision, "_day", {"date": None, "n": 0, "seen": []})
    p = vision.Photo()
    p.add({"seq": 0, "last": 1, "jpg": base64.b64encode(JPG).decode()})
    r = vision.see(p, {}, now=1_800_036_000.0)
    assert r["reaccion"] == "confundida" and len(r["objeto"]) == 60        # reacción fuera de la lista y texto largo
    assert r["conducta"] is None                                            # una conducta que no está en la lista
    vision._day["n"] = vision.DAILY_MAX
    assert vision.see(p, {}, now=1_800_036_000.0)["error"] == "ya vio mucho hoy"
    r2 = vision.see(p, {}, now=1_800_036_000.0 + 86400)                    # al día siguiente se reinicia
    assert r2.get("reaccion") == "confundida" and vision._day["n"] == 1


def test_see_object_sends_the_image(monkeypatch):
    calls = []

    class Block:
        type, name = "tool_use", "ver_objeto"
        input = {"objeto": "una taza", "es_juguete": False, "reaccion": "indiferente", "comentario": "Una taza."}

    class Msgs:
        def create(self, **kw):
            calls.append(kw)
            return type("R", (), {"content": [Block()]})()

    monkeypatch.setattr(haiku, "_client", type("C", (), {"messages": Msgs()})())
    r = haiku.see_object(JPG, {"rasgos": {"trait_boldness": 0.3}, "animo": "SM_GRUMPY"}, vision.ACTIONS)
    assert r["objeto"] == "una taza"
    kw = calls[0]
    content = kw["messages"][0]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["media_type"] == "image/jpeg"
    assert base64.b64decode(content[0]["source"]["data"]) == JPG
    assert '"trait_boldness": 0.3' in content[1]["text"] and "SM_GRUMPY" in content[1]["text"]
    assert kw["tool_choice"] == {"type": "tool", "name": "ver_objeto"}
    assert kw["tools"][0]["input_schema"]["properties"]["conducta"]["enum"] == list(vision.ACTIONS)
    assert "bhv_shy_retreat: echarse para atrás" in kw["system"][1]["text"] and "EMO" in kw["system"][0]["text"]
    assert "enum" not in haiku.SEE_TOOL["input_schema"]["properties"]["conducta"]   # la plantilla no se toca


def test_owner_photo_uses_its_own_prompt_and_keeps_only_text(c, monkeypatch):  # noqa: F811
    """Foto del dueño (dueño, 2026-11-02): "kind":"owner" va a ver_dueno; no se guarda la imagen, solo qué hacía."""
    _setup(c)
    c.post("/app/settings", json={"link_key": LINK_KEY.hex(), "anthropic_key": "sk-ant-prueba"})
    near, owner = [], []
    monkeypatch.setattr(haiku, "see_object", _fake_see(near))
    monkeypatch.setattr(haiku, "see_owner", lambda jpg, s, a: owner.append((jpg, s, a)) or {
        "que_hace": "trabajando en la compu", "conducta": "bhv_babble", "reaccion": "curiosa",
        "comentario": "¿Otra vez trabajando? Hazme caso tantito"})
    monkeypatch.setattr(vision, "_day", {"date": None, "n": 0, "seen": [], "owner": []})
    monkeypatch.setattr(vision, "_last", {})
    ws, sess = _robot(c)
    assert sess.open(ws.receive_bytes())["t"] == "welcome"
    parts = [JPG[i:i + 2400] for i in range(0, len(JPG), 2400)]
    for n, p in enumerate(parts):
        m = {"t": "photo", "seq": n, "last": int(n == len(parts) - 1), "jpg": base64.b64encode(p).decode()}
        ws.send_bytes(sess.seal(m | ({"kind": "owner"} if n == 0 else {})))
    r = sess.open(ws.receive_bytes())
    while r["t"] != "seen":
        r = sess.open(ws.receive_bytes())
    assert r["objeto"] == "trabajando en la compu" and r["conducta"] == "bhv_babble" and r["kind"] == "owner"
    assert len(owner) == 1 and owner[0][0] == JPG and owner[0][2] is vision.ACTIONS and not near
    assert vision.owner_summary() == ["trabajando en la compu"] and vision.today_summary() == []
    assert c.get("/app/vision/last.jpg").status_code == 404                  # la foto del dueño no se guarda
    assert c.get("/app/state").json()["events"][-1]["kind"] == "owner"
    _send_photo(ws, sess)                                                    # sin "kind": la de cerca, como siempre
    r = sess.open(ws.receive_bytes())
    while r["t"] != "seen":
        r = sess.open(ws.receive_bytes())
    assert r["objeto"] == "una pelota roja" and "kind" not in r and len(near) == 1
    ws.__exit__(None, None, None)


def test_see_owner_prompt(monkeypatch):
    calls = []

    class Block:
        type, name = "tool_use", "ver_dueno"
        input = {"que_hace": "riéndose", "conducta": "bhv_happy_wiggle", "reaccion": "contenta", "comentario": "¡Jaja!"}

    class Msgs:
        def create(self, **kw):
            calls.append(kw)
            return type("R", (), {"content": [Block()]})()

    monkeypatch.setattr(haiku, "_client", type("C", (), {"messages": Msgs()})())
    assert haiku.see_owner(JPG, {"animo": "SM_HAPPY"}, vision.ACTIONS)["que_hace"] == "riéndose"
    kw = calls[0]
    assert kw["tool_choice"] == {"type": "tool", "name": "ver_dueno"}
    assert kw["system"][0]["text"] == haiku.OWNER_SYSTEM + haiku.ESTILO
    assert kw["tools"][0]["input_schema"]["properties"]["conducta"]["enum"] == list(vision.ACTIONS)
    assert "enum" not in haiku.OWNER_TOOL["input_schema"]["properties"]["conducta"]
