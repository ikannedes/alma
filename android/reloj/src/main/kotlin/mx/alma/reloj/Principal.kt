package mx.alma.reloj

import android.Manifest
import android.app.RemoteInput
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.wear.ambient.AmbientLifecycleObserver
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Pantallas de la app del reloj según la variante 1 elegida por el dueño (2026-11-01): fondo negro, botones planos
 * redondos color carbón con borde cian suave, Montserrat SemiBold y los ojos ORIGINALES de Alma (Cara.kt). Los
 * íconos y la comida son imágenes propias (android/tools/hoja_*.png → tools/recortar_hoja.py), no íconos de Android.
 * Solo lo que Alma ya sabe hacer: las órdenes de rules.py, la comida de care.py, la mudanza, la voz y las caricias.
 */

internal val FUENTE = FontFamily(Font(R.font.montserrat_semibold))
internal val CIAN = Color(0xFF00E5FF)
internal val GRIS = Color(0xFFA0AEC0)
internal val CARBON = Color(0xFF15191F)
internal val BORDE_BOTON = Color(0x8000E5FF)
internal val NARANJA = Color(0xFFFF9A2E)
internal val ES = Locale("es", "MX")

internal fun estilo(tam: TextUnit, color: Color = Color.White) = TextStyle(fontFamily = FUENTE, fontSize = tam, color = color)

@Composable
internal fun Dibujo(@DrawableRes id: Int, tam: Dp, modifier: Modifier = Modifier, tinte: Color? = null) =
    Image(painterResource(id), null, modifier.size(tam), colorFilter = tinte?.let { ColorFilter.tint(it) })

class Principal : ComponentActivity() {
    private val ambiente = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val vida = Vida.de(this)
        // versión de pruebas: servidor y llave por adb (am start … --es servidor URL --es llave LLAVE)
        if (BuildConfig.DEBUG) intent?.getStringExtra("llave")?.let { vida.ponerLlave(intent.getStringExtra("servidor"), it) }
        Sincronizar.programar(this)
        lifecycle.addObserver(AmbientLifecycleObserver(this, object : AmbientLifecycleObserver.AmbientLifecycleCallback {
            override fun onEnterAmbient(ambientDetails: AmbientLifecycleObserver.AmbientDetails) { ambiente.value = true }
            override fun onExitAmbient() { ambiente.value = false }
        }))
        setContent { MaterialTheme { Pantalla(vida, ambiente.value) } }
    }

    override fun onResume() {
        super.onResume()
        val vida = Vida.de(this)
        vida.teMira()                                   // al girar la muñeca para ver el reloj, te mira (8.3)
        vida.scope.launch { vida.sincronizar() }
    }
}

@Composable
private fun Pantalla(vida: Vida, ambiente: Boolean) {
    val v by vida.vista.collectAsState()
    var menu by remember { mutableStateOf(false) }
    var juego by remember { mutableStateOf<String?>(null) }
    var accion by remember { mutableStateOf<String?>(null) }   // acción del reloj en curso (cosquillas, sacudir…)
    var llego by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    // pasos y pulso (14): se piden una vez; sin permiso, Alma vive igual
    val salud = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { Salud.registrar(ctx) }
    LaunchedEffect(v.vinculado) {
        if (v.vinculado && !Salud.tienePermisos(ctx)) salud.launch(Salud.permisos()) else Salud.registrar(ctx)
    }
    LaunchedEffect(Unit) {
        var n = 0
        while (true) {
            vida.latido()
            // la ventana del robot se refresca mientras está abierta; con una mudanza en curso, más seguido
            if (++n % (if (vida.vista.value.donde == "transito") 10 else 60) == 0) vida.sincronizar()
            delay(1000)
        }
    }
    LaunchedEffect(v.aviso) {
        if (v.aviso.startsWith("llego")) { llego = true; vida.limpiarAviso() }
    }
    LaunchedEffect(llego) {   // aparte: limpiarAviso cambia v.aviso y cancelaba el delay de arriba (se quedaba en "¡Ya estoy contigo!", 2026-11-03)
        if (llego) { delay(3500); llego = false }
    }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when {
            !v.vinculado -> Vincular(vida, v.mensaje)
            llego && !ambiente -> Llego()
            juego != null && !ambiente -> PantallaJuego(vida, juego!!) { juego = null }
            menu && !ambiente -> Menu(vida, v, jugar = { juego = it; menu = false }, hacer = { accion = it; menu = false }) { menu = false }
            else -> CaraInteractiva(vida, v, ambiente, accion, { accion = null }) { menu = true; accion = null }
        }
    }
}

