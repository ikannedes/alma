# Backgammon dentro de la app (bgammon + Boxcars)

Decisión del dueño (2026-10-31): los juegos van dentro de la app de Alma, pero con diseños hechos por otros
(proyectos abiertos), uno por juego. Para backgammon:

- **Servidor:** [bgammon](https://codeberg.org/tslocum/bgammon), commit `3f1abcf1e80f` (2026-09-14).
- **Tablero:** [Boxcars](https://codeberg.org/tslocum/boxcars), commit `5965b00ee4a3` (2026-09-14). Está en Go con
  Ebitengine y se compila a WebAssembly.
- **Autor y licencia:** los dos son de Trevor Slocum, con licencia **AGPL-3.0**. La fuente M+ es OFL.
- **Uso:** la app es privada, la usa solo el dueño, y el código con los cambios está aquí.

## Cómo encaja

```
celular ──https──▶ Caddy ── /bg/*    (solo con sesión) ──▶ /opt/boxcars (index.html, wasm_exec.js, boxcars.wasm)
                        └── /bg/ws   (solo con sesión) ──▶ bgammon 127.0.0.1:1338 (WebSocket)
relay (bgammon_alma.py) ──TCP 127.0.0.1:1337──▶ bgammon  (Alma entra como "alma")
```

- **Abrir el tablero:** la app abre `/bg/?u=<dueño>&j=alma` y Boxcars entra directo a la partida de Alma.
- **Partida abierta:** Alma siempre tiene una. En su turno, `bgammon_alma.py` hace lo siguiente:
  - tira los dados;
  - elige el turno completo con Haiku (usa `backgammon.py` y `games.choose`, como en PlayStrategy);
  - lo manda paso a paso, comprobando que cada paso esté en la lista `Available` de bgammon.
- **Permisos:** Caddy deja pasar `/bg/*` solo si `/app/auth` confirma la sesión del dueño. bgammon no queda abierto a internet.

## Parches (`bgammon.patch`, `boxcars.patch`)

**bgammon:**
- Sin el prefijo `Guest_` en los nombres. Es un servidor privado sin cuentas.
- Una partida sin terminar entre dos jugadores se conserva aunque los dos se desconecten. Antes se borraba a los 15
  minutos sin jugar; ahora el plazo es de 30 días. Cuando el dueño vuelve, se retoma: es asíncrono.
- WebSocket sin TLS cuando no hay certificado, porque el TLS lo pone Caddy.

**Boxcars:**
- Lee `?u=` (nombre) y `?j=` (a quién unirse).
- Se conecta a `wss://<mismo sitio>/bg/ws` y entra directo a la partida.

**Limitación:** las partidas viven en la memoria de bgammon. Si se reinicia el servidor o bgammon, se pierde la partida
en curso y Alma abre otra. El diario conserva lo jugado.

## Compilar (en la PC, con Go ≥ 1.26)

```sh
git clone https://codeberg.org/tslocum/bgammon && (cd bgammon && git checkout 3f1abcf1e80f && git apply ../bgammon.patch)
git clone https://codeberg.org/tslocum/boxcars && (cd boxcars && git checkout 5965b00ee4a3 && git apply ../boxcars.patch)
(cd bgammon && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags full -o ../out/bgammon-server ./cmd/bgammon-server)
(cd boxcars && GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o ../out/boxcars.wasm .)
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" out/
```

El servidor (1 vCPU, 458 MB) no alcanza para compilar Boxcars; se compila en la PC y se sube el resultado.

## Instalar en el servidor

1. Crear el usuario: `useradd --system --no-create-home bgammon`.
2. Copiar `bgammon-server` a `/opt/bgammon/`.
3. Crear `/etc/bgammon.env` (0640 root:bgammon) con tres sales aleatorias:
   - `BGAMMON_SALT_RESET`
   - `BGAMMON_SALT_PASSWORD`
   - `BGAMMON_SALT_IP`
4. Instalar `bgammon.service` y arrancarlo.
5. Copiar a `/opt/boxcars/` estos tres archivos: `index.html` (de esta carpeta), `wasm_exec.js` y `boxcars.wasm`.
6. Agregar las rutas `/bg/*` al Caddyfile, con `forward_auth` a `/app/auth`.
