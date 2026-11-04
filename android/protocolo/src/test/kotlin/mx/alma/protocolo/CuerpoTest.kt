package mx.alma.protocolo

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Doble del núcleo: el "paquete" es la lista de nombres de lo que vivió. */
class NucleoFalso : Nucleo {
    var copia: MutableList<String>? = mutableListOf("nace")
    var despierta = false
    var transcurrido = 0.0
    override fun hayCopia() = copia != null
    override fun exportar() = copia!!.joinToString(",").toByteArray()
    override fun importar(pkg: ByteArray, transcurridoS: Double): Boolean {
        val s = String(pkg)
        if (s.startsWith("ROTO")) return false
        copia = s.split(",").toMutableList(); transcurrido = transcurridoS; return true
    }
    override fun dormir() { despierta = false }
    override fun despertar() { despierta = true }
    override fun aplicar(e: Evento) { copia!!.add(e.id) }
    override fun descartar() { copia = null }
}

class CuerpoTest {
    private fun cuerpo(n: Int = 1): Pair<Cuerpo, NucleoFalso> {
        val nf = NucleoFalso()
        val c = Cuerpo("reloj", 3600.0, Local().also { it.n = n }, nf)
        return c to nf
    }

    @Test fun seguir_renueva_el_lease_desde_el_envio() {
        val (c, nf) = cuerpo()
        c.aplicar(Directiva.Seguir(1, 100.0, emptyList()), enviadoEn = 10.0, ahora = 50.0)
        assertTrue(c.corriendo(109.0)); assertFalse(c.corriendo(110.0)); assertTrue(nf.despierta)
        assertTrue(c.vivir(111.0).any { it is Accion.Aviso }); assertFalse(nf.despierta)
    }

    @Test fun regla1_respuesta_vieja_no_la_despierta_despues_de_soltar() {
        val (c, _) = cuerpo()
        c.aplicar(Directiva.Seguir(1, 100.0, emptyList()), 0.0, 1.0)
        val a = c.aplicar(Directiva.Soltar("m1", 2), enviadoEn = 20.0, ahora = 21.0)
        assertTrue(a.any { it is Accion.MandarSoltada })
        assertFalse(c.local.activo)
        c.aplicar(Directiva.Seguir(1, 100.0, emptyList()), enviadoEn = 15.0, ahora = 25.0)   // llegó tarde
        assertFalse(c.corriendo(26.0))
        val b = c.aplicar(Directiva.Soltar("m1", 2), 30.0, 31.0)                             // repetido: misma copia
        assertEquals(String((a[1] as Accion.MandarSoltada).pkg), String((b[1] as Accion.MandarSoltada).pkg))
    }

    @Test fun regla2_respaldos_numerados() {
        val (c, _) = cuerpo()
        val r1 = c.respaldo(); val r2 = c.respaldo()
        assertTrue(r2.seq > r1.seq)
        c.aplicar(Directiva.Recibir("m2", 3, "x".toByteArray(), emptyList(), 0.0, 0.0, "boton", seq = 40), 5.0, 6.0)
        assertEquals(41, c.respaldo().seq)
    }

    @Test fun regla3_recibir_recupera_lo_que_la_copia_vieja_vivio() {
        val (c, nf) = cuerpo()
        c.aplicar(Directiva.Seguir(1, 1000.0, emptyList()), 0.0, 1.0)
        c.evento(Evento("reloj-1", "comida"), 2.0)
        c.resultadoRespaldo(false, emptyList())                                          // ese respaldo se perdió
        val meta = listOf(Evento("robot-9", "truco"))
        val a = c.aplicar(Directiva.Recibir("m3", 4, "nace,robot-9".toByteArray(), meta, 100.0, 160.0, "cara", 0), 50.0, 51.0)
        assertTrue(a.contains(Accion.MandarAcuse("m3", true)))
        assertEquals(setOf("robot-9", "reloj-1"), c.local.mem.keys)
        assertEquals("reloj", c.local.mem["reloj-1"]!!.recuerdoDe)
        assertTrue("reloj-1" in nf.copia!!)
        assertEquals(60.0, nf.transcurrido)
        assertTrue(a.any { it is Accion.MandarRespaldo })
    }

