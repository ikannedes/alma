"""Genera android/caratula/src/main/res/raw/watchface.xml (Watch Face Format v1) según la propuesta del dueño
(2026-11-01): modo Alma (ella vive en el reloj: hora, fecha, sus ojos grandes, batería abajo) y modo reloj (ella está
en otro cuerpo: fecha, hora, pasos, sus ojitos en un anillo, pulso y batería en arco). Ambiente atenuado.

La app del reloj publica la complicación mx.alma.reloj.Carita con un número: dónde × 10 + expresión
(Instantanea.codigo). Dónde: 0 robot, 1 reloj, 2 mudándose. Expresión: el orden de EXPR.

Uso: python caratula_xml.py <salida.xml>
"""

import sys

EXPR = ["asustada", "sueno", "enojada", "triste", "feliz", "feliz", "neutral", "parpadeo", "enamorada"]
FUENTE = "montserrat_semibold"
BLANCO, GRIS, CIAN, AZUL_OSC, LINEA = "#FFFFFFFF", "#FFA0AEC0", "#FF00E5FF", "#FF0040CC", "#FF1F2733"


def texto(x, y, w, h, tam, color, plantilla, params, amb=None):
    ps = "".join(f'<Parameter expression="{p}" />' for p in params)
    v = f'<Variant mode="AMBIENT" target="alpha" value="{amb}" />' if amb is not None else ""
    return (f'<PartText x="{x}" y="{y}" width="{w}" height="{h}">{v}<Text align="CENTER">'
            f'<Font family="{FUENTE}" size="{tam}" color="{color}"><Template><![CDATA[{plantilla}]]>{ps}</Template>'
            f'</Font></Text></PartText>')


def imagen(x, y, w, h, recurso, amb=None):
    v = f'<Variant mode="AMBIENT" target="alpha" value="{amb}" />' if amb is not None else ""
    return f'<PartImage x="{x}" y="{y}" width="{w}" height="{h}">{v}<Image resource="{recurso}" /></PartImage>'


def hora(x, y, w, h, tam):
    """La hora respeta 12/24 h del reloj (la carátula WFF no tiene DigitalClock dentro de una complicación)."""
    return ('<Condition><Expressions><Expression name="h24"><![CDATA[[IS_24_HOUR_MODE] == 1]]></Expression></Expressions>'
            f'<Compare expression="h24">{texto(x, y, w, h, tam, BLANCO, "%s:%s", ["[HOUR_0_23_Z]", "[MINUTE_Z]"])}</Compare>'
            f'<Default>{texto(x, y, w, h, tam, BLANCO, "%s:%s", ["[HOUR_1_12]", "[MINUTE_Z]"])}</Default></Condition>')


def fecha(y, tam):
    return texto(0, y, 450, tam + 10, tam, GRIS, "%s %s %s", ["[DAY_OF_WEEK_S]", "[DAY]", "[MONTH_S]"])


def bateria(y):
    return imagen(166, y, 40, 40, "ico_bateria", amb=0) + texto(206, y, 90, 40, 26, CIAN, "%s%%", ["[BATTERY_PERCENT]"], amb=0)


def arco(x, y, w, h, ini, fin, color, grueso, extra=""):
    return (f'<PartDraw x="{x}" y="{y}" width="{w}" height="{h}"><Variant mode="AMBIENT" target="alpha" value="0" />'
            f'<Arc centerX="{w / 2}" centerY="{h / 2}" width="{w - grueso}" height="{h - grueso}" startAngle="{ini}" endAngle="{fin}">'
            f'{extra}<Stroke color="{color}" thickness="{grueso}" cap="ROUND" /></Arc></PartDraw>')


def por_expresion(base, recurso, x, y, w, h, amb):
    """Una imagen por expresión, elegida con el número de la complicación."""
    exps = "".join(f'<Expression name="e{i}"><![CDATA[[COMPLICATION.RANGED_VALUE_VALUE] == {base + i}]]></Expression>'
                   for i in range(len(EXPR)))
    cmps = "".join(f'<Compare expression="e{i}">{imagen(x, y, w, h, recurso + EXPR[i], amb)}</Compare>' for i in range(len(EXPR)))
    return f'<Condition><Expressions>{exps}</Expressions>{cmps}<Default>{imagen(x, y, w, h, recurso + "neutral", amb)}</Default></Condition>'


