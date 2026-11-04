# alma-relay

Nube de Alma (`alma-spec/07-nube.md`): la app del dueño (PWA con notificaciones), el enlace cifrado con el robot y los
pases a Haiku y Groq. Solo sugiere; las decisiones las toma el robot.

## Correr

```
pip install -r requirements.txt
python -m uvicorn alma_relay.app:app --host 127.0.0.1 --port 8000
```

La primera vez, la consola del servidor muestra un **código de instalación** de un solo uso (también queda en
`data/setup_code.txt`). Con él se crea la contraseña en la app. Las llaves de Claude y Groq y la **llave del enlace**
del robot se escriben en la app (Ajustes) y se guardan en `data/settings.json` (permisos 0600). El código no las
imprime ni las devuelve. `ALMA_RELAY_DATA` cambia la carpeta de datos.

## Puertos (droplet)

| Puerto | Quién | Qué |
|---|---|---|
| 443 (HTTPS) | el celular | la app y `/app/*`, con TLS (por ejemplo Caddy con certificado automático) → `127.0.0.1:8000` |
| 8080 (HTTP, sin TLS) | el robot | solo `/v1/robot` (WebSocket) → `127.0.0.1:8000` |

El robot va sin TLS para no gastar su RAM (decisión del dueño, 2026-10-30). Lo protege el enlace (`alma_relay/link.py`):
llave simétrica de 32 bytes, reto del servidor, llave de sesión nueva en cada conexión, AES-256-GCM y contadores contra
repeticiones. Sin la llave no se entra ni se lee nada. La misma llave está en el firmware (`ALMA_DEV_LINK_KEY` en
`alma_dev_creds.h`, fuera del repo).

Ejemplo de Caddyfile:

```
alma.ejemplo.com {
    reverse_proxy 127.0.0.1:8000
}
:8080 {
    handle /v1/robot {
        reverse_proxy 127.0.0.1:8000
    }
    handle {
        respond 404    # con "respond" suelto, Caddy lo aplica antes que reverse_proxy
    }
}
```

## Enlace del robot (`/v1/robot`)

Robot → servidor: `{"t":"state", …}` cada 5 s, `{"t":"event","ev":"new_face"|"home_failed"|"falls", …}` y
`{"t":"night","summary":{…}}` en el pase nocturno. Servidor → robot: `{"t":"welcome"}`, `{"t":"command","action_id":…}`
desde la app y `{"t":"night_result", …}` con los límites de 07. Las notificaciones push están en `alma_relay/notify.py`.

## Endpoints antiguos

- `POST /v1/voice`, multipart: `audio` (WAV PCM s16le 16 kHz mono, ≤ 10 s y ≤ 400 KB), `person_id`, `lang`. Responde `{"intent","action_id","confidence","transcript","source"}` con `source` = `rule` | `haiku`.
- `POST /v1/night`, JSON: `{"summary": …, "previous": […], "assets": […]}`.

Las frases de la ruta de reglas están en `alma_relay/rules.py` como datos (tabla de 05, "Órdenes de voz").

## Pruebas (sin red)

```
python -m pytest
```

`tests/test_uplink_c.py` corre el enlace del firmware (C) contra este servidor si existe
`alma/firmware/f2/test/build/uplink_pc` (lo compila `alma/firmware/f2/test/build.sh`).
