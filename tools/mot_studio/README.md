# mot-studio

Visor y editor local de archivos `.mot` de EMO. Es un solo `index.html`: se abre con doble clic, sin servidor y sin internet.

**Uso:**
1. Botón "Abrir carpeta…" y elegir `C:\Users\ikann\emo_backup\spiffs\mot`, o "Abrir archivos…".
2. Los archivos se leen solo en el navegador. Nada se copia al repo ni se publica (09, R5: son de Living AI).
3. Lo exportado se descarga a la carpeta de descargas del navegador; muévelo a `emo_backup/` si lo vas a conservar.

## Qué hace

- **Lista de archivos:** cuadros, duración y modos (pose, paso, giro y los raros como `0x0e`), con búsqueda, filtro por prefijo (`d*`, `explore*`, `touch*`…) y casillas para encadenar en el orden en que se marcan.
- **Gráfica de S0..S3 contra el tiempo:** con clic se va a ese momento.
- **Duración del cuadro, dos lecturas** (PENDIENTE en 02):
  - "transición lineal": la pose se alcanza al final del cuadro, desde la anterior;
  - "salto y espera": la pose se toma al inicio y se sostiene.
- **Figura de EMO de frente:** reproducir y pausar, velocidad de 0.25× a 2×, cuadro a cuadro.
- **Mapa S0..S3 → pierna o pie, con "invertir":** se puede cambiar y se guarda en el navegador. Por omisión, S0 = pierna izquierda (GPIO21), S1 = pierna derecha (GPIO25), S2 = pie izquierdo (GPIO5) y S3 = pie derecho (GPIO26). Es el orden interno del firmware original sobre `GPIO_MAP` (02; `firmware/sesion1/sesion1.md`) y está marcado "sin confirmar" hasta la sesión 1.
- **Editor:**
  - ángulos y duración;
  - insertar, duplicar y borrar cuadros;
  - espejar (S0↔S1, S2↔S3);
  - escalar la amplitud alrededor de 90°;
  - deshacer todos los cambios.

  Solo se editan los cuadros de pose. Los de paso, giro y modos raros se muestran marcados, pasan intactos y no se pueden borrar.
- **Límites:** marca en rojo los ángulos fuera del rango observado por servo (S0 40–160, S1 53–130, S2 0–150, S3 30–180; 02) y las duraciones fuera de 40–6400 ms. Con errores no deja exportar.
- **Exportar:** genera cada cuadro con `build()` (firma `55 AA 55 AA`, checksum = suma de bytes 4..17, fin `0xED`), lo vuelve a leer con `parse()` y lo descarga. Si hubo cambios, el nombre lleva `_editado`.

El núcleo es el bloque `<script id="mot-core">`: un port de `alma-spec/tools/mot_tool.py` con las mismas funciones (`checksum`, `parse`, `build`) y los mismos campos (`type`, `mode`, `gait`, `s`, `ms`).

## Pruebas

```
sh test/test.sh            # Git Bash; usa node y el venv de emo_tools
```

- **Parser:** el `parse` de JS da los mismos cuadros que `mot_tool.parse` en los 317 archivos (7488 cuadros).
- **Exportar sin cambios** da los mismos bytes que el original en los 317.
- **Ediciones:** escalar, espejar, encadenar (con un archivo de paso), insertar, duplicar, borrar y editar a mano dan archivos que `mot_tool.py` valida.
- **Validador:** detecta ángulos y duraciones fuera de rango, y no juzga como ángulos los parámetros de paso.
- **Interpolación:** se comprueba en los dos modos.

Las pruebas ejecutan en Node el mismo bloque `mot-core` de `index.html`. Lo exportado va a una carpeta temporal que se borra al terminar.
