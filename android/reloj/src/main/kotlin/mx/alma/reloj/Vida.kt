package mx.alma.reloj

import android.content.Context
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import mx.alma.nucleo.Ev
import mx.alma.nucleo.NucleoReloj
import mx.alma.protocolo.Accion
import mx.alma.protocolo.Cuerpo
import mx.alma.protocolo.Directiva
import mx.alma.protocolo.Evento
import mx.alma.protocolo.Local
import mx.alma.protocolo.Ordenes
import mx.alma.protocolo.Soltada
import mx.alma.protocolo.Tabla
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** Lo que la pantalla necesita saber. */
data class Vista(
    val vinculado: Boolean = false,
    val donde: String = "?",            // reloj, robot, transito
    val aqui: Boolean = false,          // Alma vive en este reloj ahora
    val robotListo: Boolean = false,
    val animo: String = "SM_CALM",
    val estado: String = "ST_AWAKE",
    val conducta: String = "",
    val hambre: Double = 0.0,
    val enferma: Boolean = false,
    val energia: Double? = null,        // 0..1 (cuidado del servidor)
    val bienestar: Double? = null,      // 0..1 (wellbeing de −1023 a 1023)
    val edadDias: Int? = null,
    val robotEnLinea: Boolean = false,
    val mensaje: String = "",
    val aviso: String = "",             // llegada, se fue, se durmió: dispara animación
    val sinRed: Boolean = false,
)

/**
 * Alma en el reloj: el protocolo de mudanza (mx.alma.protocolo.Cuerpo) con el núcleo real, la red y lo que se
 * guarda. Todo pasa en un solo hilo; la pantalla, el trabajo programado y la Data Layer piden cosas aquí.
 */
class Vida private constructor(private val ctx: Context) {
    private val hilo = Executors.newSingleThreadExecutor { Thread(it, "alma-vida") }.asCoroutineDispatcher()
    val scope = CoroutineScope(SupervisorJob() + hilo)
    val cfg = Config(ctx)
    private val red = Red(cfg)
    private val nucleo = NucleoReloj(ctx)
    private val archivo = File(ctx.filesDir, "cuerpo.json")
    private val local = Local()
    private val cuerpo = Cuerpo("reloj", LEASE_S, local, nucleo)
    private var tabla: Tabla = Ordenes.porOmision
    private var ultimoRespaldo = 0.0
    private var donde = JSONObject()
    private var robot: JSONObject? = null

    private val _vista = MutableStateFlow(Vista())
    val vista: StateFlow<Vista> = _vista

    init {
        scope.launch {
            cargar()
            if (local.activo && nucleo.hayCopia()) nucleo.despertar()
            refrescar()
        }
    }

    private fun ahora() = System.currentTimeMillis() / 1000.0