// ---------- 1. Cara ----------
@Composable
private fun Hora(arriba: Dp, grande: Boolean = true) {
    var ahora by remember { mutableStateOf(LocalDateTime.now()) }
    LaunchedEffect(Unit) { while (true) { ahora = LocalDateTime.now(); delay(5_000) } }
    val fecha = ahora.format(DateTimeFormatter.ofPattern("EEE d MMM", ES)).replace(".", "")
        .replaceFirstChar { it.uppercase() }
    Column(Modifier.fillMaxWidth().padding(top = arriba), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(ahora.format(DateTimeFormatter.ofPattern("H:mm")), style = estilo(if (grande) 34.sp else 30.sp))
        Text(fecha, style = estilo(if (grande) 13.sp else 12.sp, GRIS))
    }
}

@Composable
internal fun Acentos(modifier: Modifier) {
    Canvas(modifier.size(22.dp)) {
        for (k in 0..1) {
            val x = size.width * (0.25f + k * 0.35f)
            drawLine(CIAN, Offset(x, size.height * 0.85f), Offset(x + size.width * 0.25f, size.height * 0.2f), 5f, StrokeCap.Round)
        }
    }
}

@Composable
private fun CaraInteractiva(vida: Vida, v: Vista, ambiente: Boolean, accion: String?, terminar: () -> Unit, abrirMenu: () -> Unit) {
    val ctx = LocalContext.current
    var dedo by remember { mutableStateOf<Offset?>(null) }
    var mirada by remember { mutableStateOf(Offset.Zero) }
    var amor by remember { mutableStateOf(false) }
    var oyendo by remember { mutableStateOf<String?>(null) }
    var toques by remember { mutableStateOf(listOf<Long>()) }
    var tam by remember { mutableStateOf(1f) }
    var reaccion by remember { mutableStateOf<Expresion?>(null) }   // la cara de una acción del reloj, un momento
    var pista by remember { mutableStateOf<String?>(null) }         // qué hacer o qué dijo, abajo
    var cosquillas by remember { mutableStateOf(0) }                // > 0: toques que van en modo cosquillas
    var risa by remember { mutableStateOf(0) }                      // cambia con cada cosquilla: brinca
    val voz = remember {
        Voz(ctx, parcial = { oyendo = it }, final = { t -> oyendo = null; if (!t.isNullOrBlank()) vida.voz(t) })
    }
    val permiso = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) { oyendo = ""; voz.escuchar() }
    }
    DisposableEffect(Unit) { onDispose { voz.detener() } }
    LaunchedEffect(amor) { if (amor) { delay(1600); amor = false } }
    LaunchedEffect(dedo) {
        while (dedo == null) {                          // sin dedo, mira a un lado de vez en cuando
            mirada = Offset((-1..1).random() * 0.6f, (-1..1).random() * 0.3f)
            delay((1500L..4000L).random())
            mirada = Offset.Zero
            delay((1500L..4000L).random())
        }
    }
    // acciones del reloj (QueHacemos con Alma aquí): cada una dura unos segundos y vuelve a la cara de siempre
    val principal = remember { Handler(Looper.getMainLooper()) }
    val sacudida = remember { Sacudida(ctx) { principal.post { vida.sacudida(); reaccion = Expresion.ASUSTADA; pista = "¡Me mareas!" } } }
    val soplido = remember { Soplido { principal.post { vida.soplido(); reaccion = Expresion.DORMIDA; pista = "¡Fuuu! Jiji" } } }
    val permisoSoplo = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) soplido.empezar() else { pista = "Necesito el micrófono" }
    }
    LaunchedEffect(accion) {
        val a = accion ?: return@LaunchedEffect
        reaccion = null
        when (a) {
            "animo" -> { vida.animar(); amor = false; reaccion = Expresion.AMOR; pista = "¡Gracias!"; delay(2500) }
            "regano" -> { vida.reganar(); reaccion = Expresion.TRISTE; pista = "Perdón…"; delay(3000) }
            "cosquillas" -> {
                cosquillas = 1; pista = "¡Hazle cosquillas!"
                delay(COSQUILLAS_MS)
            }
            "sacudir" -> {
                pista = "¡Sacude el reloj!"
                sacudida.empezar()
                delay(ESPERA_MS)
                if (reaccion == null) { pista = "No sentí nada"; delay(1500) } else delay(2500)
            }
            "soplar" -> {
                pista = "Sóplale al reloj"
                if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) soplido.empezar()
                else permisoSoplo.launch(Manifest.permission.RECORD_AUDIO)
                delay(ESPERA_MS)
                if (reaccion == null) { pista = "No sentí nada"; delay(1500) }
                else { delay(900); reaccion = Expresion.FELIZ; delay(1800) }
            }
        }
        sacudida.parar(); soplido.parar()
        reaccion = null; pista = null; cosquillas = 0
        terminar()
    }
    DisposableEffect(Unit) { onDispose { sacudida.parar(); soplido.parar() } }
    LaunchedEffect(risa) {   // cada cosquilla: brinca y se ríe un momento
        if (risa == 0) return@LaunchedEffect
        mirada = Offset(0f, -0.9f); delay(90); mirada = Offset(0f, 0.3f); delay(90); mirada = Offset.Zero
        delay(700)
        if (reaccion == Expresion.FELIZ) reaccion = null
    }
    if (oyendo != null) return TeEscucho(oyendo!!) { voz.detener(); oyendo = null }
    Box(
        Modifier.fillMaxSize()
            .pointerInput(Unit) {
                tam = size.width.toFloat()
                detectTapGestures(
                    onTap = tap@{
                        if (cosquillas > 0) {   // modo cosquillas: cada toque la hace reír; si te pasas, se enoja
                            if (reaccion == Expresion.ENOJADA) return@tap
                            if (++cosquillas > COSQUILLAS_MAX) {
                                vida.molestar(); reaccion = Expresion.ENOJADA; pista = "¡Ya basta!"
                            } else { vida.cosquilla(); reaccion = Expresion.FELIZ; risa++; pista = "¡Jajaja!" }
                            return@tap
                        }
                        val ahora = System.currentTimeMillis()
                        toques = (toques + ahora).filter { ahora - it < 1200 }
                        if (toques.size >= 3) vida.molestar() else { vida.acariciar(); amor = true }
                    },
                    onLongPress = {
                        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            oyendo = ""; voz.escuchar()
                        } else permiso.launch(Manifest.permission.RECORD_AUDIO)
                    },
                    onDoubleTap = { abrirMenu() },
                )
            }
            .pointerInput(Unit) {
                var recorrido = 0f
                detectDragGestures(
                    onDragStart = { dedo = it },
                    onDragEnd = { dedo = null; recorrido = 0f },
                    onDragCancel = { dedo = null },
                ) { cambio, d ->
                    dedo = cambio.position
                    mirada = Offset((cambio.position.x / tam - 0.5f) * 2f, (cambio.position.y / tam - 0.5f) * 2f)
                    recorrido += d.getDistance()
                    if (recorrido > tam * 1.2f) { vida.acariciar(); recorrido = 0f }   // rascarle
                }
            },
    ) {
        CaraAlma(reaccion ?: expresionDe(v, amor), mirada, if (v.aqui) v.hambre else 0.0, ambiente, bajar = 0.07f, tam = 0.22f)
        Hora(arriba = 24.dp)
        if (!ambiente) {
            Acentos(Modifier.align(Alignment.TopEnd).offset(x = (-50).dp, y = 44.dp))
            if (v.aqui && v.hambre > 0.05)
                Dibujo(R.drawable.ic_hambre, 20.dp, Modifier.align(Alignment.CenterStart).offset(x = 20.dp, y = (-28).dp), tinte = NARANJA)
            val abajo = when {
                v.donde == "robot" && !v.aqui -> "Alma está en el robot" + if (!v.robotEnLinea) " (sin conexión)" else ""
                v.donde == "transito" -> "Mudándose…"
                pista != null -> pista!!
                v.mensaje.isNotEmpty() -> v.mensaje
                else -> "Tócala para acariciarla"
            }
            Column(Modifier.align(Alignment.BottomCenter).padding(bottom = 20.dp, start = 30.dp, end = 30.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                Text(abajo, style = estilo(13.sp, GRIS), textAlign = TextAlign.Center)
                if (abajo == "Tócala para acariciarla") Dibujo(R.drawable.ic_toque, 26.dp, Modifier.padding(top = 2.dp))
            }
        }
    }
}

