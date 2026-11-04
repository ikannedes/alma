# mot-studio 3D

Visor 3D de los `.mot` y de la marcha de EMO. Usa el mismo motor que alma-f2: la pose se mueve en su duración y
las primitivas 1 (caminar), 2 (girar) y 14 (balanceo) son osciladores (HALLAZGOS §5).

## Uso

- **Sin instalar nada:** abrir `dist/index.html` con doble clic, y luego "Abrir carpeta…" → `C:\Users\ikann\emo_backup\spiffs\mot`.
- Los `.mot` se leen solo en el navegador. Son de Living AI (09, R5): no se copian al repo ni se publican.
- **Desarrollo:** `npm install` y luego `npm run dev` (Vite, http://localhost:5173), o `npm run build` para regenerar `dist/index.html`.

## Qué muestra

- EMO en 3D: cabeza con pantalla, caderas (S0 izquierda, S1 derecha) y pies (S2 izquierdo, S3 derecho), con las marcas de los sensores de piso adelante y atrás de cada pie.
- Reproducir, pausar, cuadro a cuadro, velocidad de 0.25× a 2× y repetir; huella del camino.
- Gráfica de S0..S3 contra el tiempo (los tramos de marcha, sombreados): con clic se salta a ese momento.
- Panel con el cuadro actual: tipo, ángulos y, en las primitivas, ciclos, `T`, dirección y bytes 7–12.

## Qué es exacto y qué no

- **Exactos:** los ángulos. Son los mismos que manda alma-f2.
  - `sh test/test.sh` compara el motor muestra por muestra contra la referencia privada (`emo_backup/re/marcha_ref.c`).
  - Resultado: las primitivas de los 317 `.mot`, 9698 muestras, 0 distintas.
- **Aproximado:** cómo se mueve el cuerpo. El pie apoyado queda fijo, el cuerpo se ladea con los pies y gira sobre el pie apoyado con su cadera. Sirve para ver si un movimiento avanza, gira o se ladea, no como física.
- **Por confirmar en el robot:** el sentido de cada servo (casillas "invertir", se guardan en el navegador).
  - **Medido en el robot (2026-10-30): los cuatro invertidos** (`[-1,-1,-1,-1]`, el valor por omisión). Es la única combinación con la que `explore_foward`, `explore_back_away` y `explore_turn_left/right` van a donde dicen y `explore_foward1` levanta primero el pie derecho, como EMO (`node test/smoke.mjs <carpeta_mot>`).

## Editor

- **Cuadro actual:** ángulos y duración de una pose; ciclos, `T`, amplitudes, desvío, fase y dirección de una primitiva.
- **Agregar:** pose (con los ángulos de ese momento), caminar o girar. También duplicar, borrar y mover el cuadro.
- **Todo el movimiento:**
  - **espejar** izquierda/derecha: S0↔S1 y S2↔S3 con `180 − x`, como `cliff_L`/`cliff_R`; en los giros cambia la dirección. *mot_studio solo intercambia, sin `180 − x`: es un error suyo.*
  - **tiempo ×:** acelerar (< 1) o frenar (> 1); en las primitivas cambia `T`. Es la forma de "hacerlo correr".
  - **amplitud ×:** en las poses, alrededor de 90.
  - **deshacer cambios.**
- **Validación como alma-f2:** rango observado por servo (R10), también simulando cada primitiva, y duraciones de 40 a 6400 ms. Con errores no exporta.
- **Exportar:**
  - `.mot`, que se vuelve a leer antes de bajarlo. Sin cambios sale byte a byte igual al original (probado en los 317).
  - JSON en el formato `alma-anim/1`. También se puede importar un JSON.

## Formato de texto `alma-anim/1` (para escribir animaciones a mano o con Claude)

```json
{ "formato": "alma-anim/1", "nombre": "baile",
  "cuadros": [
    { "pose": [90, 90, 90, 90], "ms": 300 },
    { "pausa": 200 },
    { "caminar": { "ciclos": 2, "T": 800, "caderas": 15, "pies": 10, "desvio": 0, "fase": 0, "dir": "adelante" } },
    { "girar": { "ciclos": 1.5, "T": 900, "cadera_a": 12, "cadera_b": -12, "pies": 10, "desvio": 0, "fase": 0, "dir": "izquierda" } },
    { "balanceo": { "ciclos": 2, "T": 800, "altura": 20, "fase": 10 } },
    { "crudo": "55aa55aa…" }
  ] }
```

- **pose:** S0 cadera izquierda, S1 cadera derecha, S2 pie izquierdo, S3 pie derecho, en grados; se llega en `ms`.
- **caminar** (tipo 1), **girar** (2) y **balanceo** (14): `ciclos` (de 0.1 en 0.1) y `T` (ms por ciclo).
  - Las amplitudes pueden ser negativas (de −55 a 200).
  - `dir`: `adelante`, `atras` o `sitio` al caminar; `izquierda` o `derecha` al girar. Con `_y_neutro`, vuelve a 90 al final. Que `adelante` y `izquierda` sean lo que dicen es probable; lo confirma el robot.
- **crudo:** cualquier registro de 20 bytes tal cual. Lo usan los tipos que no tienen editor.
- **Campos `b4` y `bytes`:** solo aparecen al convertir un `.mot` de fábrica; guardan los bytes que el formato no nombra, para que la ida y vuelta sea exacta.

## Línea de comandos

```
node cli.mjs info ejemplos/alma_hola.json                 # resumen, rangos, validación, cuánto avanza y gira
node cli.mjs to-mot ejemplos/alma_hola.json salida.mot    # valida y escribe
node cli.mjs to-json <archivo.mot> salida.json
```

`ejemplos/alma_hola.json` es la primera animación escrita por Claude: balanceo, ladeo, dos pasos adelante, giro a la izquierda y meneo de caderas, en 7.9 s. Valida, pero está **sin probar en el robot**.

## Pruebas

`sh test/test.sh` compila la referencia y compara, en los 317 `.mot`:
- las 165 primitivas, muestra por muestra (9698 muestras, 0 distintas);
- la duración;
- exportar sin cambios, la ida y vuelta por JSON y espejar dos veces: todos dan los mismos bytes;
- que la validación detecte errores.

`node test/smoke.mjs <carpeta_mot>` muestra cuánto avanza y gira cada `explore_*`.

## Siguiente

- **En el robot:** confirmar el sentido de cada servo y que los ángulos coinciden, mirando lado a lado el simulador y EMO con la misma animación.
- **Después:** bailes y movimientos propios. Cómo llegan a EMO está por decidir: alma-f2 lee los `.mot` del SPIFFS de fábrica, que es solo lectura. Las opciones son guardarlos en la región propia de Alma o recibirlos por el relay o por USB; el ESP32 los ejecuta igual que un `.mot` de fábrica.

## Desde el celular (Tailscale)

`node serve.mjs [carpeta_mot] [puerto]` sirve `dist/index.html` y, solo para leer, los `.mot` de la carpeta (por omisión
`C:\Users\ikann\emo_backup\spiffs\mot`, puerto 4310), escuchando únicamente en 127.0.0.1. Luego
`tailscale serve --bg --https=8443 http://127.0.0.1:4310` lo publica solo en la tailnet (nunca `funnel`): abre
`https://ikan-laptop.tail8c5308.ts.net:8443/` y la lista se carga sola. En pantallas angostas el visor va en una columna.
Para quitarlo: `tailscale serve --https=8443 off` y cerrar el proceso de node.

## La escena

- **Física de apoyo:** el contacto es el contorno real de lo que se dibuja (envolvente convexa de cada pie): el punto más bajo queda siempre en el piso.
  - **Pies inclinados hacia el mismo lado** (el vaivén de la marcha): el pie apoyado queda plano y el cuerpo se ladea, así que el otro pie se levanta. Solo pasa si el centro de masa cae sobre ese pie; si no, queda sobre los cantos.
  - **Pies en espejo** (los dos hacia adentro o hacia afuera): queda sobre los cantos de los dos y se levanta.
  - **El pie apoyado queda anclado:** su punto de contacto y su rumbo no cambian, y el cuerpo gira y se desplaza alrededor de él; así avanza y gira.
- **Verificación** (`?verificar=1`, o `node revisar.mjs verificar` en `emo_tools/navegador`): recorre los 317 `.mot` cada 20 ms con las mallas que se dibujan y las matrices de three.js, sin usar las cuentas de `robot.js`. Mide:
  - si una pieza se mete al piso o el robot flota;
  - si el pie anclado resbala;
  - cuánto se arrastra el otro pie cuando los dos están en el piso y las caderas se tuercen;
  - cuánto sube con los pies en espejo y cuánto se levanta un pie en el vaivén.
- **Ángulos:** un abanico de color por servo, desde 90° hasta el ángulo actual. Las caderas tienen un anillo horizontal y los pies medio anillo delante de la punta. Las tarjetas de abajo muestran el número y los cuatro sensores de piso (verde = ve piso, rojo = al aire).
- **Vistas:** 3/4, frente, lado y arriba (arriba activa los rayos X). Además: rayos X (servos, placa con ESP32 y K210, batería), separar piezas y exagerar ×2 o ×3, que solo agranda lo que se ve; los números siguen siendo los reales.
- **Huellas** de cada pie al volver a tocar el piso.
- **Enlaces:** `#nombre@segundos` abre una animación en ese momento; `?xray=1&sep=0.6&exag=2&vista=frente&angulos=0` fija las opciones.

## Modelo CAD

Con `serve.mjs`, el visor usa el modelo CAD de EMO en lugar de las piezas dibujadas (`/modelo.glb`). El modelo es de su autor y **no va al repo**: vive en `C:\Users\ikann\emo_tools\step2glb\`.

- `inspect.mjs <archivo.step> <salida.json>`: lee el STEP con OpenCascade (occt-import-js) y lista los cuerpos.
- `medir.mjs` mide el plano de las suelas y el eje de las piernas.
- `articular.mjs <json> <salida.glb>` endereza el modelo a la pose neutra y lo separa en cuerpo, pantalla, `pierna_L/R` (origen en la cadera) y `pie_L/R` (origen en el tobillo).
  - El eje del tobillo pasa por los dos pernos de cada pie.
  - El de la cadera, por el eje de la pierna.
- Las medidas de la física salen de ahí: caderas a ±1.32 cm, pierna de 3.08 cm, pie de 3.35 × 3.8 cm con el tobillo a 1.15 cm de la suela y 0.65 cm hacia adentro del centro del pie.
- Sin el modelo (al abrir `dist/index.html` directo), quedan las piezas dibujadas con las mismas medidas.
