package mx.alma.reloj

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import kotlinx.coroutines.delay
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/*
 * La cara de Alma dibujada en vivo (PLAN-RELOJ-v2.md, 11): el mismo estilo que alma/tools/caras/generar_cara.py
 * (ojos cian de esquinas redondeadas, borde más oscuro y centro brillante, sobre negro real), pensada para el
 * círculo: dos ojos centrados con margen. Nada de las caras de fábrica.
 */

private val CENTRO = Color(2, 251, 255)
private val BORDE = Color(33, 185, 188)
private val HAMBRE = Color(255, 170, 60)

enum class Expresion { CALMA, FELIZ, JUGUETONA, SUEÑO, DORMIDA, ENOJADA, ASUSTADA, ABURRIDA, AMOR, ENFERMA, AUSENTE, TRISTE }

fun expresionDe(v: Vista, amor: Boolean): Expresion = when {
    !v.aqui && v.donde == "reloj" -> Expresion.AUSENTE
    amor -> Expresion.AMOR
    v.enferma -> Expresion.ENFERMA
    v.estado == "ST_SLEEPING" -> Expresion.DORMIDA
    v.estado == "ST_RESTING" || v.animo == "SM_SLEEPY" -> Expresion.SUEÑO
    v.animo == "SM_HAPPY" -> Expresion.FELIZ
    v.animo == "SM_PLAYFUL" -> Expresion.JUGUETONA
    v.animo == "SM_GRUMPY" -> Expresion.ENOJADA
    v.animo == "SM_SCARED" -> Expresion.ASUSTADA
    v.animo == "SM_BORED" -> Expresion.ABURRIDA
    else -> Expresion.CALMA
}

/**
 * @param mirada hacia dónde ve, de −1 a 1 en cada eje (el dedo, o al azar).
 * @param ambiente pantalla en modo ambiente: ojos tenues y quietos.
 */
@Composable
fun CaraAlma(expr: Expresion, mirada: Offset, hambre: Double, ambiente: Boolean, modifier: Modifier = Modifier,
             bajar: Float = 0f, tam: Float = 0.27f, fondo: Color = Color.Black) {
    var parpadeo by remember { mutableFloatStateOf(1f) }
    val t = rememberInfiniteTransition(label = "respiro")
    val respiro by t.animateFloat(0f, 1f, infiniteRepeatable(tween(3600, easing = LinearEasing), RepeatMode.Reverse), label = "r")
    val temblor by t.animateFloat(0f, 6.283f, infiniteRepeatable(tween(260, easing = LinearEasing)), label = "t")
    LaunchedEffect(expr, ambiente) {
        if (ambiente || expr == Expresion.DORMIDA) return@LaunchedEffect
        while (true) {
            delay(Random.nextLong(1800, 5200))
            animate(1f, 0.05f, animationSpec = tween(80)) { v: Float, _: Float -> parpadeo = v }
            animate(0.05f, 1f, animationSpec = tween(110)) { v: Float, _: Float -> parpadeo = v }
        }
    }
    Canvas(modifier.fillMaxSize()) {
        drawRect(fondo)
        val s = min(size.width, size.height)
        val c = Offset(size.width / 2, size.height / 2)
        if (!ambiente && hambre > 0.05) {
            // el hambre, como un arco fino en la orilla del círculo
            drawArc(HAMBRE.copy(alpha = 0.7f), 135f, (270f * hambre).toFloat().coerceAtMost(270f), false,
                topLeft = Offset(c.x - s / 2 + 6, c.y - s / 2 + 6), size = Size(s - 12, s - 12), style = Stroke(5f))
        }
        val w = s * tam
        val gap = s * 0.08f * (tam / 0.27f)
        val dy = if (ambiente) 0f else (respiro - 0.5f) * s * 0.012f
        val sacude = if (expr == Expresion.ASUSTADA && !ambiente) sin(temblor) * s * 0.006f else 0f
        val mx = mirada.x.coerceIn(-1f, 1f) * s * 0.07f + sacude
        val my = mirada.y.coerceIn(-1f, 1f) * s * 0.05f + dy + (if (expr == Expresion.ABURRIDA || expr == Expresion.TRISTE) s * 0.04f else 0f)
        for (lado in listOf(-1, 1)) {
            val cx = c.x + lado * (gap / 2 + w / 2) + mx
            ojo(Offset(cx, c.y + my + bajar * s), w, expr, if (ambiente) 1f else parpadeo, lado, ambiente, fondo)
        }
    }
}

