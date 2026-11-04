package mx.alma.protocolo

import kotlin.math.abs
import kotlin.random.Random

/*
 * Juegos del reloj (dueño, 2026-11-01): la lógica sin pantalla. Mismo principio que los juegos de la app: Alma tiene un
 * nivel por juego (skill 0 principiante … 1 experta, lo calcula el servidor con las partidas jugadas, ver
 * relay/alma_relay/juegos_reloj.py) y con él juega mejor o hace el juego más difícil. Aquí no hay Haiku: decide al
 * instante y funciona sin conexión.
 */

// ---------- Mosqueta: Alma esconde la pelota y revuelve los vasos ----------
object Mosqueta {
    const val RONDAS = 5
    const val PARA_GANAR = 3                     // el dueño gana la partida con 3 de 5

    data class Ronda(val vasos: Int, val pelota: Int, val cambios: List<Pair<Int, Int>>, val msPorCambio: Int)

    /** Más vasos, más cambios y más rápido con el nivel de Alma y con cada ronda. */
    fun ronda(skill: Double, numero: Int, rnd: Random = Random.Default): Ronda {
        val vasos = when { skill >= 0.8 -> 5; skill >= 0.45 -> 4; else -> 3 }
        val n = (4 + numero + skill * 8).toInt()
        val ms = (650 - skill * 350 - numero * 25).toInt().coerceAtLeast(170)
        val pelota = rnd.nextInt(vasos)
        val cambios = List(n) {
            val a = rnd.nextInt(vasos)
            var b = rnd.nextInt(vasos - 1)
            if (b >= a) b++
            a to b
        }
        return Ronda(vasos, pelota, cambios, ms)
    }

    /** Dónde termina la pelota después de los cambios (cada cambio intercambia dos posiciones). */
    fun final(r: Ronda): Int {
        var p = r.pelota
        for ((a, b) in r.cambios) p = when (p) { a -> b; b -> a; else -> p }
        return p
    }
}

// ---------- Gato (tres en línea): el dueño es X, Alma es O ----------
object Gato {
    private val LINEAS = listOf(
        listOf(0, 1, 2), listOf(3, 4, 5), listOf(6, 7, 8), listOf(0, 3, 6),
        listOf(1, 4, 7), listOf(2, 5, 8), listOf(0, 4, 8), listOf(2, 4, 6),
    )

    /** 'X', 'O' o null; empate cuando no hay ganador y no quedan casillas. */
    fun ganador(t: CharArray): Char? {
        for (l in LINEAS) if (t[l[0]] != ' ' && t[l[0]] == t[l[1]] && t[l[1]] == t[l[2]]) return t[l[0]]
        return null
    }

    fun lleno(t: CharArray) = t.none { it == ' ' }

    private fun minimax(t: CharArray, turno: Char): Int {
        ganador(t)?.let { return if (it == 'O') 1 else -1 }
        if (lleno(t)) return 0
        val vals = t.indices.filter { t[it] == ' ' }.map { i ->
            t[i] = turno
            val v = minimax(t, if (turno == 'O') 'X' else 'O')
            t[i] = ' '
            v
        }
        return if (turno == 'O') vals.max() else vals.min()
    }

    fun mejor(t: CharArray): Int {
        val libres = t.indices.filter { t[it] == ' ' }
        return libres.maxBy { i -> t[i] = 'O'; val v = minimax(t, 'X'); t[i] = ' '; v }
    }

    /** De principiante muchas veces juega al azar; de experta casi siempre la mejor (nunca pierde). */
    fun jugadaDeAlma(t: CharArray, skill: Double, rnd: Random = Random.Default): Int {
        val libres = t.indices.filter { t[it] == ' ' }
        return if (rnd.nextDouble() < 0.25 + 0.75 * skill) mejor(t) else libres.random(rnd)
    }
}

// ---------- Palabras (rueda de letras): el dueño y Alma buscan las mismas palabras, contra el reloj ----------
object Palabras {
    const val SEGUNDOS = 90

    /** Una ronda: las letras de la rueda (sale de una palabra base) y las palabras que se pueden formar. */
    data class Ronda(val letras: String, val palabras: List<String>)

