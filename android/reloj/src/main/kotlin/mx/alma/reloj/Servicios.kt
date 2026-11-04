package mx.alma.reloj

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.runBlocking
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/** La "voz" de Alma en la muñeca: un patrón por cosa (8.3). Amplitudes 1–255 donde el reloj lo permita. */
object Vibrar {
    private fun vib(ctx: Context): Vibrator =
        (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator

    private fun forma(ctx: Context, tiempos: LongArray, fuerza: IntArray) {
        val v = vib(ctx)
        if (!v.hasVibrator()) return
        val e = if (v.hasAmplitudeControl()) VibrationEffect.createWaveform(tiempos, fuerza, -1)
        else VibrationEffect.createWaveform(tiempos, -1)
        v.vibrate(e)
    }

    fun ronroneo(ctx: Context) = forma(ctx, longArrayOf(0, 60, 40, 60, 40, 60, 40, 60), intArrayOf(0, 40, 0, 50, 0, 45, 0, 35))
    fun aterrizaje(ctx: Context) = forma(ctx, longArrayOf(0, 30, 80, 140), intArrayOf(0, 120, 0, 255))
    fun despedida(ctx: Context) = forma(ctx, longArrayOf(0, 120, 60, 60, 60, 30), intArrayOf(0, 200, 0, 120, 0, 60))
    fun suave(ctx: Context) = forma(ctx, longArrayOf(0, 200), intArrayOf(0, 40))
    fun hambre(ctx: Context) = forma(ctx, longArrayOf(0, 80, 120, 80, 120, 80), intArrayOf(0, 160, 0, 160, 0, 160))
    fun hito(ctx: Context) = forma(ctx, longArrayOf(0, 50, 50, 50, 50, 200), intArrayOf(0, 180, 0, 220, 0, 255))
    fun respira(ctx: Context) = forma(ctx, longArrayOf(0, 1500, 300, 1500), intArrayOf(0, 25, 0, 15))
    fun risita(ctx: Context) = forma(ctx, longArrayOf(0, 25, 35, 25, 35, 25), intArrayOf(0, 110, 0, 90, 0, 70))
    fun mareo(ctx: Context) = forma(ctx, longArrayOf(0, 90, 50, 140, 40, 70, 60, 120), intArrayOf(0, 255, 0, 200, 0, 230, 0, 150))
    fun soplo(ctx: Context) = forma(ctx, longArrayOf(0, 400), intArrayOf(0, 30))

    val PATRONES = mapOf("hambre" to longArrayOf(0, 80, 120, 80, 120, 80), "hito" to longArrayOf(0, 50, 50, 50, 50, 200),
        "aburrida" to longArrayOf(0, 300, 200, 100))
}

/** Presupuesto de avisos (8.5): un tope diario que Alma administra; los hitos tienen prioridad. */
object Avisos {
    private const val CANAL = "alma"
    const val TOPE_DIARIO = 6

    fun revisar(ctx: Context, v: Vista) {
        if (!v.aqui) return
        when {
            v.hambre > 0.75 -> mandar(ctx, "hambre", "Alma tiene hambre 🍽️", "Dale algo de comer.", 3 * 3600)
            v.animo == "SM_BORED" -> mandar(ctx, "aburrida", "Alma está aburrida", "¿Juegan un rato?", 4 * 3600)
        }
    }

    fun mandar(ctx: Context, tipo: String, titulo: String, texto: String, cadaS: Int, prioridad: Boolean = false) {
        val p = ctx.getSharedPreferences("avisos", Context.MODE_PRIVATE)
        val hoy = LocalDate.now().toString()
        val cuantos = if (p.getString("dia", "") == hoy) p.getInt("n", 0) else 0
        val ahora = System.currentTimeMillis() / 1000
        if (ahora - p.getLong("ult_$tipo", 0) < cadaS) return
        if (!prioridad && cuantos >= TOPE_DIARIO) return
        p.edit().putString("dia", hoy).putInt("n", cuantos + 1).putLong("ult_$tipo", ahora).apply()
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val canal = "$CANAL-$tipo"
        if (nm.getNotificationChannel(canal) == null) {
            nm.createNotificationChannel(NotificationChannel(canal, "Alma: $tipo", NotificationManager.IMPORTANCE_DEFAULT).apply {
                enableVibration(true)
                vibrationPattern = Vibrar.PATRONES[tipo] ?: longArrayOf(0, 100)
            })
        }
        val abrir = PendingIntent.getActivity(ctx, 0, Intent(ctx, Principal::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, canal).setSmallIcon(R.drawable.ic_alma).setContentTitle(titulo)
            .setContentText(texto).setContentIntent(abrir).setAutoCancel(true).build()
        runCatching { nm.notify(tipo.hashCode(), n) }
    }
}

/** Cada 15 min (el mínimo de Wear OS) y cuando la APK avisa: ponerse al día y hablar con el servidor. */
class Sincronizar(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        Vida.de(applicationContext).tarea()
        Carita.actualizar(applicationContext)
        return Result.success()
    }

    companion object {
        private val red = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun programar(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("alma-sync", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<Sincronizar>(15, TimeUnit.MINUTES).build())
        }

        fun ya(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniqueWork("alma-sync-ya", ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<Sincronizar>().setConstraints(red).build())
        }
    }
}

/** Data Layer: la APK del celular manda la llave (/alma/llave) y avisa de novedades (/alma/despierta, /alma/ping). */
class Escucha : WearableListenerService() {
    override fun onDataChanged(eventos: DataEventBuffer) {
        for (e in eventos) {
            if (e.type != DataEvent.TYPE_CHANGED || e.dataItem.uri.path != "/alma/llave") continue
            val m = DataMapItem.fromDataItem(e.dataItem).dataMap
            val llave = m.getString("llave") ?: continue
            Vida.de(this).ponerLlave(m.getString("servidor"), llave)
            Sincronizar.programar(this)
        }
    }

    override fun onMessageReceived(m: MessageEvent) {
        when (m.path) {
            "/alma/despierta" -> Sincronizar.ya(this)
            "/alma/ping" -> {
                // el rescate (6.4b) pregunta primero si el reloj contesta
                runBlocking { Vida.de(this@Escucha).sincronizar() }
                Wearable.getMessageClient(this).sendMessage(m.sourceNodeId, "/alma/pong", ByteArray(0))
            }
        }
    }
}
