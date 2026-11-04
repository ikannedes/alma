package mx.alma.nucleo

/** Funciones de alma_jni.c. Un "handle" es un puntero al cuerpo en C (0 = nada). */
object NucleoNativo {
    init {
        System.loadLibrary("alma_nucleo")
    }

    @JvmStatic external fun catalogo(catalogo: String, inventario: String): Int
    @JvmStatic external fun nacer(ruta: String, semilla: Int, ahora: Double): Long
    @JvmStatic external fun abrir(ruta: String, ahora: Double): Long
    @JvmStatic external fun importar(ruta: String, pkg: ByteArray, ahora: Double): Long
    @JvmStatic external fun cerrar(h: Long)
    @JvmStatic external fun correr(h: Long, ahora: Double)
    @JvmStatic external fun ponerseAlDia(h: Long, ahora: Double)
    @JvmStatic external fun evento(h: Long, tipo: Int, accion: Int, valor: Float)
    @JvmStatic external fun comer(h: Long, comida: String): Int
    @JvmStatic external fun cuidado(h: Long, hambre: Float, enferma: Int, energia: Float)
    @JvmStatic external fun exportar(h: Long): ByteArray?
    @JvmStatic external fun ahora(h: Long): Double
    @JvmStatic external fun estado(h: Long): String
    @JvmStatic external fun juego(h: Long, tipo: String): Int
}