// ---------- 2–6. Menú en páginas: ¿Cómo está?, ¿Qué hacemos?, Comida, Juegos, Mudanza ----------
@Composable
private fun Menu(vida: Vida, v: Vista, jugar: (String) -> Unit, hacer: (String) -> Unit, volver: () -> Unit) {
    val pag = rememberPagerState { 5 }
    androidx.activity.compose.BackHandler { volver() }          // atrás: de vuelta a su cara
    Box(Modifier.fillMaxSize()) {
        HorizontalPager(pag, Modifier.fillMaxSize()) { p ->
            when (p) {
                0 -> ComoEsta(v)
                1 -> if (v.aqui) QueHacemosReloj(hacer) else QueHacemos(vida, volver)
                2 -> Comida(vida, volver)
                3 -> ListaJuegos(vida, jugar)
                else -> Mudanza(vida, v, volver)
            }
        }
        Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 5.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            repeat(5) { i ->
                Box(Modifier.size(7.dp).clip(CircleShape).background(if (i == pag.currentPage) CIAN else Color(0xFF3A4250)))
            }
        }
    }
}

@Composable
internal fun BotonRedondo(@DrawableRes dibujo: Int, texto: String, tam: Dp, alClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier.size(tam).clip(CircleShape).background(CARBON).border(1.5.dp, BORDE_BOTON, CircleShape).clickable(onClick = alClick),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Dibujo(dibujo, tam * 0.42f)
        Text(texto, style = estilo((tam.value * 0.13f).sp), maxLines = 1)
    }
}

