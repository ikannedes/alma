package mx.alma.protocolo

import java.text.Normalizer

/*
 * Tabla local de órdenes del reloj (PLAN-RELOJ-v2.md, 9): solo cuando TODA la frase es una orden conocida, con o
 * sin nombre ("baila", "Alma, ven", "EMO, muy bien"). Lo demás va a Haiku por el servidor. Es la misma tabla y la
 * misma normalización que relay/alma_relay/rules.py; el reloj la actualiza desde /v1/reloj/ordenes.
 */

data class Tabla(
    val acciones: Map<String, List<String>>,
    val elogios: List<String>,
    val regaños: List<String>,
    val relleno: List<String>,
)

data class Orden(val intent: String, val actionId: String?)

object Ordenes {
    val porOmision = Tabla(
        acciones = mapOf(
            "stop" to listOf("detente", "quieta", "quieto", "alto", "para", "basta", "stop"),
            "come" to listOf("ven", "ven aqui", "ven aca", "acercate", "ven conmigo"),
            "dance" to listOf("baila", "a bailar", "bailemos", "un baile"),
            "turn_around" to listOf("gira", "da una vuelta", "date la vuelta", "da la vuelta", "voltea"),
            "sleep" to listOf("duermete", "a dormir", "descansa", "a descansar", "hora de dormir"),
            "wake_up" to listOf("despierta", "despiertate", "arriba", "levantate"),
            "look_at_me" to listOf("mirame", "mira", "aqui estoy", "voltea a verme"),
            "play" to listOf("juega", "juguemos", "vamos a jugar", "juega conmigo", "a jugar"),
            "greet" to listOf("saluda", "di hola", "hola", "buenos dias", "buenas"),
            "go_home" to listOf("a casa", "ve a casa", "a tu casa", "a tu base", "a cargar", "ve a cargar"),
        ),
        elogios = listOf("muy bien", "bien hecho", "buena chica", "buena niña", "que linda", "te quiero", "bravo",
            "excelente", "perfecto"),
        regaños = listOf("no", "eso no", "no alma", "mal", "asi no", "no hagas eso", "que haces", "malcriada"),
        relleno = listOf("oye alma", "por favor", "alma", "emo", "oye", "ahora", "ya"),
    )

    /** Minúsculas, sin acentos ni signos, sin relleno al inicio o al final (igual que rules.normalize). */
    fun normalizar(texto: String, t: Tabla = porOmision): String {
        val sinAcentos = Normalizer.normalize(texto.lowercase(), Normalizer.Form.NFD)
            .filter { Character.getType(it) != Character.NON_SPACING_MARK.toInt() }
        var palabras = sinAcentos.replace(Regex("[^a-z0-9ñ ]+"), " ").split(" ").filter { it.isNotEmpty() }
        val rellenos = t.relleno.map { it.split(" ") }
        var cambio = true
        while (cambio && palabras.isNotEmpty()) {
            cambio = false
            for (f in rellenos) {
                if (palabras.size >= f.size && palabras.subList(0, f.size) == f) {
                    palabras = palabras.drop(f.size); cambio = true
                }
                if (palabras.size >= f.size && palabras.takeLast(f.size) == f) {
                    palabras = palabras.dropLast(f.size); cambio = true
                }
            }
        }
        return palabras.joinToString(" ")
    }

    /** La orden si toda la frase es una de la tabla; null si hay que preguntarle a Haiku. */
    fun local(texto: String, t: Tabla = porOmision): Orden? {
        val n = normalizar(texto, t)
        if (n.isEmpty()) return null
        for ((accion, frases) in t.acciones) if (n in frases.map { normalizar(it, t) }) return Orden("command", accion)
        if (n in t.elogios.map { normalizar(it, t) }) return Orden("praise", null)
        if (n in t.regaños.map { normalizar(it, t) } || n == "no") return Orden("scold", null)
        return null
    }
}
