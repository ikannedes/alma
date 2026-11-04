package mx.alma.reloj

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.health.services.client.HealthServices
import androidx.health.services.client.PassiveListenerService
import androidx.health.services.client.data.DataPointContainer
import androidx.health.services.client.data.DataType
import androidx.health.services.client.data.PassiveListenerConfig
import org.json.JSONObject
import java.time.LocalDate

/*
 * Pasos y pulso del dueño en modo pasivo (PLAN-RELOJ-v2.md, 14): Health Services junta los datos con el sensor en
 * bajo consumo y los entrega por lotes. Solo se guardan resúmenes del día; al servidor van pasos y cuántas veces se
 * agitó el pulso estando quieto. Ningún consejo médico.
 */
object Salud {
    const val PULSO_ALTO = 105.0          // lpm estando quieto (sin pasos en los últimos minutos)
    private const val CADA_S = 30 * 60    // a lo más un "momento agitado" cada media hora

    fun permisos(): Array<String> = arrayOf(Manifest.permission.ACTIVITY_RECOGNITION, Manifest.permission.BODY_SENSORS)

    fun tienePermisos(ctx: Context) = permisos().all {
        ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
    }

    /** Se registra una vez; Health Services lo recuerda aunque la app se cierre. */
    fun registrar(ctx: Context) {
        if (!tienePermisos(ctx)) return
        val tipos = mutableSetOf<DataType<*, *>>(DataType.STEPS_DAILY, DataType.HEART_RATE_BPM)
        val cfg = PassiveListenerConfig.builder().setDataTypes(tipos).build()
        runCatching {
            HealthServices.getClient(ctx).passiveMonitoringClient.setPassiveListenerServiceAsync(Escuchar::class.java, cfg)
        }
    }

    private fun p(ctx: Context) = ctx.getSharedPreferences("salud", Context.MODE_PRIVATE)

    /** Lo que va en cada hello al servidor. */
    fun resumen(ctx: Context): JSONObject? {
        val s = p(ctx)
        val hoy = LocalDate.now().toString()
        if (s.getString("dia", "") != hoy) return null
        return JSONObject().put("dia", hoy).put("pasos", s.getLong("pasos", 0)).put("pulso_alto", s.getInt("agitado", 0))
    }

    internal fun guardarPasos(ctx: Context, pasos: Long) {
        val s = p(ctx)
        val hoy = LocalDate.now().toString()
        val e = s.edit()
        if (s.getString("dia", "") != hoy) e.putString("dia", hoy).putInt("agitado", 0)
        if (pasos != s.getLong("pasos", -1)) e.putLong("ult_paso", System.currentTimeMillis() / 1000)
        e.putLong("pasos", pasos).apply()
    }

    /** Pulso alto estando quieto: Alma lo nota (respira lento en la pantalla y vibra suave). */
    internal fun pulso(ctx: Context, lpm: Double) {
        if (lpm < PULSO_ALTO) return
        val s = p(ctx)
        val ahora = System.currentTimeMillis() / 1000
        if (ahora - s.getLong("ult_paso", 0) < 5 * 60) return            // caminando o recién caminó: es normal
        if (ahora - s.getLong("ult_agitado", 0) < CADA_S) return
        s.edit().putLong("ult_agitado", ahora).putInt("agitado", s.getInt("agitado", 0) + 1).apply()
        if (Instantanea.leer(ctx).aqui) {
            Vibrar.respira(ctx)
            Avisos.mandar(ctx, "respira", "Alma está a tu lado", "Respiren juntos un momento 🫧", CADA_S)
        }
    }

    class Escuchar : PassiveListenerService() {
        override fun onNewDataPointsReceived(dataPoints: DataPointContainer) {
            dataPoints.getData(DataType.STEPS_DAILY).lastOrNull()?.let { guardarPasos(this, it.value) }
            dataPoints.getData(DataType.HEART_RATE_BPM).maxOfOrNull { it.value }?.let { pulso(this, it) }
        }
    }
}