@Composable
internal fun Ojitos(ancho: Dp, expr: Expresion = Expresion.CALMA, modifier: Modifier = Modifier, fondo: Color = Color.Black) {
    Box(modifier.width(ancho).height(ancho * 0.5f)) { CaraAlma(expr, Offset.Zero, 0.0, false, tam = 0.36f, fondo = fondo) }
}

// ---------- ¿Cómo está? (dueño, 2026-11-03: "sus status básicos como hambre, energía, enfermedad, actitud, edad") ----------
private fun animoTexto(sm: String) = when (sm) {
    "SM_HAPPY" -> "Feliz"; "SM_PLAYFUL" -> "Juguetona"; "SM_CALM" -> "Tranquila"; "SM_BORED" -> "Aburrida"
    "SM_SLEEPY" -> "Con sueño"; "SM_GRUMPY" -> "De malas"; "SM_SCARED" -> "Asustada"; else -> "—"
}

private fun animoCara(sm: String) = when (sm) {
    "SM_HAPPY" -> Expresion.FELIZ; "SM_PLAYFUL" -> Expresion.JUGUETONA; else -> Expresion.CALMA
}

@Composable
private fun Barra(nombre: String, valor: Double?, maloSiAlto: Boolean = false, palabra: ((Double) -> String)? = null) {
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(nombre, style = estilo(11.sp, GRIS))
            Text(if (valor == null) "—" else (palabra?.let { it(valor) + " · " } ?: "") + "${(valor * 100).roundToInt()} %", style = estilo(11.sp))
        }
        Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(50)).background(Color(0xFF3A4250))) {
            if (valor != null) {
                val x = valor.coerceIn(0.0, 1.0)
                val malo = if (maloSiAlto) x > 0.7 else x < 0.3
                Box(Modifier.fillMaxWidth(x.toFloat()).height(6.dp).clip(RoundedCornerShape(50)).background(if (malo) NARANJA else CIAN))
            }
        }
    }
}

