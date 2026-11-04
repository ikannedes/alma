package mx.alma.reloj

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Sacudir el reloj (acción "Sacudirla"): picos de aceleración sin la gravedad. Solo mientras la acción espera, para
 * no tomar por sacudida un movimiento normal del brazo.
 */
class Sacudida(ctx: Context, private val alSacudir: () -> Unit) : SensorEventListener {
    private val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val picos = ArrayDeque<Long>()
    private var hecho = false

    fun empezar() {
        hecho = false
        picos.clear()
        val s = sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        sm.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME)
    }

    fun parar() = sm.unregisterListener(this)

    override fun onSensorChanged(e: SensorEvent) {
        if (hecho) return
        val (x, y, z) = Triple(e.values[0], e.values[1], e.values[2])
        var a = sqrt(x * x + y * y + z * z)
        if (e.sensor.type == Sensor.TYPE_ACCELEROMETER) a = kotlin.math.abs(a - SensorManager.GRAVITY_EARTH)
        val ahora = System.currentTimeMillis()
        if (a > PICO_MS2 && (picos.isEmpty() || ahora - picos.last() > 120)) picos.addLast(ahora)
        while (picos.isNotEmpty() && ahora - picos.first() > VENTANA_MS) picos.removeFirst()
        if (picos.size >= PICOS) { hecho = true; alSacudir() }
    }

    override fun onAccuracyChanged(s: Sensor?, a: Int) {}

    companion object {
        const val PICO_MS2 = 15f      // m/s² sin gravedad: un movimiento normal del brazo no pasa de ~8
        const val PICOS = 3           // tres sacudidas…
        const val VENTANA_MS = 1200L  // …en poco más de un segundo
    }
}

/**
 * Soplarle (acción "Soplarle"): el soplido es ruido fuerte y parejo; se distingue de la voz por los cruces por cero
 * (la voz tiene vocales, con pocos cruces). Requiere el permiso del micrófono, el mismo de la voz.
 */
class Soplido(private val alSoplar: () -> Unit) {
    @Volatile private var corriendo = false

    @SuppressLint("MissingPermission")   // quien llama revisa RECORD_AUDIO
    fun empezar() {
        corriendo = true
        thread(name = "alma-soplido") {
            val tam = maxOf(AudioRecord.getMinBufferSize(HZ, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), CUADRO * 2)
            val rec = runCatching {
                AudioRecord(MediaRecorder.AudioSource.MIC, HZ, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, tam)
            }.getOrNull() ?: return@thread
            if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return@thread }
            val b = ShortArray(CUADRO)
            var seguidos = 0
            rec.startRecording()
            try {
                while (corriendo) {
                    val n = rec.read(b, 0, CUADRO)
                    if (n <= 0) continue
                    if (esSoplido(b, n)) seguidos++ else seguidos = 0
                    if (seguidos >= CUADROS) { corriendo = false; alSoplar() }
                }
            } finally {
                rec.stop()
                rec.release()
            }
        }
    }

    fun parar() { corriendo = false }

    companion object {
        const val HZ = 16000
        const val CUADRO = 800          // 50 ms
        const val CUADROS = 5           // 250 ms seguidos
        const val NIVEL = 0.10          // RMS sobre 1: un soplido de cerca satura casi
        const val CRUCES = 0.12         // fracción de muestras con cambio de signo: la voz ~0.02–0.08

        fun esSoplido(b: ShortArray, n: Int): Boolean {
            var s = 0.0
            var cruces = 0
            for (i in 0 until n) {
                val x = b[i] / 32768.0
                s += x * x
                if (i > 0 && (b[i] >= 0) != (b[i - 1] >= 0)) cruces++
            }
            return sqrt(s / n) > NIVEL && cruces.toDouble() / n > CRUCES
        }
    }
}
