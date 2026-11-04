"""Álbum de Alma (album.py; dueño, 2026-11-01): fotos que le enseña el dueño, su reacción con Haiku y los pedidos."""

import asyncio
import datetime as dt
import io

from PIL import Image

from alma_relay import alarms, album, haiku, milestones, settings, vision, web
from tests.test_web import _setup, c  # noqa: F401


def _at(month: int, day: int, h: int = 12, year: int = 2026) -> float:
    return dt.datetime(year, month, day, h, 0, tzinfo=alarms.tz()).timestamp()


def _photo(w=3000, h=2000, gps=True) -> bytes:
    """Una foto "de teléfono" grande, con EXIF de ubicación."""
    im = Image.new("RGB", (w, h), (200, 30, 30))
    out = io.BytesIO()
    exif = Image.Exif()
    if gps:
        exif[0x8825] = {2: (19.0, 26.0, 0.0), 1: "N"}   # GPSInfo
        exif[0x0110] = "Teléfono del dueño"
    im.save(out, "JPEG", exif=exif)
    return out.getvalue()


def _haiku(monkeypatch, **over):
    calls = []

    def fake(jpg, state, actions):
        calls.append((jpg, state, actions))
        return {"que_es": "Alma con un gorro de Santa", "sale_alma": True, "le_gusta": "le encanta",
                "conducta": "bhv_happy_wiggle", "reaccion": "contenta", "comentario": "¡Me veo hermosa!",
                "titulo": "Mi gorrito navideño"} | over
    monkeypatch.setattr(haiku, "see_photo", fake)
    return calls


def test_sube_reduce_sin_ubicacion_y_reacciona(c, monkeypatch):  # noqa: F811
    _setup(c)
    settings.update(anthropic_key="sk-falsa")
    calls = _haiku(monkeypatch)
    web.hub.state = {"age_days": 33, "traits": {"trait_playfulness": 0.8}, "simple_mood": "SM_HAPPY"}
    sent = []

    async def fake_send(m):
        sent.append(m)
        return True
    monkeypatch.setattr(web.hub, "send", fake_send)
    now = _at(12, 3)
    orig = album.pedidos
    monkeypatch.setattr(album, "pedidos", lambda t=None: orig(now))   # como si fuera 3 de diciembre
    ped = next(p for p in album.pedidos() if p["occasion"] == "navidad")
    r = c.post("/app/album", files={"foto": ("x.jpg", _photo(), "image/jpeg")}, data={"pedido": ped["id"]})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["le_gusta"] == "le encanta" and b["occasion"] == "navidad" and b["age_days"] == 33
    jpg, state, actions = calls[0]
    assert max(Image.open(io.BytesIO(jpg)).size) == album.SIDE_HAIKU          # a Haiku, 1024 px
    assert state["ocasion"].startswith("Navidad") and set(state["gustos"]) == {"le_encantan", "le_gustan", "no_le_gustan"}
    assert actions is vision.ACTIONS
    full = c.get(f"/app/album/{b['id']}.jpg").content
    im = Image.open(io.BytesIO(full))
    assert max(im.size) == album.SIDE and not im.getexif()                    # reducida y sin ubicación
    assert max(Image.open(io.BytesIO(c.get(f"/app/album/{b['id']}_t.jpg").content)).size) == album.SIDE_THUMB
    assert sent == [{"t": "seen", "origen": "app", "objeto": "Alma con un gorro de Santa", "reaccion": "contenta",
                     "conducta": "bhv_happy_wiggle", "comentario": "¡Me veo hermosa!"}]
    v = c.get("/app/album").json()
    assert [p["id"] for p in v["photos"]] == [b["id"]] and ped["id"] not in [p["id"] for p in v["pedidos"]]
    titles = [m["title"] for m in milestones.listing()["milestones"]]
    assert "Su primera foto en el álbum" in titles and "Su primera Navidad" in titles
    assert album.today_summary() == ["Mi gorrito navideño (le encanta)"]
    assert c.delete(f"/app/album/{b['id']}").json() == {"ok": True}
    assert c.get(f"/app/album/{b['id']}.jpg").status_code == 404 and c.get("/app/album").json()["photos"] == []


