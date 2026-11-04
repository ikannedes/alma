package mx.alma.protocolo

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class JuegosTest {
    @Test fun mosqueta_mas_dificil_con_el_nivel_y_las_rondas() {
        val r = Random(1)
        val facil = Mosqueta.ronda(0.0, 0, r)
        val dificil = Mosqueta.ronda(1.0, 4, r)
        assertEquals(3, facil.vasos)
        assertEquals(5, dificil.vasos)
        assertTrue(dificil.cambios.size > facil.cambios.size)
        assertTrue(dificil.msPorCambio < facil.msPorCambio)
        assertTrue(dificil.cambios.all { (a, b) -> a != b && a in 0 until 5 && b in 0 until 5 })
    }

    @Test fun mosqueta_sigue_a_la_pelota() {
        val r = Mosqueta.Ronda(3, 0, listOf(0 to 1, 1 to 2, 0 to 2), 300)
        assertEquals(0, Mosqueta.final(r))      // 0→1, 1→2 y el cambio 0↔2 la regresa a 0
        val r2 = Mosqueta.Ronda(3, 0, listOf(0 to 1, 1 to 2), 300)
        assertEquals(2, Mosqueta.final(r2))
    }

    @Test fun gato_experta_nunca_pierde() {
        val rnd = Random(7)
        repeat(200) {
            val t = CharArray(9) { ' ' }
            var turno = if (it % 2 == 0) 'X' else 'O'
            while (Gato.ganador(t) == null && !Gato.lleno(t)) {
                val i = if (turno == 'X') t.indices.filter { t[it] == ' ' }.random(rnd) else Gato.jugadaDeAlma(t, 1.0, rnd)
                t[i] = turno
                turno = if (turno == 'X') 'O' else 'X'
            }
            assertNotEquals('X', Gato.ganador(t))
        }
    }

    @Test fun gato_bloquea_y_gana() {
        val bloquear = "XX  O    ".toCharArray()
        assertEquals(2, Gato.mejor(bloquear))
        val ganar = "OO XX    ".toCharArray()
        assertEquals(2, Gato.mejor(ganar))
    }

    @Test fun palabras_cabe_con_letras_repetidas() {
        assertTrue(Palabras.cabe("CASA", "CASAR"))
        assertTrue(!Palabras.cabe("CASA", "CARTS"))                                       // solo hay una A
        assertTrue(!Palabras.cabe("SOL", "SOMA"))
        assertTrue(Palabras.cabe("AÑO", "MAÑOSO"))
    }

    @Test fun palabras_rueda_mas_grande_y_alma_mas_rapida_con_el_nivel() {
        val rondas = listOf(5, 6, 7).flatMap { n -> List(5) { Palabras.Ronda("ABCDEFG".take(n), listOf("ABC", "BCA", "CAB")) } }
        val r = Random(3)
        val facil = List(300) { Palabras.elegir(rondas, 0.0, r).letras.length }.average()
        val dificil = List(300) { Palabras.elegir(rondas, 1.0, r).letras.length }.average()
        assertTrue(facil < 5.6 && dificil > 6.5)
        val ronda = Palabras.elegir(rondas, 0.5, r)
        assertNotEquals("ABCDEFG".take(ronda.letras.length), ronda.letras)               // revueltas
        val w = List(8) { "PALABRA$it" }
        val lenta = Palabras.tiemposDeAlma(w, 0.0, Random(1)).count { it.second <= Palabras.SEGUNDOS }
        val rapida = Palabras.tiemposDeAlma(w, 1.0, Random(1)).count { it.second <= Palabras.SEGUNDOS }
        assertTrue(rapida > lenta)
        assertEquals("draw", Palabras.ganador(3, 3))
        assertEquals("owner", Palabras.ganadorSolo(9, 9))   // solo contra el tiempo: todas o gana Alma
        assertEquals("alma", Palabras.ganadorSolo(8, 9))
        assertEquals(90, Palabras.segundos(5))
        assertEquals(144, Palabras.segundos(12))
    }

    @Test fun palabras_las_rondas_del_reloj_son_validas() {
        val texto = java.io.File("../reloj/src/main/assets/palabras.json").readText()
        val rondas = Regex(""""letras"\s*:\s*"([A-ZÑ]+)"\s*,\s*"palabras"\s*:\s*\[([^\]]*)\]""").findAll(texto).map { m ->
            Palabras.Ronda(m.groupValues[1], Regex("\"([^\"]+)\"").findAll(m.groupValues[2]).map { it.groupValues[1] }.toList())
        }.toList()
        assertTrue(rondas.size >= 80)
        assertEquals(rondas.size, rondas.map { it.letras }.toSet().size)               // sin bases repetidas
        for (r in rondas) {
            assertTrue(r.letras.length in 5..7, r.letras)
            assertTrue(r.letras in r.palabras && r.palabras.size >= 4, r.letras)
            assertEquals(r.palabras.size, r.palabras.toSet().size, r.letras)
            for (w in r.palabras) assertTrue(w.length >= 3 && w.all { it in 'A'..'Z' || it == 'Ñ' } && Palabras.cabe(w, r.letras), "$w en ${r.letras}")
        }
    }

    @Test fun pingpong_alma_alcanza_mas_rapido_con_nivel() {
        val lenta = PingPong.moverAlma(0.0, 1.0, 0.1, 0.0, 0.0)
        val rapida = PingPong.moverAlma(0.0, 1.0, 0.1, 1.0, 0.0)
        assertTrue(rapida > lenta)
        assertEquals(0.5, PingPong.moverAlma(0.49, 0.5, 1.0, 0.5, 0.0), 1e-9)
    }

    @Test fun preguntas_ganador() {
        assertEquals("owner", Preguntas.ganador(6, 4))
        assertEquals("alma", Preguntas.ganador(3, 5))
        assertEquals("draw", Preguntas.ganador(5, 5))
    }
}