@Composable
private fun ComoEsta(v: Vista) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val s = maxWidth
        Column(Modifier.fillMaxSize().padding(top = 12.dp, start = s * 0.15f, end = s * 0.15f),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Text("¿Cómo está?", style = estilo(14.sp))
            Ojitos(s * 0.2f, animoCara(v.animo))
            Text(animoTexto(v.animo) + if (v.enferma) " · enferma" else " · sana",
                style = estilo(12.sp, if (v.enferma) NARANJA else CIAN), modifier = Modifier.padding(bottom = 2.dp))
            Barra("Hambre", v.hambre, maloSiAlto = true) { if (it < 0.3) "llena" else if (it < 0.7) "normal" else "con hambre" }
            Barra("Energía", v.energia)
            Barra("Bienestar", v.bienestar)
            Text((v.edadDias?.let { "$it ${if (it == 1) "día" else "días"} de vida" } ?: "") +
                when (v.donde) { "reloj" -> " · en tu reloj"; "robot" -> " · en el robot"; else -> "" },
                style = estilo(10.sp, GRIS), modifier = Modifier.padding(top = 3.dp))
        }
    }
}

@Composable
private fun QueHacemos(vida: Vida, volver: () -> Unit) {
    // las órdenes que ya existen (rules.py / alma_core): baila, ven, gira, a dormir, juega, mírame
    val ordenes = listOf(
        Triple("dance", "Baila", R.drawable.ic_baila), Triple("come", "Ven", R.drawable.ic_ven),
        Triple("turn_around", "Gira", R.drawable.ic_gira), Triple("sleep", "A dormir", R.drawable.ic_dormir),
        Triple("play", "Juega", R.drawable.ic_juega), Triple("look_at_me", "Mírame", R.drawable.ic_mirame),
    )
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val s = maxWidth
        val r = s * 0.27f
        val b = s * 0.205f
        Text("¿Qué hacemos?", style = estilo(13.sp), modifier = Modifier.align(Alignment.TopCenter).padding(top = 10.dp))
        Ojitos(s * 0.24f, modifier = Modifier.align(Alignment.Center).offset(y = s * 0.035f).clickable { volver() })
        ordenes.forEachIndexed { i, (id, nombre, dibujo) ->
            val ang = Math.toRadians(-90.0 + i * 60.0)
            BotonRedondo(dibujo, nombre, b, { vida.orden(id); volver() },
                Modifier.align(Alignment.Center).offset(x = r * cos(ang).toFloat(), y = r * sin(ang).toFloat() + s * 0.035f))
        }
    }
}