    // ---------- guardar ----------
    private fun guardar() {
        val o = JSONObject()
            .put("n", local.n).put("seq", local.seq).put("activo", local.activo).put("lease", local.leaseHasta)
            .put("turno", local.turnoEn).put("ultima", nucleo.ultimaHora())
            .put("mem", JSONArray(local.mem.values.map { Red.eventoJson(it) }))
            .put("respaldada", JSONArray(local.respaldada.toList()))
            .put("pendientes", JSONArray(local.pendientes))
            .put("acuses", JSONArray(local.acuses))
            .put("recibidas", JSONArray(local.recibidas.toList().takeLast(50)))
            .put("soltadas", JSONObject().apply {
                local.soltadas.entries.toList().takeLast(5).forEach { (mid, s) ->
                    put(mid, JSONObject().put("pkg", Red.b64(s.pkg)).put("meta", JSONArray(s.meta.map { Red.eventoJson(it) })))
                }
            })
        val tmp = File(archivo.path + ".tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(archivo)
    }

    private fun cargar() {
        if (!archivo.exists()) return
        val o = runCatching { JSONObject(archivo.readText()) }.getOrNull() ?: return
        local.n = o.optInt("n"); local.seq = o.optInt("seq"); local.activo = o.optBoolean("activo")
        local.leaseHasta = o.optDouble("lease", -1.0); local.turnoEn = o.optDouble("turno", -1.0)
        o.optJSONArray("mem")?.let { a -> for (i in 0 until a.length()) Red.evento(a.getJSONObject(i)).let { local.mem[it.id] = it } }
        local.respaldada = lista(o.optJSONArray("respaldada")).toSet()
        local.pendientes = lista(o.optJSONArray("pendientes"))
        local.acuses.addAll(lista(o.optJSONArray("acuses")))
        local.recibidas.addAll(lista(o.optJSONArray("recibidas")))
        o.optJSONObject("soltadas")?.let { so ->
            so.keys().forEach { mid ->
                val s = so.getJSONObject(mid)
                val meta = s.getJSONArray("meta").let { a -> (0 until a.length()).map { Red.evento(a.getJSONObject(it)) } }
                local.soltadas[mid] = Soltada(Base64.decode(s.getString("pkg"), Base64.DEFAULT), meta)
            }
        }
        nucleo.abrir(o.optDouble("ultima", ahora()))
    }

    private fun lista(a: JSONArray?) = if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) }

    // ---------- protocolo ----------
    /** Un contacto con el servidor: hello, la orden, y lo que la orden pida (soltar, acusar, respaldar). */
    suspend fun sincronizar(): Boolean = withContext(hilo) {
        if (!cfg.vinculado) { refrescar(); return@withContext false }
        try {
            ejecutar(cuerpo.vivir(ahora()))
            val h = cuerpo.hello(ahora())
            val r = red.hello(h, salud = Salud.resumen(ctx))
            donde = r.donde
            robot = r.robot
            ejecutar(cuerpo.aplicar(r.directiva, h.enviadoEn, ahora(), llevabaEventos = h.eventos.isNotEmpty()))
            if (r.directiva is Directiva.Recibir || r.directiva is Directiva.Soltar) {
                // después de soltar o recibir, otro contacto para quedar con la orden vigente
                val h2 = cuerpo.hello(ahora())
                val r2 = red.hello(h2)
                donde = r2.donde
                ejecutar(cuerpo.aplicar(r2.directiva, h2.enviadoEn, ahora(), h2.eventos.isNotEmpty()))
            }
            if (cuerpo.corriendo(ahora()) && ahora() - ultimoRespaldo > RESPALDO_S) ejecutar(listOf(cuerpo.respaldo()))
            if (tabla === Ordenes.porOmision) runCatching { tabla = tablaDe(red.ordenes()) }
            mandarCola()
            _vista.value = _vista.value.copy(sinRed = false)
            refrescar()
            true
        } catch (e: Exception) {
            _vista.value = _vista.value.copy(sinRed = true, mensaje = "Sin conexión")
            refrescar()
            false
        }
    }

    private fun ejecutar(acciones: List<Accion>) {
        for (a in acciones) when (a) {
            is Accion.Guardar -> guardar()
            is Accion.MandarSoltada -> red.soltar(a.mid, a.pkg, a.meta)
            is Accion.MandarAcuse -> red.acuse(a.mid, a.ok, a.por)
            is Accion.MandarRespaldo -> {
                val ok = runCatching { red.respaldo(a.n, a.seq, a.pkg, a.meta) }.getOrDefault(false)
                cuerpo.resultadoRespaldo(ok, a.meta)
                if (ok) ultimoRespaldo = ahora()
                guardar()
            }
            is Accion.Aviso -> avisar(a.tipo)
        }
    }

    private fun avisar(tipo: String) {
        when {
            tipo.startsWith("llego") -> Vibrar.aterrizaje(ctx)
            tipo == "se_fue" -> Vibrar.despedida(ctx)
            tipo == "dormida" -> Vibrar.suave(ctx)
        }
        _vista.value = _vista.value.copy(aviso = tipo)
    }

    // ---------- vivir con la app abierta ----------
    /** Cada segundo con la pantalla prendida. */
    fun latido() = scope.launch {
        ejecutar(cuerpo.vivir(ahora()))
        nucleo.correr()
        refrescar()
    }

    fun teMira() = scope.launch { nucleo.evento(Ev.FACE_SEEN, -1, 70f) }

    private fun refrescar() {
        val st = if (nucleo.hayCopia() && cuerpo.corriendo(ahora())) nucleo.estado() else null
        val r = robot
        val cuerpoAhora = donde.optString("cuerpo", if (st != null) "reloj" else "?")
        _vista.value = _vista.value.copy(
            vinculado = cfg.vinculado,
            donde = cuerpoAhora,
            aqui = st != null,
            robotListo = donde.optBoolean("robot_listo", false),
            animo = st?.optString("mood") ?: r?.optString("mood")?.ifEmpty { null } ?: "SM_CALM",
            estado = st?.optString("state") ?: r?.optString("state")?.ifEmpty { null } ?: "ST_AWAKE",
            conducta = st?.optString("behavior") ?: "",
            hambre = st?.optDouble("hunger") ?: r?.optJSONObject("care")?.optDouble("hunger") ?: 0.0,
            enferma = st?.let { it.optInt("sick") != 0 } ?: (r?.optJSONObject("care")?.optBoolean("sick") ?: false),
            energia = st?.optDouble("energy") ?: r?.optJSONObject("care")?.optDouble("energy")?.takeIf { !it.isNaN() },
            bienestar = (st?.optDouble("wellbeing") ?: r?.optDouble("wellbeing")?.takeIf { !it.isNaN() })
                ?.let { ((it + 1023.0) / 2046.0).coerceIn(0.0, 1.0) },
            edadDias = st?.optInt("age_days") ?: r?.optInt("age_days", -1)?.takeIf { it >= 0 },
            robotEnLinea = r?.optBoolean("online") ?: false,
        )
        val antes = Instantanea.leer(ctx)
        Instantanea.guardar(ctx, _vista.value)
        if (Instantanea.codigo(antes) != Instantanea.codigo(_vista.value)) Carita.actualizar(ctx)
    }

    private fun nuevoId() = "reloj-" + UUID.randomUUID().toString().take(12)

    // ---------- lo que hace el dueño ----------
    fun acariciar() = scope.launch {
        if (cuerpo.corriendo(ahora())) {
            nucleo.evento(Ev.TOUCH_PET, -1, 1500f)
            Vibrar.ronroneo(ctx)
        } else remoto(Evento(nuevoId(), "caricia", mapOf("de" to "reloj")))
        refrescar()
    }

    fun molestar() = scope.launch {
        if (cuerpo.corriendo(ahora())) nucleo.evento(Ev.TOUCH_TAP, -1, 0f)
        refrescar()
    }

    // ---------- acciones del reloj (dueño, 2026-11-03: "Baila, Ven, Gira… son para el robot; hay que hacer unas para el
    // reloj"): cosquillas, sacudirla, soplarle, ánimo y regaño. Solo con Alma aquí; con los eventos que ya tiene el núcleo
    private fun alNucleo(tipo: Int, valor: Float = 0f) = scope.launch {
        if (cuerpo.corriendo(ahora())) nucleo.evento(tipo, -1, valor)
        refrescar()
    }
    fun cosquilla() { alNucleo(Ev.TOUCH_PET, 400f); Vibrar.risita(ctx) }   // una caricia corta: alegría
    fun sacudida() { alNucleo(Ev.SHAKEN, 1f); Vibrar.mareo(ctx) }           // el mismo susto que en el robot
    fun soplido() { alNucleo(Ev.TOUCH_PET, 300f); Vibrar.soplo(ctx) }
    fun animar() { alNucleo(Ev.PRAISE); Vibrar.ronroneo(ctx) }
    fun reganar() { alNucleo(Ev.SCOLD); Vibrar.suave(ctx) }

    fun comer(comida: String) = scope.launch {
        val e = Evento(nuevoId(), "comida", mapOf("food" to comida), ahora())
        if (cuerpo.corriendo(ahora())) {
            // con conexión decide el cuidado del servidor (el mismo que en el robot); sin conexión, el núcleo
            val r = runCatching { red.comer(comida, _vista.value.estado, _vista.value.animo) }.getOrNull()
            if (r != null) {
                r.optJSONObject("care")?.let { c -> nucleo.cuidado(c.optDouble("hunger"), c.optBoolean("sick"), c.optDouble("energy", 0.0)) }
                _vista.value = _vista.value.copy(mensaje = r.optString("comment").ifEmpty { if (r.optBoolean("accepted")) "¡Ñam!" else "No quiso" })
            }
            ejecutar(cuerpo.evento(e, ahora()))
            if (r == null) nucleo.comer(comida)
        } else remoto(e)
        refrescar()
    }

    fun orden(actionId: String) = scope.launch {
        if (cuerpo.corriendo(ahora())) nucleo.evento(Ev.REMOTE_COMMAND, Ev.ACCION[actionId] ?: return@launch, 0f)
        else remoto(Evento(nuevoId(), "orden", mapOf("action_id" to actionId)))
        refrescar()
    }

    /** Voz (9): tabla local solo si toda la frase es una orden; lo demás va al servidor y a Haiku. */
    fun voz(texto: String) = scope.launch {
        val o = Ordenes.local(texto, tabla)
        when {
            o?.actionId != null -> orden(o.actionId!!)
            o?.intent == "praise" -> if (cuerpo.corriendo(ahora())) nucleo.evento(Ev.PRAISE) else Unit
            o?.intent == "scold" -> if (cuerpo.corriendo(ahora())) nucleo.evento(Ev.SCOLD) else Unit
            else -> {
                val r = runCatching { red.voz(texto) }.getOrNull()
                val a = r?.optString("action_id")?.ifEmpty { null }
                if (a != null && cuerpo.corriendo(ahora())) nucleo.evento(Ev.REMOTE_COMMAND, Ev.ACCION[a] ?: -1, 0f)
                _vista.value = _vista.value.copy(mensaje = if (r == null) "No te entendí (sin conexión)" else if (a == null) "Se quedó pensando…" else "")
            }
        }
        refrescar()
    }

    private fun remoto(e: Evento) {
        val r = runCatching { red.eventoRemoto(e) }.getOrNull()
        _vista.value = _vista.value.copy(mensaje = when {
            r == null -> "Sin conexión con el robot"
            r.optBoolean("ok") || r.has("accepted") -> ""
            else -> r.optString("why", "")
        })
    }

    fun mudanza(a: String) = scope.launch {
        val r = runCatching { red.mudanza("m" + UUID.randomUUID().toString().take(10), a, "boton") }.getOrNull()
        _vista.value = _vista.value.copy(mensaje = when {
            r == null -> "Sin conexión"
            r.optBoolean("ok") -> if (a == "reloj") "¡Ya voy!" else "Regresando al robot…"
            else -> r.optString("why")
        })
        sincronizar()
    }

    fun vincular(codigo: String) = scope.launch {
        val r = runCatching { red.vincular(codigo.filter { it.isDigit() }) }
        r.onSuccess { cfg.llave = it; _vista.value = _vista.value.copy(mensaje = "¡Listo!") }
            .onFailure { _vista.value = _vista.value.copy(mensaje = "Código inválido o vencido") }
        sincronizar()
    }

    fun ponerLlave(servidor: String?, llave: String) = scope.launch {
        if (!servidor.isNullOrBlank()) cfg.servidor = servidor
        cfg.llave = llave
        sincronizar()
    }

    /** Tarea programada (cada 15 min): ponerse al día sin conductas y contactar al servidor (8.1). */
    suspend fun tarea() {
        withContext(hilo) { nucleo.ponerseAlDia() }
        sincronizar()
        withContext(hilo) { Avisos.revisar(ctx, _vista.value) }
    }

    fun limpiarAviso() { _vista.value = _vista.value.copy(aviso = "") }

    // ---------- juegos (relay/alma_relay/juegos_reloj.py; misma idea que los juegos de la app) ----------
    data class Inicio(val ok: Boolean, val razon: String?, val skill: Double, val nivel: String)

    private val prefsJuegos = ctx.getSharedPreferences("juegos", Context.MODE_PRIVATE)

    /** ¿Quiere jugar? y su nivel en ese juego. Sin conexión juega con el último nivel conocido. */
    suspend fun empezarJuego(id: String): Inicio = withContext(hilo) {
        val r = runCatching { red.juegoEmpezar(id) }.getOrNull()
        val ini = if (r != null) {
            prefsJuegos.edit().putFloat("skill_$id", r.optDouble("skill", 0.0).toFloat())
                .putString("nivel_$id", r.optString("nivel", "principiante")).apply()
            Inicio(r.optBoolean("ok", true), r.optString("razon").ifEmpty { null }, r.optDouble("skill", 0.0),
                r.optString("nivel", "principiante"))
        } else Inicio(true, null, prefsJuegos.getFloat("skill_$id", 0f).toDouble(),
            prefsJuegos.getString("nivel_$id", "principiante")!!)
        if (ini.ok && cuerpo.corriendo(ahora())) nucleo.juego("empieza")
        ini
    }

    fun nivelGuardado(id: String): String = prefsJuegos.getString("nivel_$id", "principiante")!!

    /** Fin de la partida: a su núcleo si vive aquí; al servidor (el robot reacciona si vive allá). Sin red, se encola. */
    fun terminarJuego(id: String, ganador: String, segundos: Int, puntos: Map<String, Int>) = scope.launch {
        val tipo = when (ganador) { "alma" -> "gana_alma"; "owner" -> "pierde_alma"; else -> "empate" }
        if (cuerpo.corriendo(ahora())) nucleo.juego(tipo)
        val b = JSONObject().put("ganador", ganador).put("segundos", segundos).put("puntos", JSONObject(puntos as Map<*, *>))
        val cola = JSONArray(prefsJuegos.getString("cola", "[]")).put(JSONObject().put("id", id).put("b", b))
        prefsJuegos.edit().putString("cola", cola.toString()).apply()
        mandarCola()
        refrescar()
    }

    /** Un momento del juego (buena_jugada, mala_jugada): solo para que Alma reaccione. */
    fun momentoJuego(id: String, tipo: String) = scope.launch {
        if (cuerpo.corriendo(ahora())) nucleo.juego(tipo)
        runCatching { red.juegoEvento(id, JSONObject().put("tipo", tipo)) }
    }

    private fun mandarCola() {
        val cola = JSONArray(prefsJuegos.getString("cola", "[]"))
        val quedan = JSONArray()
        for (i in 0 until cola.length()) {
            val e = cola.getJSONObject(i)
            val r = runCatching { red.juegoEvento(e.getString("id"), e.getJSONObject("b")) }
            val codigo = (r.exceptionOrNull() as? SinRed)?.codigo ?: 0
            if (r.isFailure) { if (codigo !in 400..499 || codigo == 401 || codigo == 429) quedan.put(e) }   // rechazada: no se reintenta
            else r.getOrNull()?.optJSONObject("nivel")?.let { n ->
                prefsJuegos.edit().putFloat("skill_${e.getString("id")}", n.optDouble("skill").toFloat())
                    .putString("nivel_${e.getString("id")}", n.optString("nivel")).apply()
            }
        }
        prefsJuegos.edit().putString("cola", quedan.toString()).apply()
    }

    /** 10 preguntas del servidor; sin conexión, el último lote guardado (si no se usó). */
    suspend fun preguntas(): JSONArray? = withContext(hilo) {
        val r = runCatching { red.preguntas(mx.alma.protocolo.Preguntas.POR_PARTIDA) }.getOrNull()
        if (r != null) {
            val lote = r.getJSONArray("preguntas")
            // el siguiente lote, de reserva para jugar sin conexión
            runCatching { red.preguntas(mx.alma.protocolo.Preguntas.POR_PARTIDA) }.getOrNull()?.let {
                prefsJuegos.edit().putString("reserva", it.getJSONArray("preguntas").toString()).apply()
            }
            lote
        } else prefsJuegos.getString("reserva", null)?.let {
            prefsJuegos.edit().remove("reserva").apply()
            JSONArray(it)
        }
    }

    fun respuesta(id: String, acerto: Boolean) = scope.launch { runCatching { red.respuesta(id, acerto) } }

    private fun tablaDe(o: JSONObject): Tabla {
        fun l(a: JSONArray?) = if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) }
        val acc = o.getJSONObject("actions")
        return Tabla(acc.keys().asSequence().associateWith { l(acc.getJSONArray(it)) }, l(o.optJSONArray("praise")),
            l(o.optJSONArray("scold")), l(o.optJSONArray("fillers")))
    }

    companion object {
        const val LEASE_S = 72 * 3600.0          // el reloj vive sin conexión hasta 3 días (5.2)
        const val RESPALDO_S = 10 * 60.0
        @Volatile private var una: Vida? = null
        fun de(ctx: Context): Vida = una ?: synchronized(this) { una ?: Vida(ctx.applicationContext).also { una = it } }
    }
}
