package mx.alma.reloj

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mx.alma.protocolo.Gato
import mx.alma.protocolo.Mosqueta
import mx.alma.protocolo.Palabras
import mx.alma.protocolo.PingPong
import mx.alma.protocolo.Preguntas
import org.json.JSONArray
import kotlin.math.abs
import kotlin.random.Random

/*
 * Juegos del reloj (dueño, 2026-11-01), con la propuesta visual aprobada: mosqueta, ping pong (con el bisel),
 * palabras (rueda de letras), gato y preguntas. Alma juega con su nivel de cada juego (Vida.empezarJuego); al terminar, la partida
 * cuenta para su ánimo, su ejercicio y su nivel (Vida.terminarJuego). Sin Haiku.
 */

data class InfoJuego(val id: String, val titulo: String, val icono: Int)

val JUEGOS = listOf(
    InfoJuego("mosqueta", "Mosqueta", R.drawable.ju_mosqueta), InfoJuego("pingpong", "Ping pong", R.drawable.ju_pingpong),
    InfoJuego("palabras", "Palabras", R.drawable.ju_palabras), InfoJuego("gato", "Gato", R.drawable.ju_gato),
    InfoJuego("preguntas", "Preguntas", R.drawable.ju_preguntas),
)

private val BLANCO = Color.White
private val BRILLO = Color(0xFF02FBFF)

// ---------- menú: ¿A qué jugamos? ----------
@Composable
fun ListaJuegos(vida: Vida, jugar: (String) -> Unit) {
    ScalingLazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(5.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 20.dp)) {
        item { Text("¿A qué jugamos?", style = estilo(15.sp)) }
        items(JUEGOS) { j ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(50)).background(CARBON)
                    .border(1.5.dp, BORDE_BOTON, RoundedCornerShape(50)).clickable { jugar(j.id) }.padding(horizontal = 14.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Dibujo(j.icono, 24.dp)
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(j.titulo, style = estilo(14.sp))
                    Text("Alma: " + vida.nivelGuardado(j.id), style = estilo(9.sp, GRIS))
                }
            }
        }
    }
}

// ---------- un juego: empezar, jugar, resultado ----------
@Composable
fun PantallaJuego(vida: Vida, id: String, salir: () -> Unit) {
    var inicio by remember { mutableStateOf<Vida.Inicio?>(null) }
    var resultado by remember { mutableStateOf<String?>(null) }
    var partida by remember { mutableIntStateOf(0) }
    val t0 = remember(partida) { System.currentTimeMillis() }
    LaunchedEffect(partida) { inicio = vida.empezarJuego(id) }
    androidx.activity.compose.BackHandler { salir() }          // deslizar a la derecha: salir del juego
    val fin: (String, Map<String, Int>) -> Unit = { g, puntos ->
        vida.terminarJuego(id, g, ((System.currentTimeMillis() - t0) / 1000).toInt(), puntos)
        resultado = g
    }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        val ini = inicio
        when {
            ini == null -> Text("…", style = estilo(20.sp), modifier = Modifier.align(Alignment.Center))
            !ini.ok -> NoQuiere(ini.razon ?: "Alma no quiere jugar ahorita.", salir)
            resultado != null -> Resultado(resultado!!, { resultado = null; partida++ }, salir)
            else -> when (id) {
                "mosqueta" -> JuegoMosqueta(ini.skill, fin)
                "pingpong" -> JuegoPingPong(ini.skill, fin)
                "palabras" -> JuegoPalabras(ini.skill, fin)
                "gato" -> JuegoGato(vida, ini.skill, partida, fin)
                else -> JuegoPreguntas(vida, fin)
            }
        }
    }
}

@Composable
private fun NoQuiere(razon: String, salir: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(26.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Ojitos(90.dp, Expresion.SUEÑO)
        Text(razon, style = estilo(14.sp), textAlign = TextAlign.Center, modifier = Modifier.padding(vertical = 10.dp))
        Text("Volver", style = estilo(13.sp, GRIS), modifier = Modifier.clickable { salir() })
    }
}

