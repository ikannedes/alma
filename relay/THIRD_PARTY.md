# Código y arte de terceros

## Reglas para agregar algo aquí

Vienen del plan de juegos del dueño (PLAN-JUEGOS, 2026-10-31):

- **Licencias aceptadas:** solo código con licencia clara (MIT o CC0) o, en el caso de Moss & Ember, AGPL-3.0.
- **Avisos:** se conservan el `LICENSE` y los avisos de cada repo.
- **Sin licencia publicada, no se toca.** El arte que no sea libre se reemplaza.
- **Nombres:** los juegos llevan nombres propios en la app. "Quoridor", "Onitama" y "Clash Royale" son marcas y no se usan.

Los juegos viven en `alma/games/<juego>/`. Se construyen en la PC y se sirven en `/play/<juego>/`, solo con la sesión del dueño. En todos, la IA original se quitó: la rival es Alma, con Haiku en el relay y el puente `alma/games/_alma/alma.js`.

| Juego en la app | Repo | Commit | Licencia | Qué se tomó | Qué no |
|---|---|---|---|---|---|
| Dados mentirosos (`dados`) | github.com/crper/dice-game | `f87832b` | MIT © 2026 dice-game-3d contributors | Todo el juego (React 19, Three.js, Tailwind, shadcn/ui), reglas e i18n. Se agregó el español. | Su IA (`aiRespond`, `aiFirstCall`) ya no se usa; la sustituye `src/alma/almaPlayer.ts`. No trae arte ni audio de terceros: el sonido y las texturas se generan en código. Fuente Geist (OFL 1.1, por npm `@fontsource-variable/geist`). |
| Batalla naval (`naval`) | github.com/KelvinQiu802/battleship (sustituye a albertogiacomel/Battleship, que no tiene licencia) | `1973ba1` | MIT © 2022 KelvinQiu | Reglas (`boardTools.js`, `blockStates.js`, `gameState.js`, `ships.js`), componentes React adaptados y colocación al azar de los barcos de Alma. Se pasó a Vite 8 sin MUI y con la interfaz solo en español. | Su IA de disparo (`randomAttack`, `addPotentialTarget`, `attackPotentialTarget`). `public/shipGroup.png` y `favicon.svg`, de origen desconocido: se sustituyeron por SVG dibujados para Alma. Roboto de Google Fonts: se usa la fuente del sistema. |
| Maestros (`maestros`) | github.com/jackadamson/onitama | `fe03d8c` | MIT © 2021 Jack Adamson | Las reglas, portadas de Rust a TypeScript (`board.rs`, la parte base de `cards.rs`, `models.rs`, `move_gen.rs`), junto con sus pruebas, los patrones de las 16 cartas base, la estructura de los componentes React, la paleta de colores y el texto de reglas (traducido). Las cartas llevan nombres en castellano. | La IA (`agents/`), el servidor multijugador, Docker, el router, el service worker, los íconos del autor y las expansiones. "Onitama" solo aparece en comentarios de atribución. |
| Batalla de torres (`torres`) | github.com/ThatXliner/clash-royale-clone ("Moss & Ember") | `75d30d1` | **AGPL-3.0-only** © contribuidores de ThatXliner/clash-royale-clone; LICENSE y NOTICE sin cambios | El juego (simulación, interfaz, arte propio del repo y audio procedural CC0-1.0). El lado norte lo maneja Alma: `GameSession.submitNorthCommand`, sin el bot integrado. Los textos de pantalla están traducidos al español. Cada archivo original modificado lleva la nota "Modificado para Alma, 2026-10-31". Fuente Barlow Condensed Bold (OFL 1.1, © 2017 The Barlow Project Authors), publicada en `licencias/`. | `reference/` (material de terceros, no redistribuible), `artifacts/`, `demo/` y las herramientas de desarrollo. No hay nombres de terceros en la interfaz. AGPL §13: `licencias.html` ofrece la licencia y el aviso, y dice dónde está el código (`alma/games/torres`). |
| Muros (`muros`) | github.com/22ABLE22/quoridor | `a82101a` | MIT © 2026 22ABLE22 | `rules.js`, `render.js` e `input.js` sin cambios, más dos pruebas y los colores y estilos de `app.css` (adaptados en `muros.css`). Fuente Manrope del mismo repo (SIL OFL 1.1, © 2018 The Manrope Project Authors; el texto de la licencia se agregó en `assets/fonts/OFL.txt`). | `ai.js`, `ai-worker.js` y `search.test.mjs` (solo probaba la IA), además del porcentaje de victoria y el botón de deshacer. |
| Timbiriche (`timbiriche`) | github.com/HuXin0817/Dots-and-Boxes | `b54abcb` | MIT © 2025 Xin Hu | `board.js` y `board-topology.js` sin cambios, más la geometría del tablero y los estilos, adaptados. | `robots.js`, `robot-worker.js`, `puct-search.js`, `exact-solver.js`, `rule-evaluator.js`, `search-*` y `random.js`. No hay assets binarios. |

Ya estaban antes de este plan, y el dueño decidió dejarlos como están:

- **Backgammon:** bgammon y Boxcars, AGPL-3.0. Detalle en `third_party/bgammon/README.md`.
- **PlayStrategy:** el bot usa su API pública. No se copia código suyo; las reglas de backgammon y oware de `backgammon.py` y `oware.py` se escribieron a partir de su código abierto (strategygames, GPL).

## Si algún día se publica

Si algo de esto deja de ser de uso privado del dueño:

- **AGPL-3.0** (bgammon, Boxcars, Moss & Ember): hay que ofrecer el código fuente completo, con nuestras modificaciones, a quien use el servicio.
- **MIT:** basta con conservar los avisos de copyright.
- **Fuentes OFL:** no se pueden vender por separado.

## Alma en el reloj (`alma/android/`, 2026-11-01)

| Qué | De dónde | Licencia | Uso |
|---|---|---|---|
| Fuente Montserrat SemiBold (`android/caratula/src/main/res/font/montserrat_semibold.ttf`) | github.com/JulietaUla/Montserrat, `fonts/ttf/Montserrat-SemiBold.ttf` | SIL OFL 1.1 © 2024 The Montserrat.Git Project Authors; texto en `android/third_party/Montserrat-OFL.txt` | Hora, fecha y números de la carátula (propuesta de diseño del dueño). |
| Bibliotecas de Android (AndroidX, Wear Compose, Tiles, Health Services, OkHttp, kotlinx) | Maven de Google y Maven Central, por Gradle | Apache 2.0 | Apps del reloj y del celular; se descargan al compilar, no se copian al repo. |
| Play Services Wearable (Data Layer) | Maven de Google | Términos del SDK de Android de Google (no es código abierto) | Solo el enlace reloj ⇄ celular; se descarga al compilar. |