    /** ¿Se forma `palabra` con las letras de la rueda, cada una a lo más las veces que aparece? */
    fun cabe(palabra: String, letras: String): Boolean {
        val quedan = letras.groupingBy { it }.eachCount().toMutableMap()
        for (c in palabra) {
            val n = quedan[c] ?: 0
            if (n == 0) return false
            quedan[c] = n - 1
        }
        return true
    }

    /** Más letras en la rueda con el nivel de Alma: de principiante casi siempre 5, de experta casi siempre 7. */
    fun elegir(rondas: List<Ronda>, skill: Double, rnd: Random = Random.Default): Ronda {
        val largo = when {
            rnd.nextDouble() < skill * 0.75 -> 7
            rnd.nextDouble() < 0.25 + skill -> 6
            else -> 5
        }
        val grupo = rondas.filter { it.letras.length == largo }.ifEmpty { rondas }
        val r = grupo.random(rnd)
        return Ronda(revolver(r.letras, rnd), r.palabras.sortedWith(compareBy({ it.length }, { it })))
    }

    /** Las letras en otro orden (que no se lea la palabra base de corrido). */
    fun revolver(letras: String, rnd: Random = Random.Default): String {
        if (letras.toSet().size < 2) return letras
        var r: String
        do r = letras.toList().shuffled(rnd).joinToString("") while (r == letras)
        return r
    }

    /**
     * Cuándo encuentra Alma cada palabra (segundos desde el inicio, en el orden en que las encuentra: las cortas
     * primero). De principiante tarda ~20 s por palabra; de experta ~7 s, y en 90 s casi las encuentra todas.
     */
    fun tiemposDeAlma(palabras: List<String>, skill: Double, rnd: Random = Random.Default): List<Pair<String, Double>> {
        val media = 20.0 - 13.0 * skill
        var t = 4.0
        return palabras.sortedBy { it.length + rnd.nextDouble() * 2 }.map { w ->
            t += media * (0.5 + rnd.nextDouble()) * (0.7 + 0.1 * w.length)
            w to t
        }
    }

    /** Gana quien encontró más palabras; con las mismas, empate. */
    fun ganador(dueño: Int, alma: Int) = Preguntas.ganador(dueño, alma)

    /* Desde 2026-11-03 el dueño juega solo contra el tiempo ("no quiero jugar contra alma como tal"): gana si encuentra
       todas; si le falta una, gana Alma. Al menos SEGUNDOS, y 12 s por palabra en las rondas grandes */
    const val SEGUNDOS_POR_PALABRA = 12
    fun segundos(palabras: Int) = maxOf(SEGUNDOS, palabras * SEGUNDOS_POR_PALABRA)
    fun ganadorSolo(encontradas: Int, total: Int) = if (total > 0 && encontradas >= total) "owner" else "alma"
}

// ---------- Ping pong: la paleta de Alma ----------
object PingPong {
    const val PUNTOS = 5

    /** Velocidad de la pelota (fracción de la cancha por segundo) según el nivel. */
    fun velocidad(skill: Double, golpes: Int) = (0.55 + 0.35 * skill + 0.03 * golpes).coerceAtMost(1.6)

    /**
     * La paleta de Alma (x de 0 a 1) sigue a la pelota con su velocidad máxima y un error que baja con el nivel.
     * `error`: desvío fijo de esta jugada (lo elige `errorNuevo` cuando la pelota va hacia ella).
     */
    fun moverAlma(paleta: Double, pelotaX: Double, dt: Double, skill: Double, error: Double): Double {
        val objetivo = (pelotaX + error).coerceIn(0.0, 1.0)
        val vMax = 0.45 + 0.9 * skill
        val d = objetivo - paleta
        val paso = vMax * dt
        return if (abs(d) <= paso) objetivo else paleta + paso * if (d > 0) 1 else -1
    }

    fun errorNuevo(skill: Double, ancho: Double, rnd: Random = Random.Default) =
        (rnd.nextDouble() * 2 - 1) * ancho * (1.1 - skill)
}

// ---------- Preguntas: marcador contra Alma ----------
object Preguntas {
    const val POR_PARTIDA = 10
    const val SEGUNDOS = 20

    /** El que acierta más gana; con igual número de aciertos, empate. */
    fun ganador(dueño: Int, alma: Int) = when {
        dueño > alma -> "owner"
        alma > dueño -> "alma"
        else -> "draw"
    }
}