@Composable
private fun Resultado(ganador: String, otra: () -> Unit, salir: () -> Unit) {
    val (texto, expr) = when (ganador) {
        "owner" -> "¡Ganaste!" to Expresion.ENOJADA
        "alma" -> "¡Ganó Alma!" to Expresion.FELIZ
        else -> "Empate" to Expresion.CALMA
    }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Dibujo(R.drawable.ju_trofeo, 44.dp)
        Text(texto, style = estilo(20.sp), modifier = Modifier.padding(vertical = 6.dp))
        Ojitos(80.dp, expr)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Otra", style = estilo(15.sp), modifier = Modifier.clip(RoundedCornerShape(50)).background(CARBON)
                .border(1.5.dp, CIAN, RoundedCornerShape(50)).clickable { otra() }.padding(horizontal = 18.dp, vertical = 7.dp))
            Text("Salir", style = estilo(15.sp, GRIS), modifier = Modifier.clickable { salir() }.padding(7.dp))
        }
    }
}

// ---------- Mosqueta ----------
private fun DrawScope.vaso(c: Offset, w: Float, levantado: Float) {
    val top = c.y - w * 0.55f - levantado
    val p = Path().apply {
        moveTo(c.x - w * 0.32f, top); lineTo(c.x + w * 0.32f, top)
        lineTo(c.x + w * 0.5f, c.y - levantado); lineTo(c.x - w * 0.5f, c.y - levantado); close()
    }
    drawPath(p, CARBON)
    drawPath(p, CIAN, style = Stroke(3.5f, cap = StrokeCap.Round))
    drawOval(CIAN, Offset(c.x - w * 0.5f, c.y - levantado - w * 0.07f), Size(w, w * 0.14f), style = Stroke(3f))
}