    @Test fun regla4_acuses_solo_de_la_memoria_actual() {
        val (c, _) = cuerpo()
        c.aplicar(Directiva.Seguir(1, 1000.0, listOf(Evento("pwa-1", "comida"))), 0.0, 1.0)
        assertEquals(listOf("pwa-1"), c.hello(2.0).acuses)
        c.aplicar(Directiva.NoEsta(2), 3.0, 4.0)        // pwa-1 no estaba respaldado: queda pendiente
        assertEquals(listOf("pwa-1"), c.hello(5.0).eventos.map { it.id })
        c.aplicar(Directiva.NoEsta(2), 5.0, 6.0, llevabaEventos = true)
        assertEquals(emptyList(), c.hello(7.0).acuses)
        assertFalse(c.nucleo.hayCopia())
    }

    @Test fun no_esta_sin_pendientes_descarta_de_una() {
        val (c, _) = cuerpo()
        c.aplicar(Directiva.Seguir(1, 1000.0, emptyList()), 0.0, 1.0)
        c.aplicar(Directiva.NoEsta(5), 2.0, 3.0)
        assertFalse(c.nucleo.hayCopia())
    }

    @Test fun paquete_que_no_se_entiende_se_rechaza() {
        val (c, _) = cuerpo(0)
        val a = c.aplicar(Directiva.Recibir("m4", 2, "ROTO".toByteArray(), emptyList(), 0.0, 0.0, "boton", 0), 1.0, 2.0)
        assertEquals(Accion.MandarAcuse("m4", false, "no se pudo importar el paquete"), a.single())
        assertFalse(c.local.activo)
    }

    @Test fun recibir_repetido_solo_reconfirma() {
        val (c, _) = cuerpo(0)
        c.aplicar(Directiva.Recibir("m5", 2, "nace".toByteArray(), emptyList(), 0.0, 0.0, "boton", 0), 1.0, 2.0)
        val a = c.aplicar(Directiva.Recibir("m5", 2, "nace".toByteArray(), emptyList(), 0.0, 0.0, "boton", 0), 3.0, 4.0)
        assertEquals(listOf<Accion>(Accion.MandarAcuse("m5", true)), a)
    }

    @Test fun eventos_solo_mientras_vive_aqui() {
        val (c, _) = cuerpo()
        assertTrue(c.evento(Evento("x", "comida"), 1.0).isEmpty())
        c.aplicar(Directiva.Seguir(1, 1000.0, emptyList()), 0.0, 1.0)
        assertTrue(c.evento(Evento("y", "comida"), 2.0).any { it is Accion.MandarRespaldo })
    }
}

class OrdenesTest {
    @Test fun frases_completas() {
        assertEquals(Orden("command", "dance"), Ordenes.local("Alma, baila"))
        assertEquals(Orden("command", "dance"), Ordenes.local("EMO baila!"))
        assertEquals(Orden("command", "come"), Ordenes.local("oye Alma, ven acá por favor"))
        assertEquals(Orden("praise", null), Ordenes.local("¡Muy bien!"))
        assertEquals(Orden("scold", null), Ordenes.local("No"))
        assertEquals(Orden("command", "sleep"), Ordenes.local("Duérmete"))
    }

    @Test fun lo_demas_va_a_haiku() {
        assertEquals(null, Ordenes.local("baila y luego duérmete"))
        assertEquals(null, Ordenes.local("baila como si estuvieras triste"))
        assertEquals(null, Ordenes.local("EMO, siéntate"))
        assertEquals(null, Ordenes.local("Alma"))
        assertEquals(null, Ordenes.local(""))
    }
}