def test_valida_lo_que_dice_haiku_y_errores(c, monkeypatch):  # noqa: F811
    _setup(c)
    settings.update(anthropic_key="sk-falsa")
    _haiku(monkeypatch, le_gusta="muchísimo", conducta="bhv_explotar", reaccion="feliz")
    r = c.post("/app/album", files={"foto": ("x.jpg", _photo(400, 300, gps=False), "image/jpeg")}).json()
    assert (r["le_gusta"], r["conducta"], r["reaccion"]) == ("le da igual", None, "confundida")
    assert c.post("/app/album", files={"foto": ("x.txt", b"hola", "text/plain")}).json()["error"] == "no es una imagen"
    assert c.post("/app/album", data={"pedido": "x"}).status_code == 400
    c.post("/app/logout")
    assert c.get("/app/album").status_code == 401 and c.get(f"/app/album/{r['id']}.jpg").status_code == 401


def test_guarda_la_ultima_foto_de_cerca(c, monkeypatch):  # noqa: F811
    _setup(c)
    assert c.post("/app/album/keep").json()["error"] == "no hay foto reciente"
    buf = io.BytesIO()
    Image.new("RGB", (320, 240), (0, 0, 0)).save(buf, "JPEG")
    monkeypatch.setattr(vision, "_last", {"jpg": buf.getvalue(), "at": 1_800_000_000, "objeto": "una pelota",
                                          "reaccion": "contenta", "comentario": "¡Una pelota!"})
    r = c.post("/app/album/keep").json()
    assert r["source"] == "robot" and r["titulo"] == "Vio de cerca: una pelota" and r["comentario"] == "¡Una pelota!"
    assert c.post("/app/album/keep").json()["error"] == "esa foto ya está en el álbum"


def test_pedidos_por_fecha_cumple_y_antojo(c):  # noqa: F811
    _setup(c)
    occ = lambda t: {p["occasion"] for p in album.pedidos(t)}
    assert occ(_at(11, 1)) == {"muertos", "antojo"}
    assert occ(_at(12, 25)) == {"navidad", "antojo"} and occ(_at(12, 26)) == {"antojo"}
    assert "anio_nuevo" in occ(_at(1, 1)) and [p["id"] for p in album.pedidos(_at(1, 1, year=2027))
                                                 if p["occasion"] == "anio_nuevo"] == ["anio_nuevo_2026"]
    a = [p for p in album.pedidos(_at(3, 3)) if p["occasion"] == "antojo"]
    assert a == [p for p in album.pedidos(_at(3, 3, 20)) if p["occasion"] == "antojo"]   # el mismo antojo esos días
    album.close(a[0]["id"])
    assert occ(_at(3, 3)) == set()
    milestones.on_state({"age_days": 30}, now=_at(3, 4))
    assert [p["id"] for p in album.pedidos(_at(3, 5)) if p["occasion"] == "cumple"] == ["cumple_30"]
    assert occ(_at(3, 9)) <= {"antojo"}                                                       # a los 3 días ya no


def test_avisa_los_pedidos_de_dia_y_una_vez(c, monkeypatch):  # noqa: F811
    _setup(c)
    from alma_relay import notify
    notify.subscribe({"endpoint": "https://x"})
    run = lambda t: asyncio.run(web._album_tick(dt.datetime.fromtimestamp(t, dt.timezone.utc)))
    assert run(_at(12, 1, 22)) == []                                       # de noche no
    assert run(_at(12, 2, 9)) == ["navidad_2026"]
    assert run(_at(12, 2, 10)) == []
    assert [p["title"] for p in c.sent] == ["🎄 Alma te pide una foto"]
