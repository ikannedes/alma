# Escenarios de casa para entrenar la red de Alma

Cada escenario es un archivo JSON en `sim/brain/escenarios/`. Describe **cómo vive el dueño** (cuándo está, qué tan cerca,
cómo trata a Alma) durante una semana típica. El generador (`sim/brain_gen.c`) lo corre muchas veces con variaciones y,
en cada segundo, la mascota maestra decide qué hace Alma; esas decisiones son los ejemplos de entrenamiento.

El escenario **no** dice qué hace Alma: solo describe el mundo. Alma decide sola.

## Formato

```json
{
  "id": "oficinista_solo",
  "descripcion": "Vive solo, trabaja en oficina de 9 a 18; en la noche la acompaña en el escritorio.",
  "peso": 1.0,
  "dias": [
    {
      "nombre": "entre semana",
      "dias_semana": [0, 1, 2, 3, 4],
      "despierta": "06:45", "duerme": "23:15", "variacion_min": 20,
      "bloques": [
        {"desde": "06:50", "hasta": "07:40", "dueno": "cerca", "en_base": true,
         "caricias_h": 6, "felicita_h": 2, "regana_h": 0.1, "ordenes_h": 1, "levanta_h": 0.2,
         "de_frente_p": 0.5, "responde_p": 0.5},
        {"desde": "08:20", "hasta": "18:10", "dueno": "fuera", "en_base": true},
        {"desde": "18:30", "hasta": "20:00", "dueno": "casa", "en_base": false, "pasa_h": 3},
        {"desde": "20:00", "hasta": "21:00", "dueno": "juego", "en_base": false,
         "caricias_h": 15, "felicita_h": 6, "regana_h": 0.3, "ordenes_h": 4, "levanta_h": 1,
         "de_frente_p": 0.8, "responde_p": 0.8},
        {"desde": "21:00", "hasta": "23:00", "dueno": "cerca", "en_base": false,
         "caricias_h": 4, "felicita_h": 1, "regana_h": 0.2, "ordenes_h": 0.5,
         "de_frente_p": 0.3, "responde_p": 0.3}
      ],
      "visita": {"desde": "17:00", "hasta": "19:00", "p": 0.05},
      "ruidos_dia": 1.0,
      "musica_dia": 0.3
    }
  ]
}
```

### Campos

| Campo | Qué es |
| --- | --- |
| `id` | Nombre corto, sin espacios. |
| `descripcion` | Una o dos frases: quién es el dueño y cómo es su vida. |
| `peso` | Cuántas veces más se usa este escenario que uno de peso 1 (0,2–3). |
| `dias` | Plantillas de día. Entre todas deben cubrir los 7 días (`dias_semana`: 0 = lunes … 6 = domingo). Un día puede tener varias plantillas con `p` (probabilidad de usarla ese día; suman 1). |
| `despierta`, `duerme` | Hora en que el dueño se levanta y se acuesta. Al acostarse, deja a Alma en la base. `null` en los dos = ese día no hay dueño (viaje). |
| `variacion_min` | Desviación típica, en minutos, que se aplica a cada hora del día (despertar, bloques). |
| `bloques` | Tramos sin huecos ni encimados entre despertar y dormir. Lo que no cubre ningún bloque cuenta como `casa`. |
| `dueno` | `fuera` (no está en casa) · `casa` (en otro cuarto; pasa frente a Alma de vez en cuando) · `cerca` (frente al escritorio; su cara se ve a ratos) · `juego` (cerca y jugando con ella). |
| `en_base` | `true` si en ese tramo Alma está en la base de carga (no camina; solo cara y sonidos). `false` = en la mesa. |
| `pasa_h` | Solo en `casa`: veces por hora que el dueño pasa frente a Alma (10–40 s cada vez). |
| `caricias_h`, `felicita_h`, `regana_h`, `ordenes_h`, `levanta_h` | Veces por hora que el dueño la acaricia, la felicita de palabra, la regaña, le da una orden de voz o la levanta, **por iniciativa propia**, en `cerca` o `juego`. |
| `de_frente_p` | Fracción del tiempo en que la cara del dueño se ve de frente mientras está `cerca` (el resto se ve de lado o no se ve). |
| `responde_p` | Probabilidad de que el dueño responda (caricia o palabra) cuando Alma le pide atención o lo invita a jugar. |
| `visita` | Caras desconocidas en ese horario con probabilidad `p` ese día. Opcional. |
| `ruidos_dia`, `musica_dia` | Ruidos fuertes y ratos de música esperados por día. Opcionales. |
| `p` (en una plantilla de día) | Probabilidad de usar esa plantilla en los días de `dias_semana` que comparte con otras. |

## Qué se busca

Variedad realista de vidas (no la del escenario de ejemplo repetida): horarios distintos, dueños atentos y distraídos,
cariñosos y bruscos, días de oficina, de casa, de viaje, de enfermedad, fines de semana distintos. Las tasas por hora
deben ser creíbles para una persona con una mascota de escritorio, no para una que la usa como juguete todo el día.
