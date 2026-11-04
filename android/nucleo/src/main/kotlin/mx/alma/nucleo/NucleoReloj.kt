package mx.alma.nucleo

import android.content.Context
import mx.alma.protocolo.Evento
import mx.alma.protocolo.Nucleo
import org.json.JSONObject
import java.io.File
import java.util.TimeZone

/** Eventos y acciones de alma_core.h (mismo orden que los enum). */
object Ev {
    const val FACE_SEEN = 0
    const val PRAISE = 5
    const val SCOLD = 6
    const val REMOTE_COMMAND = 8
    const val TOUCH_TAP = 9
    const val TOUCH_PET = 10
    const val SHAKEN = 13
    const val TRICK = 25

    val ACCION = mapOf("come" to 0, "dance" to 1, "turn_around" to 2, "sleep" to 3, "wake_up" to 4,
        "look_at_me" to 5, "play" to 6, "stop" to 7, "greet" to 8, "go_home" to 9)
}

/** Segundos locales desde 1970 (la zona del dueño), el reloj del núcleo igual que en el robot. */
fun horaLocal(): Double {
    val ms = System.currentTimeMillis()
    return (ms + TimeZone.getDefault().getOffset(ms)) / 1000.0
}

/**
 * El núcleo real en el reloj, como lo pide el protocolo de mudanza. La memoria vive en files/alma.flash (512 KB,
 * mismo formato que en el robot). Todo se llama desde un solo hilo (el de Vida).
 */
class NucleoReloj(ctx: Context, private val hora: () -> Double = ::horaLocal) : Nucleo {
    private val ruta = File(ctx.filesDir, "alma.flash").absolutePath
    private var h = 0L
    var viva = false
        private set

    init {
        synchronized(NucleoReloj::class.java) {
            if (!cargado) {
                val cat = ctx.assets.open("catalog.json").bufferedReader().readText()
                val inv = ctx.assets.open("inventario_reloj.json").bufferedReader().readText()
                check(NucleoNativo.catalogo(cat, inv) > 0) { "catálogo inválido" }
                cargado = true
            }
        }
    }

    /** Abre la memoria guardada. `ultimaVez`: hora local de la última vez que vivió (para ponerse al día). */
    fun abrir(ultimaVez: Double): Boolean {
        cerrar()
        h = NucleoNativo.abrir(ruta, ultimaVez)
        return h != 0L
    }

    /** Solo para pruebas (fase 1): una Alma nueva que no es la del robot. */
    fun nacerDePrueba(semilla: Int) {
        cerrar()
        h = NucleoNativo.nacer(ruta, semilla, hora())
    }

    fun cerrar() {
        if (h != 0L) NucleoNativo.cerrar(h)
        h = 0L
    }

    override fun hayCopia() = h != 0L

    override fun exportar(): ByteArray = NucleoNativo.exportar(h) ?: error("no se pudo exportar")

    override fun importar(pkg: ByteArray, transcurridoS: Double): Boolean {
        cerrar()
        val ahora = hora()
        val nuevo = NucleoNativo.importar(ruta, pkg, ahora - transcurridoS)
        if (nuevo == 0L) return false
        h = nuevo
        NucleoNativo.ponerseAlDia(h, ahora)
        viva = false
        return true
    }

    override fun dormir() {
        if (h != 0L && viva) NucleoNativo.correr(h, hora())
        viva = false
    }

    override fun despertar() {
        if (h == 0L) return
        NucleoNativo.ponerseAlDia(h, hora())
        viva = true
    }

    override fun aplicar(e: Evento) {
        if (h == 0L) return
        when (e.tipo) {
            "comida" -> NucleoNativo.comer(h, e.datos["food"] ?: "manzana")
            "caricia" -> NucleoNativo.evento(h, Ev.TOUCH_PET, -1, 1500f)
            "elogio" -> NucleoNativo.evento(h, Ev.PRAISE, -1, 0f)
            "regaño" -> NucleoNativo.evento(h, Ev.SCOLD, -1, 0f)
            "orden" -> NucleoNativo.evento(h, Ev.REMOTE_COMMAND, Ev.ACCION[e.datos["action_id"]] ?: return, 0f)
            else -> {}       // hitos, fotos, trucos: los cuenta el servidor; aquí solo quedan como recuerdo
        }
    }

    override fun descartar() {
        cerrar()
        File(ruta).delete()
        viva = false
    }

    /** Vivir en tiempo real (app abierta). */
    fun correr() {
        if (h != 0L && viva) NucleoNativo.correr(h, hora())
    }

    /** Ponerse al día sin conductas (app cerrada, tarea programada; 8.1). */
    fun ponerseAlDia() {
        if (h != 0L) NucleoNativo.ponerseAlDia(h, hora())
    }

    fun evento(tipo: Int, accion: Int = -1, valor: Float = 0f) {
        if (h != 0L && viva) NucleoNativo.evento(h, tipo, accion, valor)
    }

    /** Un momento de juego (empieza, gana_alma, pierde_alma, empate, buena_jugada, mala_jugada). */
    fun juego(tipo: String) {
        if (h != 0L && viva) NucleoNativo.juego(h, tipo)
    }

    fun comer(comida: String): Int = if (h != 0L) NucleoNativo.comer(h, comida) else -1

    fun cuidado(hambre: Double, enferma: Boolean, energia: Double) {
        if (h != 0L) NucleoNativo.cuidado(h, hambre.toFloat(), if (enferma) 1 else 0, energia.toFloat())
    }

    fun estado(): JSONObject? = if (h != 0L) JSONObject(NucleoNativo.estado(h)) else null

    fun ultimaHora(): Double = if (h != 0L) NucleoNativo.ahora(h) else hora()

    companion object {
        private var cargado = false
    }
}