def modo_alma():
    return (hora(0, 62, 450, 96, 84) + fecha(156, 26) + imagen(330, 74, 44, 44, "acentos_der", amb=0)
            + por_expresion(10, "ojos_", 55, 192, 340, 190, amb=110) + bateria(384))


def circulo(cx, icono, valor, etiqueta):
    return (arco(cx - 52, 218, 104, 104, 0, 360, LINEA, 3)
            + imagen(cx - 20, 226, 40, 40, icono, amb=0)
            + texto(cx - 52, 264, 104, 30, 24, BLANCO, "%s", [valor], amb=0)
            + texto(cx - 52, 292, 104, 22, 16, GRIS, etiqueta, [], amb=0))


def modo_reloj(base_robot=True):
    ojitos = (por_expresion(0, "ojitos_", 170, 239, 110, 62, amb=120) if base_robot
              else imagen(170, 239, 110, 62, "ojitos_neutral", amb=120))
    return (fecha(54, 24) + hora(0, 80, 450, 104, 92)
            + imagen(84, 128, 44, 44, "acentos_izq", amb=0) + imagen(322, 128, 44, 44, "acentos_der", amb=0)
            + circulo(108, "ico_pasos", "[STEP_COUNT]", "pasos")
            + arco(160, 205, 130, 130, 0, 360, LINEA, 4) + arco(160, 205, 130, 130, 210, 450, CIAN, 4) + ojitos
            + circulo(342, "ico_pulso", "[HEART_RATE]", "lpm")
            + arco(20, 20, 410, 410, 145, 215, AZUL_OSC, 7)
            + arco(20, 20, 410, 410, 145, 215, CIAN, 7,
                   '<Transform target="endAngle" value="145 + [BATTERY_PERCENT] * 0.7" />')
            + imagen(166, 344, 40, 40, "ico_bateria", amb=0)
            + texto(206, 344, 90, 40, 28, BLANCO, "%s%%", ["[BATTERY_PERCENT]"], amb=0))


def main():
    out = sys.argv[1]
    xml = f'''<?xml version="1.0" encoding="utf-8"?>
<!-- Generado por android/tools/caratula_xml.py: no editar a mano. Propuesta del dueño (2026-11-01), con los ojos
     originales de Alma. Modo Alma si el número de la complicación está entre 10 y 19; modo reloj en otro caso. -->
<WatchFace width="450" height="450">
    <Metadata key="CLOCK_TYPE" value="DIGITAL" />
    <Metadata key="PREVIEW_TIME" value="10:47:00" />
    <Scene backgroundColor="#FF000000">
        <ComplicationSlot slotId="0" x="0" y="0" width="450" height="450" supportedTypes="RANGED_VALUE EMPTY" isCustomizable="TRUE">
            <BoundingOval x="0" y="0" width="450" height="450" />
            <DefaultProviderPolicy primaryProvider="mx.alma.mascota/mx.alma.reloj.Carita" primaryProviderType="RANGED_VALUE"
                defaultSystemProvider="EMPTY" defaultSystemProviderType="EMPTY" />
            <Complication type="RANGED_VALUE">
                <Condition>
                    <Expressions>
                        <Expression name="aqui"><![CDATA[[COMPLICATION.RANGED_VALUE_VALUE] >= 10 && [COMPLICATION.RANGED_VALUE_VALUE] < 20]]></Expression>
                    </Expressions>
                    <Compare expression="aqui">{modo_alma()}</Compare>
                    <Default>{modo_reloj()}</Default>
                </Condition>
            </Complication>
            <Complication type="EMPTY">{modo_reloj(base_robot=False)}</Complication>
        </ComplicationSlot>
    </Scene>
</WatchFace>
'''
    with open(out, "w", encoding="utf-8") as f:
        f.write(xml)
    print(out, len(xml), "caracteres")


if __name__ == "__main__":
    main()