// con Alma en el reloj (dueño, 2026-11-03): las órdenes de arriba son para el robot; aquí, las que tienen sentido en la muñeca
@Composable
private fun QueHacemosReloj(hacer: (String) -> Unit) {
    val acciones = listOf(
        Triple("cosquillas", "Cosquillas", R.drawable.ic_cosquillas), Triple("sacudir", "Sacúdela", R.drawable.ic_vibra),
        Triple("soplar", "Sóplale", R.drawable.ic_soplar), Triple("animo", "Ánimo", R.drawable.ic_animo),
        Triple("regano", "Regáñala", R.drawable.ic_regano),
    )
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val s = maxWidth
        val r = s * 0.27f
        val b = s * 0.205f
        Text("¿Qué le haces?", style = estilo(13.sp), modifier = Modifier.align(Alignment.TopCenter).padding(top = 10.dp))
        Ojitos(s * 0.24f, Expresion.JUGUETONA, Modifier.align(Alignment.Center).offset(y = s * 0.035f))
        acciones.forEachIndexed { i, (id, nombre, dibujo) ->
            val ang = Math.toRadians(-90.0 + i * 72.0)
            BotonRedondo(dibujo, nombre, b, { hacer(id) },
                Modifier.align(Alignment.Center).offset(x = r * cos(ang).toFloat(), y = r * sin(ang).toFloat() + s * 0.035f))
        }
    }
}

private const val COSQUILLAS_MS = 8000L   // cuánto dura el modo cosquillas
private const val COSQUILLAS_MAX = 12     // más toques que esto: se enoja
private const val ESPERA_MS = 6000L       // sacudir y soplar: cuánto espera

@Composable
private fun Comida(vida: Vida, volver: () -> Unit) {
    val comidas = listOf(
        Triple("manzana", "Manzana", R.drawable.co_manzana), Triple("platano", "Plátano", R.drawable.co_platano),
        Triple("zanahoria", "Zanahoria", R.drawable.co_zanahoria), Triple("tacos", "Taco", R.drawable.co_tacos),
        Triple("pizza", "Pizza", R.drawable.co_pizza), Triple("galleta", "Galleta", R.drawable.co_galleta),
        Triple("helado", "Helado", R.drawable.co_helado), Triple("leche", "Leche", R.drawable.co_leche),
        Triple("medicina", "Medicina", R.drawable.co_medicina),
    )
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val s = maxWidth
        val b = s * 0.22f
        Column(Modifier.fillMaxSize().padding(top = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("¿Qué le das?", style = estilo(15.sp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Acentos(Modifier.size(14.dp))
                Ojitos(s * 0.18f, Expresion.JUGUETONA)
                Acentos(Modifier.size(14.dp))
            }
            for (fila in comidas.chunked(3)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(vertical = 2.dp)) {
                    fila.forEach { (id, nombre, dibujo) -> BotonRedondo(dibujo, nombre, b, { vida.comer(id); volver() }) }
                }
            }
        }
    }
}

@Composable
private fun Mudanza(vida: Vida, v: Vista, volver: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val s = maxWidth
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            Hora(arriba = 20.dp, grande = false)
            Ojitos(s * 0.42f, if (v.aqui) Expresion.FELIZ else Expresion.CALMA, Modifier.padding(top = 4.dp))
            Text(when (v.donde) { "reloj" -> "Alma está contigo"; "robot" -> "Alma está en el robot"; "transito" -> "Mudándose…"; else -> "Alma" },
                style = estilo(15.sp), modifier = Modifier.padding(vertical = 4.dp))
            when {
                !v.robotListo -> Text("El robot todavía no sabe mudarse", style = estilo(11.sp, GRIS))
                v.donde == "robot" -> Pastilla("Llévame contigo") { vida.mudanza("reloj"); volver() }
                v.donde == "reloj" -> Text("Regresa al robot", style = estilo(13.sp, GRIS).copy(textDecoration = TextDecoration.Underline),
                    modifier = Modifier.padding(8.dp).clickable { vida.mudanza("robot"); volver() })
            }
            if (v.sinRed) Text("Sin conexión con el servidor", style = estilo(11.sp, NARANJA))
        }
    }
}

