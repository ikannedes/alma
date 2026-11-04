package mx.alma.protocolo

/*
 * El lado del cuerpo del protocolo de mudanza (PLAN-RELOJ-v2.md, secciones 5 y 5.7). El árbitro vive en el servidor
 * (relay/alma_relay/body.py); este código es el que corre en el reloj. Las cuatro reglas de 5.7 las encontró la
 * prueba de caos de la fase 0 y aquí van marcadas.
 */

/** Un evento importante con id único (5.6): comida, truco aprendido u olvidado, hito, foto, caricia relevante. */
data class Evento(
    val id: String,
    val tipo: String,
    val datos: Map<String, String> = emptyMap(),
    val en: Double = 0.0,
    val recuerdoDe: String? = null,
)

/** Lo que manda el servidor en cada contacto (directive). */
sealed class Directiva {
    data class Seguir(val n: Int, val leaseS: Double, val eventos: List<Evento>) : Directiva()
    data class Soltar(val mid: String, val n: Int) : Directiva()
    class Recibir(
        val mid: String, val n: Int, val pkg: ByteArray, val meta: List<Evento>,
        val en: Double, val ahoraServidor: Double, val razon: String, val seq: Int,
    ) : Directiva()
    data class NoEsta(val n: Int) : Directiva()
}

/** El núcleo de Alma en este cuerpo (en el reloj, el NDK; en las pruebas, un doble). */
interface Nucleo {
    fun hayCopia(): Boolean
    fun exportar(): ByteArray
    /** Importa el paquete (valida antes de usarlo) y se pone al día `transcurridoS` segundos sin conductas (8.1). */
    fun importar(pkg: ByteArray, transcurridoS: Double): Boolean
    fun dormir()
    fun despertar()
    fun aplicar(e: Evento)
    fun descartar()
}

class Soltada(val pkg: ByteArray, val meta: List<Evento>)

/** Estado local que se guarda junto a la memoria. */
class Local {
    var n = 0
    var seq = 0
    var activo = false
    var leaseHasta = -1.0
    var turnoEn = -1.0                                   // último cambio de turno (regla 1)
    val mem = LinkedHashMap<String, Evento>()            // eventos importantes en la memoria actual
    var respaldada: Set<String> = emptySet()             // los del último respaldo aceptado
    var pendientes: List<String> = emptyList()           // por recuperar tras perder el turno (5.6)
    val acuses = ArrayList<String>()
    val soltadas = HashMap<String, Soltada>()
    val recibidas = HashSet<String>()

    fun recortar(max: Int = MAX_MEM) {
        while (mem.size > max) mem.remove(mem.keys.first())
        while (acuses.size > 200) acuses.removeAt(0)
    }

    companion object {
        const val MAX_MEM = 300
    }
}

sealed class Accion {
    class MandarSoltada(val mid: String, val pkg: ByteArray, val meta: List<Evento>) : Accion()
    data class MandarAcuse(val mid: String, val ok: Boolean, val por: String = "") : Accion()
    class MandarRespaldo(val n: Int, val seq: Int, val pkg: ByteArray, val meta: List<Evento>) : Accion()
    object Guardar : Accion()
    data class Aviso(val tipo: String) : Accion()       // llegó, se fue, se durmió: para animación y vibración
}

class Hello(val n: Int, val eventos: List<Evento>, val acuses: List<String>, val enviadoEn: Double)

class Cuerpo(val nombre: String, val leaseS: Double, val local: Local, val nucleo: Nucleo) {

    fun corriendo(ahora: Double) = local.activo && nucleo.hayCopia() && ahora < local.leaseHasta

    /** Llamar seguido: si el lease caducó, Alma se duerme sola, sin esperar al servidor (6.4). */
    fun vivir(ahora: Double): List<Accion> {
        if (local.activo && ahora >= local.leaseHasta) {
            nucleo.dormir()
            local.activo = false
            return listOf(Accion.Guardar, Accion.Aviso("dormida"))
        }
        return emptyList()
    }

    fun hello(ahora: Double) = Hello(
        n = local.n,
        eventos = local.pendientes.mapNotNull { local.mem[it] },
        acuses = local.acuses.filter { it in local.mem },          // regla 4: solo de la memoria actual
        enviadoEn = ahora,
    )

    /** Algo importante que pasó aquí mientras Alma vive en este cuerpo: a la memoria y respaldo inmediato (5.5). */
    fun evento(e: Evento, ahora: Double): List<Accion> {
        if (!corriendo(ahora)) return emptyList()
        local.mem[e.id] = e
        nucleo.aplicar(e)
        local.recortar()
        return listOf(Accion.Guardar, respaldo())
    }

    /** Respaldo numerado (regla 2): el servidor ignora uno más viejo que el guardado. */
    fun respaldo(): Accion.MandarRespaldo {
        local.seq += 1
        return Accion.MandarRespaldo(local.n, local.seq, nucleo.exportar(), local.mem.values.toList())
    }