private fun DrawScope.ojo(c: Offset, w: Float, expr: Expresion, parpadeo: Float, lado: Int, ambiente: Boolean, fondo: Color) {
    var ew = w
    var eh = w
    when (expr) {
        Expresion.ASUSTADA -> { ew *= 0.78f; eh *= 0.86f }
        Expresion.SUEÑO -> eh *= 0.42f
        Expresion.ABURRIDA -> eh *= 0.55f
        Expresion.DORMIDA -> eh *= 0.07f
        Expresion.AUSENTE -> { ew *= 0.6f; eh *= 0.6f }
        Expresion.TRISTE -> eh *= 0.75f
        else -> {}
    }
    eh = maxOf(eh * parpadeo, w * 0.05f)
    val tl = Offset(c.x - ew / 2, c.y - eh / 2)
    val r = minOf(w * 0.28f, eh / 2, ew / 2)
    val alfa = if (ambiente) 0.35f else if (expr == Expresion.AUSENTE) 0.4f else 1f
    val centro = if (expr == Expresion.ENFERMA) Color(150, 230, 170) else CENTRO
    if (expr == Expresion.AMOR) {
        corazon(c, w * 0.9f, Color(255, 90, 140).copy(alpha = alfa))
        return
    }
    val brillo = Brush.radialGradient(listOf(centro.copy(alpha = alfa), BORDE.copy(alpha = alfa)), c, maxOf(ew, eh) * 0.62f)
    drawRoundRect(brillo, tl, Size(ew, eh), CornerRadius(r, r))
    when (expr) {
        // felices: la parte de abajo se tapa con un arco negro (^ ^)
        Expresion.FELIZ, Expresion.JUGUETONA -> drawOval(fondo, Offset(tl.x - ew * 0.15f, c.y + eh * 0.12f), Size(ew * 1.3f, eh))
        // enojada: el rincón de adentro de arriba se corta en diagonal
        Expresion.ENOJADA -> {
            val p = Path().apply {
                val adentro = if (lado < 0) tl.x + ew else tl.x
                val afuera = if (lado < 0) tl.x else tl.x + ew
                moveTo(adentro + lado * 2f, tl.y - 2f)
                lineTo(adentro + lado * 2f, tl.y + eh * 0.5f)
                lineTo(afuera, tl.y - 2f)
                close()
            }
            drawPath(p, fondo)
        }
        // triste (al regañarla): al revés, el rincón de afuera de arriba (/ \)
        Expresion.TRISTE -> {
            val p = Path().apply {
                val adentro = if (lado < 0) tl.x + ew else tl.x
                val afuera = if (lado < 0) tl.x else tl.x + ew
                moveTo(afuera + lado * 2f, tl.y - 2f)
                lineTo(afuera + lado * 2f, tl.y + eh * 0.55f)
                lineTo(adentro, tl.y - 2f)
                close()
            }
            drawPath(p, fondo)
        }
        else -> {}
    }
}

private fun DrawScope.corazon(c: Offset, w: Float, color: Color) {
    val p = Path().apply {
        moveTo(c.x, c.y + w * 0.38f)
        cubicTo(c.x - w * 0.62f, c.y - w * 0.05f, c.x - w * 0.32f, c.y - w * 0.55f, c.x, c.y - w * 0.2f)
        cubicTo(c.x + w * 0.32f, c.y - w * 0.55f, c.x + w * 0.62f, c.y - w * 0.05f, c.x, c.y + w * 0.38f)
        close()
    }
    drawPath(p, color)
}