@Composable
private fun JuegoMosqueta(skill: Double, fin: (String, Map<String, Int>) -> Unit) {
    var numero by remember { mutableIntStateOf(0) }
    var aciertos by remember { mutableIntStateOf(0) }
    var ronda by remember { mutableStateOf(Mosqueta.ronda(skill, 0)) }
    var fase by remember { mutableStateOf("mostrar") }      // mostrar, revolver, elegir, ver
    var elegido by remember { mutableIntStateOf(-1) }
    // dónde está cada vaso (por id) y cuál tiene la pelota
    val lugar = remember(ronda) { List(ronda.vasos) { Animatable(it.toFloat()) } }
    val alto = remember(ronda) { List(ronda.vasos) { Animatable(0f) } }
    val scope = rememberCoroutineScope()
    LaunchedEffect(ronda) {
        fase = "mostrar"
        alto[ronda.pelota].animateTo(1f, tween(300)); delay(900); alto[ronda.pelota].animateTo(0f, tween(250))
        fase = "revolver"
        val enLugar = IntArray(ronda.vasos) { it }                       // vaso que está en cada lugar
        for ((a, b) in ronda.cambios) {
            val va = enLugar[a]; val vb = enLugar[b]
            val j1 = scope.launch { lugar[va].animateTo(b.toFloat(), tween(ronda.msPorCambio)) }
            val j2 = scope.launch { lugar[vb].animateTo(a.toFloat(), tween(ronda.msPorCambio)) }
            j1.join(); j2.join()
            enLugar[a] = vb; enLugar[b] = va
        }
        fase = "elegir"
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val s = constraints.maxWidth.toFloat()
        val ancho = s * (if (ronda.vasos == 3) 0.2f else if (ronda.vasos == 4) 0.16f else 0.13f)
        val x0 = s * 0.5f - (ronda.vasos - 1) / 2f * ancho * 1.35f
        val y = s * 0.58f
        Ojitos(maxWidth * 0.3f, if (fase == "ver" && elegido >= 0 && lugar[ronda.pelota].value.toInt() != elegido) Expresion.FELIZ
            else Expresion.JUGUETONA, Modifier.align(Alignment.TopCenter).padding(top = 30.dp))
        Canvas(Modifier.fillMaxSize().pointerInput(ronda, fase) {
            detectTapGestures { p ->
                if (fase != "elegir") return@detectTapGestures
                val slot = ((p.x - x0) / (ancho * 1.35f) + 0.5f).toInt().coerceIn(0, ronda.vasos - 1)
                elegido = slot
                fase = "ver"
                val bien = lugar[ronda.pelota].value.toInt() == slot
                if (bien) aciertos++
                scope.launch {
                    lugar.forEachIndexed { v, l -> if (l.value.toInt() == slot || v == ronda.pelota) launch { alto[v].animateTo(1f, tween(300)) } }
                    delay(1400)
                    if (numero + 1 >= Mosqueta.RONDAS) {
                        fin(if (aciertos >= Mosqueta.PARA_GANAR) "owner" else "alma", mapOf("aciertos" to aciertos))
                    } else { numero++; ronda = Mosqueta.ronda(skill, numero) }
                }
            }
        }) {
            // solo con su vaso levantado (dueño, 2026-11-03: se veía al revolver, porque los vasos van en arco y ella no, y el
            // brillo salía por debajo del borde aunque estuviera tapada)
            if (alto[ronda.pelota].value > 0.15f) {
                val pelotaX = x0 + lugar[ronda.pelota].value * ancho * 1.35f
                drawCircle(Brush.radialGradient(listOf(Color.White, BRILLO, CIAN.copy(alpha = 0f)), Offset(pelotaX, y - ancho * 0.1f), ancho * 0.22f),
                    ancho * 0.22f, Offset(pelotaX, y - ancho * 0.1f))
            }
            for (v in 0 until ronda.vasos) {
                // al cambiar de lugar pasan en arco: uno por arriba, el otro por abajo
                val f = lugar[v].value - kotlin.math.floor(lugar[v].value)
                val arco = kotlin.math.sin(Math.PI * f).toFloat() * ancho * 0.35f * (if (v % 2 == 0) -1f else 1f)
                vaso(Offset(x0 + lugar[v].value * ancho * 1.35f, y + arco), ancho, alto[v].value * ancho * 0.6f)
            }
        }
        Column(Modifier.align(Alignment.BottomCenter).padding(bottom = 34.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(when (fase) { "mostrar" -> "¡Mírala bien!"; "revolver" -> "…"; "elegir" -> "¿Dónde quedó?"
                else -> if (elegido >= 0 && lugar[ronda.pelota].value.toInt() == elegido) "¡Bien!" else "¡Te engañé!" }, style = estilo(16.sp))
            Text("Ronda ${numero + 1} de ${Mosqueta.RONDAS} · $aciertos ✓", style = estilo(11.sp, GRIS))
        }
    }
}

// ---------- Ping pong (con el bisel o el dedo) ----------
@Composable
private fun JuegoPingPong(skill: Double, fin: (String, Map<String, Int>) -> Unit) {
    val ANCHO = 0.26
    var tu by remember { mutableFloatStateOf(0.5f) }
    var alma by remember { mutableFloatStateOf(0.5f) }
    var bx by remember { mutableFloatStateOf(0.5f) }
    var by by remember { mutableFloatStateOf(0.5f) }
    var puntosTu by remember { mutableIntStateOf(0) }
    var puntosAlma by remember { mutableIntStateOf(0) }
    var pista by remember { mutableStateOf(true) }
    val foco = remember { FocusRequester() }
    LaunchedEffect(Unit) { foco.requestFocus(); delay(2500); pista = false }
    LaunchedEffect(Unit) {
        var vx = 0.35; var vy = 1.0; var golpes = 0
        var error = PingPong.errorNuevo(skill, ANCHO)
        var antes = 0L
        delay(800)
        while (puntosTu < PingPong.PUNTOS && puntosAlma < PingPong.PUNTOS) {
            withFrameNanos { t ->
                val dt = if (antes == 0L) 0.016 else ((t - antes) / 1e9).coerceAtMost(0.05)
                antes = t
                val v = PingPong.velocidad(skill, golpes)
                var x = bx + vx * v * dt; var y = by + vy * v * dt
                if (x < 0.03 || x > 0.97) { vx = -vx; x = x.coerceIn(0.03, 0.97) }
                if (vy < 0) alma = PingPong.moverAlma(alma.toDouble(), x, dt, skill, error).toFloat()
                if (y > 0.92 && vy > 0) {                                // tu paleta
                    if (abs(x - tu) <= ANCHO / 2 + 0.02) { vy = -1.0; vx = (x - tu) / (ANCHO / 2) * 0.9; golpes++; error = PingPong.errorNuevo(skill, ANCHO) }
                    else if (y > 1.0) { puntosAlma++; x = 0.5; y = 0.5; vy = -1.0; vx = 0.3; golpes = 0 }
                }
                if (y < 0.08 && vy < 0) {                                // la de Alma
                    if (abs(x - alma) <= ANCHO / 2 + 0.02) { vy = 1.0; vx = (x - alma) / (ANCHO / 2) * 0.9; golpes++ }
                    else if (y < 0.0) { puntosTu++; x = 0.5; y = 0.5; vy = 1.0; vx = -0.3; golpes = 0 }
                }
                bx = x.toFloat(); by = y.toFloat()
            }
        }
        fin(if (puntosTu > puntosAlma) "owner" else "alma", mapOf("tu" to puntosTu, "alma" to puntosAlma))
    }
    BoxWithConstraints(
        Modifier.fillMaxSize()
            .onRotaryScrollEvent { tu = (tu + it.verticalScrollPixels / 900f).coerceIn(0.13f, 0.87f); true }
            .focusRequester(foco).focusable()
            .pointerInput(Unit) { detectDragGestures { c, _ -> tu = (c.position.x / size.width).coerceIn(0.13f, 0.87f) } },
    ) {
        val s = constraints.maxWidth.toFloat()
        Canvas(Modifier.fillMaxSize()) {
            val l = s * 0.2f; val w = s * 0.6f; val t = s * 0.12f; val h = s * 0.76f
            drawLine(GRIS.copy(alpha = 0.4f), Offset(l, t + h / 2), Offset(l + w, t + h / 2), 2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 10f)))
            val pw = (ANCHO * w).toFloat()
            drawRoundRect(CIAN, Offset(l + alma * w - pw / 2, t + h * 0.04f), Size(pw, s * 0.022f), CornerRadius(20f))
            drawRoundRect(BLANCO, Offset(l + tu * w - pw / 2, t + h * 0.94f), Size(pw, s * 0.022f), CornerRadius(20f))
            drawCircle(BRILLO, s * 0.018f, Offset(l + bx * w, t + by * h))
        }
        Ojitos(maxWidth * 0.18f, Expresion.JUGUETONA, Modifier.align(Alignment.TopCenter).padding(top = 6.dp))
        Column(Modifier.align(Alignment.CenterEnd).padding(end = 26.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("$puntosAlma", style = estilo(20.sp, CIAN)); Text("–", style = estilo(14.sp, GRIS)); Text("$puntosTu", style = estilo(20.sp))
        }
        if (pista) Text("Gira el bisel", style = estilo(12.sp, GRIS), modifier = Modifier.align(Alignment.CenterStart).padding(start = 18.dp))
    }
}