    fun resultadoRespaldo(ok: Boolean, meta: List<Evento>) {
        if (ok) local.respaldada = meta.map { it.id }.toSet()
    }

    /**
     * Aplica la orden del servidor. enviadoEn: cuándo se mandó el hello que la trajo (el lease se cuenta desde ahí);
     * llevabaEventos: ese hello llevaba eventos por recuperar.
     */
    fun aplicar(d: Directiva, enviadoEn: Double, ahora: Double, llevabaEventos: Boolean = false): List<Accion> {
        val l = local
        vivir(ahora)
        if (enviadoEn < l.turnoEn) return emptyList()           // regla 1: respuesta vieja
        return when (d) {
            is Directiva.Seguir -> seguir(d, enviadoEn, ahora)
            is Directiva.Soltar -> soltar(d, ahora)
            is Directiva.Recibir -> recibir(d, enviadoEn, ahora)
            is Directiva.NoEsta -> noEsta(d, ahora, llevabaEventos)
        }
    }

    private fun seguir(d: Directiva.Seguir, enviadoEn: Double, ahora: Double): List<Accion> {
        val l = local
        if (d.n != l.n || !nucleo.hayCopia()) return emptyList()
        val out = ArrayList<Accion>()
        if (!l.activo) {
            nucleo.despertar()
            l.activo = true
            out += Accion.Aviso("despierta")
        }
        l.leaseHasta = maxOf(l.leaseHasta, enviadoEn + d.leaseS)
        var nuevos = false
        for (e in d.eventos) {
            if (e.id !in l.mem && corriendo(ahora)) {
                l.mem[e.id] = e
                nucleo.aplicar(e)
                nuevos = true
            }
            if (e.id in l.mem && e.id !in l.acuses) l.acuses += e.id
        }
        l.recortar()
        out += Accion.Guardar
        if (nuevos) out += respaldo()
        return out
    }

    private fun soltar(d: Directiva.Soltar, ahora: Double): List<Accion> {
        val l = local
        val s = l.soltadas[d.mid] ?: run {
            if (!nucleo.hayCopia()) return emptyList()
            if (l.activo) nucleo.dormir()
            l.activo = false
            l.turnoEn = ahora
            Soltada(nucleo.exportar(), l.mem.values.toList()).also { l.soltadas[d.mid] = it }
        }
        return listOf(Accion.Guardar, Accion.MandarSoltada(d.mid, s.pkg, s.meta), Accion.Aviso("se_fue"))
    }

    private fun recibir(d: Directiva.Recibir, enviadoEn: Double, ahora: Double): List<Accion> {
        val l = local
        if (d.mid in l.recibidas && l.n == d.n) return listOf(Accion.MandarAcuse(d.mid, true))
        val metaIds = d.meta.map { it.id }.toSet()
        // regla 3: lo que la copia vieja vivió y la nueva no trae vuelve como recuerdo
        val sobrantes = if (nucleo.hayCopia()) l.mem.values.filter { it.id !in metaIds } else emptyList()
        if (!nucleo.importar(d.pkg, maxOf(0.0, d.ahoraServidor - d.en))) {
            return listOf(Accion.MandarAcuse(d.mid, false, "no se pudo importar el paquete"))
        }
        l.mem.clear()
        d.meta.forEach { l.mem[it.id] = it }
        for (e in sobrantes) {
            l.mem[e.id] = e.copy(recuerdoDe = e.recuerdoDe ?: nombre)
            nucleo.aplicar(e)
        }
        l.n = d.n
        l.activo = true
        l.leaseHasta = enviadoEn + leaseS
        l.respaldada = metaIds
        l.pendientes = emptyList()
        l.acuses.clear()
        l.recibidas += d.mid
        l.seq = maxOf(l.seq, d.seq)
        l.turnoEn = ahora
        l.recortar()
        val out = mutableListOf<Accion>(Accion.Guardar, Accion.MandarAcuse(d.mid, true), Accion.Aviso("llego:" + d.razon))
        if (sobrantes.isNotEmpty()) out += respaldo()
        return out
    }

    private fun noEsta(d: Directiva.NoEsta, ahora: Double, llevabaEventos: Boolean): List<Accion> {
        val l = local
        val out = ArrayList<Accion>()
        if (l.activo) {
            nucleo.dormir()
            l.turnoEn = ahora
            out += Accion.Aviso("no_esta")
        }
        l.activo = false
        if (nucleo.hayCopia() && d.n > l.n) {
            if (!llevabaEventos) l.pendientes = l.mem.keys.filter { it !in l.respaldada }
            if (llevabaEventos || l.pendientes.isEmpty()) {
                nucleo.descartar()                                // descarta su copia (6.4)
                l.mem.clear()
                l.pendientes = emptyList()
                l.acuses.clear()
            }
        }
        out += Accion.Guardar
        return out
    }
}