@Composable
internal fun Pastilla(texto: String, alClick: () -> Unit) {
    Row(
        Modifier.padding(horizontal = 26.dp).fillMaxWidth().clip(RoundedCornerShape(50)).background(CARBON)
            .border(2.dp, CIAN, RoundedCornerShape(50)).clickable(onClick = alClick).padding(vertical = 9.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        Dibujo(R.drawable.ic_reloj, 22.dp)
        Spacer(Modifier.width(8.dp))
        Text(texto, style = estilo(15.sp))
    }
}

// ---------- 5. Te escucho ----------
@Composable
private fun TeEscucho(texto: String, cancelar: () -> Unit) {
    Box(Modifier.fillMaxSize().clickable { cancelar() }) {
        CaraAlma(Expresion.CALMA, Offset.Zero, 0.0, false, bajar = -0.06f, tam = 0.29f)
        Canvas(Modifier.fillMaxSize()) {
            val c = Offset(size.width / 2, size.height * 0.44f)
            for (k in 0..2) {
                val r = size.width * (0.38f + k * 0.035f)
                val a = 0.9f - k * 0.25f
                for (lado in listOf(0f, 180f)) {
                    drawArc(Color(0xFF0086FF).copy(alpha = a), lado - 35f, 70f, false, Offset(c.x - r, c.y - r),
                        Size(r * 2, r * 2), style = Stroke(5f, cap = StrokeCap.Round))
                }
            }
        }
        Column(Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp, start = 24.dp, end = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            if (texto.isNotBlank()) Text("“$texto”", style = estilo(19.sp), textAlign = TextAlign.Center, maxLines = 2)
            Text("Te escucho…", style = estilo(14.sp, GRIS))
        }
    }
}

// ---------- 6. ¡Llegué! ----------
@Composable
private fun Llego() {
    Box(Modifier.fillMaxSize()) {
        CaraAlma(Expresion.AMOR, Offset.Zero, 0.0, false, bajar = -0.06f, tam = 0.27f)
        Acentos(Modifier.align(Alignment.TopStart).offset(x = 70.dp, y = 92.dp))
        Acentos(Modifier.align(Alignment.TopEnd).offset(x = (-70).dp, y = 92.dp))
        Column(Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("¡Ya estoy contigo!", style = estilo(19.sp))
            Dibujo(R.drawable.ic_vibra, 32.dp, Modifier.padding(top = 4.dp))
        }
    }
}

// ---------- vincular ----------
@Composable
private fun Vincular(vida: Vida, mensaje: String) {
    val pedir = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val codigo = r.data?.let { RemoteInput.getResultsFromIntent(it)?.getCharSequence("codigo")?.toString() }
        if (!codigo.isNullOrBlank()) vida.vincular(codigo)
    }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Ojitos(70.dp)
        Text("Vincula el reloj desde la app de Alma del celular, o escribe aquí el código de la app web.",
            style = estilo(11.sp, GRIS), textAlign = TextAlign.Center, modifier = Modifier.padding(vertical = 8.dp))
        Row(
            Modifier.clip(RoundedCornerShape(50)).background(CARBON).border(1.5.dp, CIAN, RoundedCornerShape(50))
                .clickable {
                    val ri = RemoteInput.Builder("codigo").setLabel("Código").build()
                    val i: Intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
                    RemoteInputIntentHelper.putRemoteInputsExtra(i, listOf(ri))
                    pedir.launch(i)
                }.padding(horizontal = 18.dp, vertical = 9.dp),
        ) { Text("Escribir código", style = estilo(14.sp)) }
        if (mensaje.isNotEmpty()) Text(mensaje, style = estilo(11.sp, GRIS), modifier = Modifier.padding(top = 6.dp))
    }
}