// ---------- Palabras (rueda de letras) ----------
private var RONDAS: List<Palabras.Ronda>? = null

private fun rondas(ctx: android.content.Context): List<Palabras.Ronda> = RONDAS ?: run {
    val a = JSONArray(ctx.assets.open("palabras.json").bufferedReader().use { it.readText() })
    List(a.length()) { k ->
        val o = a.getJSONObject(k)
        val ws = o.getJSONArray("palabras")
        Palabras.Ronda(o.getString("letras"), List(ws.length()) { ws.getString(it) })
    }.also { RONDAS = it }
}

@Composable
private fun JuegoPalabras(skill: Double, fin: (String, Map<String, Int>) -> Unit) {
    val ctx = LocalContext.current
    val ronda = remember { Palabras.elegir(rondas(ctx), skill) }
    var letras by remember { mutableStateOf(ronda.letras) }
    val quien = remember { mutableStateMapOf<String, String>() }          // palabra → "tu" (Alma ya no busca: juegas contra el tiempo)
    val camino = remember { mutableStateListOf<Int>() }                     // letras de la rueda que va uniendo el dedo
    var dedo by remember { mutableStateOf<Offset?>(null) }
    var giro by remember { mutableFloatStateOf(0f) }
    var restante by remember { mutableFloatStateOf(1f) }
    var aviso by remember { mutableStateOf("Une las letras") }
    var acabado by remember { mutableStateOf(false) }
    val foco = remember { FocusRequester() }
    val tu = quien.size
    val total = ronda.palabras.size
    val segundos = Palabras.segundos(total)
    LaunchedEffect(Unit) { foco.requestFocus() }
    LaunchedEffect(Unit) {                                                  // el reloj de la partida
        val t0 = System.currentTimeMillis()
        while (!acabado) {
            restante = 1f - (System.currentTimeMillis() - t0) / (segundos * 1000f)
            if (restante <= 0f || quien.size == ronda.palabras.size) acabado = true else delay(100)
        }
        camino.clear(); dedo = null
        aviso = if (quien.size == total) "¡Las encontraste todas!" else "¡Tiempo! Te faltaron ${total - quien.size}"
        delay(2800)                                                         // se ven todas antes del resultado
        fin(Palabras.ganadorSolo(quien.size, total), mapOf("tu" to quien.size, "total" to total))
    }
    fun soltar() {
        val w = camino.joinToString("") { letras[it].toString() }
        camino.clear(); dedo = null
        if (acabado || w.length < 3) return
        aviso = when (quien[w]) {
            "tu" -> "Ya la tienes"
            else -> if (w in ronda.palabras) { quien[w] = "tu"; Vibrar.suave(ctx); "¡$w!" } else "$w no cuenta"
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize().onRotaryScrollEvent { giro += it.verticalScrollPixels / 6f; true }
        .focusRequester(foco).focusable()) {
        val s = constraints.maxWidth.toFloat()
        val centro = Offset(s * 0.5f, s * 0.72f)
        val radio = s * 0.165f
        val rLetra = s * 0.052f
        val n = letras.length
        val densidad = LocalDensity.current
        fun pos(k: Int): Offset {
            val a = Math.toRadians(-90.0 + 360.0 * k / n + giro)
            return centro + Offset((kotlin.math.cos(a) * radio).toFloat(), (kotlin.math.sin(a) * radio).toFloat())
        }
        fun tocar(p: Offset) {
            dedo = p
            val k = (0 until n).firstOrNull { (pos(it) - p).getDistance() < rLetra * 1.35f } ?: return
            if (camino.size >= 2 && camino[camino.size - 2] == k) camino.removeAt(camino.size - 1)   // regresar el dedo
            else if (k !in camino) camino += k
        }
        Canvas(Modifier.fillMaxSize().pointerInput(letras, acabado) {
            if (acabado) return@pointerInput
            detectDragGestures(onDragStart = { tocar(it) }, onDragEnd = { soltar() },
                onDragCancel = { camino.clear(); dedo = null }) { c, _ -> tocar(c.position) }
        }) {
            drawArc(Color(0xFF1F2733), 0f, 360f, false, Offset(6f, 6f), Size(size.width - 12f, size.height - 12f), style = Stroke(5f))
            drawArc(CIAN, -90f, 360f * restante.coerceIn(0f, 1f), false, Offset(6f, 6f), Size(size.width - 12f, size.height - 12f),
                style = Stroke(5f, cap = StrokeCap.Round))
            drawCircle(CARBON, radio + rLetra * 1.5f, centro)
            drawCircle(BORDE_BOTON, radio + rLetra * 1.5f, centro, style = Stroke(2.5f))
        }
        // Alma al centro de la rueda; tocarla revuelve las letras
        Ojitos(maxWidth * 0.27f, if (acabado && tu == total) Expresion.FELIZ else Expresion.JUGUETONA,
            Modifier.offset { IntOffset((centro.x - s * 0.135f).toInt(), (centro.y - s * 0.0675f).toInt()) }
                .clickable(enabled = !acabado) { letras = Palabras.revolver(letras) }, fondo = CARBON)
        Canvas(Modifier.fillMaxSize()) {                                    // el trazo, encima de Alma
            for (k in 1 until camino.size) drawLine(CIAN, pos(camino[k - 1]), pos(camino[k]), 7f, StrokeCap.Round)
            val d = dedo
            if (d != null && camino.isNotEmpty()) drawLine(CIAN.copy(alpha = 0.6f), pos(camino.last()), d, 5f, StrokeCap.Round)
            for (k in camino) drawCircle(Brush.radialGradient(listOf(BRILLO, CIAN), pos(k), rLetra), rLetra, pos(k))
        }
        // las letras de la rueda
        for (k in 0 until n) {
            val p = pos(k)
            Text(letras[k].toString(), style = estilo(17.sp, if (k in camino) Color.Black else BLANCO), textAlign = TextAlign.Center,
                modifier = Modifier.offset { IntOffset((p.x - rLetra).toInt(), (p.y - rLetra * 0.82f).toInt()) }
                    .width(with(densidad) { (rLetra * 2).toDp() }))
        }
        // arriba: marcador, las palabras por encontrar y la que se está formando
        Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("$tu de $total", style = estilo(12.sp))
            val ws = ronda.palabras
            val mitad = (ws.size + 1) / 2
            Row(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for (columna in listOf(ws.take(mitad), ws.drop(mitad))) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    for (w in columna) {
                        val q = quien[w]
                        Text(if (q != null || acabado) w else w.map { "_" }.joinToString(" "),
                            style = estilo(if (ws.size > 8) 9.sp else 10.sp, if (q != null) BLANCO else if (acabado) NARANJA else GRIS))
                    }
                }
            }
            Text(if (camino.isNotEmpty()) camino.joinToString("") { letras[it].toString() } else aviso,
                style = estilo(if (camino.isNotEmpty()) 17.sp else 11.sp, if (camino.isNotEmpty()) BLANCO else GRIS),
                maxLines = 1, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

// ---------- Gato ----------
@Composable
private fun JuegoGato(vida: Vida, skill: Double, partida: Int, fin: (String, Map<String, Int>) -> Unit) {
    val tablero = remember { mutableStateListOf(*Array(9) { ' ' }) }
    var turno by remember { mutableStateOf(if (partida % 2 == 0) 'X' else 'O') }      // se turnan quién empieza
    var acabado by remember { mutableStateOf(false) }
    fun revisar(): Boolean {
        val t = tablero.toCharArray()
        val g = Gato.ganador(t)
        if (g != null || Gato.lleno(t)) {
            acabado = true
            fin(when (g) { 'X' -> "owner"; 'O' -> "alma"; else -> "draw" }, emptyMap())
            return true
        }
        return false
    }
    LaunchedEffect(turno) {
        if (turno == 'O' && !acabado) {
            delay(700)
            tablero[Gato.jugadaDeAlma(tablero.toCharArray(), skill)] = 'O'
            if (!revisar()) turno = 'X'
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val s = constraints.maxWidth.toFloat()
        val lado = s * 0.56f; val x0 = (s - lado) / 2; val y0 = s * 0.26f; val c = lado / 3
        Ojitos(maxWidth * 0.26f, if (turno == 'O') Expresion.CALMA else Expresion.JUGUETONA,
            Modifier.align(Alignment.TopCenter).padding(top = 18.dp))
        Canvas(Modifier.fillMaxSize().pointerInput(turno, acabado) {
            detectTapGestures { p ->
                if (turno != 'X' || acabado) return@detectTapGestures
                val col = ((p.x - x0) / c).toInt(); val fila = ((p.y - y0) / c).toInt()
                if (col !in 0..2 || fila !in 0..2) return@detectTapGestures
                val i = fila * 3 + col
                if (tablero[i] != ' ') return@detectTapGestures
                tablero[i] = 'X'
                if (!revisar()) turno = 'O'
            }
        }) {
            for (k in 1..2) {
                drawLine(CIAN, Offset(x0 + k * c, y0), Offset(x0 + k * c, y0 + lado), 3f, StrokeCap.Round)
                drawLine(CIAN, Offset(x0, y0 + k * c), Offset(x0 + lado, y0 + k * c), 3f, StrokeCap.Round)
            }
            tablero.forEachIndexed { i, v ->
                val cc = Offset(x0 + (i % 3 + 0.5f) * c, y0 + (i / 3 + 0.5f) * c)
                if (v == 'X') {
                    val r = c * 0.24f
                    drawLine(BLANCO, cc - Offset(r, r), cc + Offset(r, r), 7f, StrokeCap.Round)
                    drawLine(BLANCO, cc + Offset(-r, r), cc + Offset(r, -r), 7f, StrokeCap.Round)
                } else if (v == 'O') {                                   // las fichas de Alma son sus ojitos
                    val e = c * 0.22f
                    for (lado2 in listOf(-1, 1)) drawRoundRect(Brush.radialGradient(listOf(BRILLO, Color(33, 185, 188)), cc + Offset(lado2 * e * 0.68f, 0f), e * 0.7f),
                        cc + Offset(lado2 * e * 0.68f - e / 2, -e / 2), Size(e, e), CornerRadius(e * 0.28f))
                }
            }
        }
        Text(if (acabado) "" else if (turno == 'X') "Te toca" else "Alma piensa…", style = estilo(14.sp, GRIS),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 30.dp))
    }
}

// ---------- Preguntas ----------
private val ICONO_CAT = mapOf(
    "cultura_general" to R.drawable.ca_cultura_general, "ciencia" to R.drawable.ca_ciencia, "historia" to R.drawable.ca_historia,
    "geografia" to R.drawable.ca_geografia, "tecnologia" to R.drawable.ca_tecnologia, "programacion" to R.drawable.ca_programacion,
    "arte" to R.drawable.ca_arte, "deportes" to R.drawable.ca_deportes, "pokemon" to R.drawable.ca_pokemon,
    "cultura_pop" to R.drawable.ca_cultura_pop, "cultura_geek" to R.drawable.ca_cultura_geek,
)

@Composable
private fun JuegoPreguntas(vida: Vida, fin: (String, Map<String, Int>) -> Unit) {
    var lote by remember { mutableStateOf<JSONArray?>(null) }
    var sinRed by remember { mutableStateOf(false) }
    var i by remember { mutableIntStateOf(0) }
    var tu by remember { mutableIntStateOf(0) }
    var alma by remember { mutableIntStateOf(0) }
    var elegida by remember { mutableIntStateOf(-1) }
    var restante by remember { mutableFloatStateOf(1f) }
    LaunchedEffect(Unit) { lote = vida.preguntas(); sinRed = lote == null }
    val q = lote?.optJSONObject(i)
    LaunchedEffect(q, elegida) {
        if (q == null) return@LaunchedEffect
        if (elegida == -1) {                                              // la cuenta regresiva
            val t0 = System.currentTimeMillis()
            while (elegida == -1) {
                restante = 1f - (System.currentTimeMillis() - t0) / (Preguntas.SEGUNDOS * 1000f)
                if (restante <= 0f) { elegida = 4; break }                // se acabó el tiempo
                delay(50)
            }
        } else {
            val bien = elegida == q.getInt("ok")
            if (bien) tu++
            if (q.getJSONObject("alma").getBoolean("acierta")) alma++
            vida.respuesta(q.getString("id"), bien)
            delay(2600)
            if (i + 1 >= lote!!.length()) fin(Preguntas.ganador(tu, alma), mapOf("tu" to tu, "alma" to alma))
            else { i++; elegida = -1 }
        }
    }
    if (sinRed) return Text("Sin conexión y sin preguntas guardadas. Inténtalo con internet.", style = estilo(13.sp),
        textAlign = TextAlign.Center, modifier = Modifier.fillMaxSize().padding(36.dp))
    if (q == null) return
    Box(Modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize()) {
            drawArc(Color(0xFF1F2733), 0f, 360f, false, Offset(6f, 6f), Size(size.width - 12f, size.height - 12f), style = Stroke(5f))
            drawArc(CIAN, -90f, 360f * restante.coerceIn(0f, 1f), false, Offset(6f, 6f), Size(size.width - 12f, size.height - 12f),
                style = Stroke(5f, cap = StrokeCap.Round))
        }
        Column(Modifier.fillMaxSize().padding(top = 18.dp, start = 20.dp, end = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.clip(RoundedCornerShape(50)).border(1.5.dp, BORDE_BOTON, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically) {
                ICONO_CAT[q.getString("cat")]?.let { Dibujo(it, 16.dp) }
                Spacer(Modifier.width(5.dp))
                Text(q.getString("categoria"), style = estilo(11.sp))
            }
            Text(q.getString("q"), style = estilo(12.sp), textAlign = TextAlign.Center, maxLines = 4,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp).height(62.dp))
            val ops = q.getJSONArray("ops")
            for (fila in 0..1) Row(horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                for (col in 0..1) {
                    val k = fila * 2 + col
                    val borde = when {
                        elegida == -1 -> BORDE_BOTON
                        k == q.getInt("ok") -> CIAN
                        k == elegida -> NARANJA
                        else -> BORDE_BOTON.copy(alpha = 0.25f)
                    }
                    Text(ops.getString(k), style = estilo(10.sp), textAlign = TextAlign.Center, maxLines = 2,
                        modifier = Modifier.weight(1f).clip(RoundedCornerShape(50)).background(CARBON).border(2.dp, borde, RoundedCornerShape(50))
                            .clickable(enabled = elegida == -1) { elegida = k }.padding(vertical = 7.dp, horizontal = 4.dp))
                }
            }
            if (elegida != -1) {
                val almaBien = q.getJSONObject("alma").getBoolean("acierta")
                Text((if (almaBien) "Alma también acertó" else "Alma falló") + if (elegida == 4) " · se acabó el tiempo" else "",
                    style = estilo(10.sp, GRIS), modifier = Modifier.padding(top = 3.dp))
            }
            Text("Tú $tu · Alma $alma", style = estilo(11.sp, CIAN), modifier = Modifier.padding(top = 1.dp))
        }
    }
}
