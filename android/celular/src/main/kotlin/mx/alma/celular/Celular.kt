package mx.alma.celular

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Servidor y llave del celular (PLAN-RELOJ-v2.md, 15). */
class Config(ctx: Context) {
    private val p = ctx.getSharedPreferences("alma", Context.MODE_PRIVATE)
    var servidor: String
        get() = p.getString("servidor", null) ?: BuildConfig.SERVIDOR
        set(v) = p.edit().putString("servidor", v.trim().trimEnd('/')).apply()
    var llave: String?
        get() = p.getString("llave", null)
        set(v) = p.edit().putString("llave", v).apply()
    var ultimoDonde: String
        get() = p.getString("donde", "") ?: ""
        set(v) = p.edit().putString("donde", v).apply()
}

class Servidor(private val cfg: Config) {
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()

    private fun post(ruta: String, b: JSONObject, conLlave: Boolean = true): JSONObject {
        val r = Request.Builder().url(cfg.servidor + ruta).post(b.toString().toRequestBody("application/json".toMediaType()))
        if (conLlave) r.header("Authorization", "Bearer " + (cfg.llave ?: throw IOException("sin vincular")))
        http.newCall(r.build()).execute().use { res ->
            val t = res.body?.string().orEmpty()
            if (!res.isSuccessful) throw IOException(runCatching { JSONObject(t).optString("error") }.getOrNull() ?: "error ${res.code}")
            return JSONObject(t.ifBlank { "{}" })
        }
    }

    /** Devuelve las llaves del celular y del reloj. */
    fun vincular(codigo: String): JSONObject = post("/v1/vincular", JSONObject().put("code", codigo), conLlave = false)
    fun hello(): JSONObject = post("/v1/celular/hello", JSONObject())
    fun mudanza(a: String, razon: String): JSONObject =
        post("/v1/mudanza", JSONObject().put("mid", "c" + UUID.randomUUID().toString().take(10)).put("to", a).put("reason", razon))
}

/** Hablar con el reloj por la Data Layer. */
object Reloj {
    private var pong: CompletableDeferred<Unit>? = null

    suspend fun mandarLlave(ctx: Context, servidor: String, llave: String) {
        val req = PutDataMapRequest.create("/alma/llave").apply {
            dataMap.putString("servidor", servidor)
            dataMap.putString("llave", llave)
            dataMap.putLong("t", System.currentTimeMillis())
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(ctx).putDataItem(req).await()
    }

    private suspend fun mensaje(ctx: Context, ruta: String): Int {
        val nodos = Wearable.getNodeClient(ctx).connectedNodes.await()
        nodos.forEach { Wearable.getMessageClient(ctx).sendMessage(it.id, ruta, ByteArray(0)).await() }
        return nodos.size
    }

    /** Que el reloj pregunte ya al servidor (hay mudanza o novedad). */
    suspend fun despertar(ctx: Context) = runCatching { mensaje(ctx, "/alma/despierta") }

    /** ¿El reloj contesta? (rescate, 6.4b). null = no está conectado por Bluetooth. */
    suspend fun contesta(ctx: Context, segundos: Long = 12): Boolean? {
        val d = CompletableDeferred<Unit>()
        pong = d
        val n = runCatching { mensaje(ctx, "/alma/ping") }.getOrDefault(0)
        if (n == 0) return null
        return withTimeoutOrNull(segundos * 1000) { d.await(); true } ?: false
    }

    fun recibioPong() { pong?.complete(Unit) }
}

class Escucha : WearableListenerService() {
    override fun onMessageReceived(m: MessageEvent) {
        if (m.path == "/alma/pong") Reloj.recibioPong()
    }
}

/** Cada 15 min: ver dónde está Alma y, si hay mudanza que involucre al reloj, despertarlo (en lugar de FCM). */
class Revisar(ctx: Context, p: WorkerParameters) : CoroutineWorker(ctx, p) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val cfg = Config(applicationContext)
        if (cfg.llave == null) return@withContext Result.success()
        val r = runCatching { Servidor(cfg).hello() }.getOrNull() ?: return@withContext Result.retry()
        val w = r.getJSONObject("where")
        val donde = w.optString("cuerpo")
        val t = w.optJSONObject("transito")
        if (donde != cfg.ultimoDonde || (t != null && (t.optString("to") == "reloj" || t.optString("from") == "reloj"))) {
            Reloj.despertar(applicationContext)
        }
        cfg.ultimoDonde = donde
        Result.success()
    }

    companion object {
        fun programar(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("alma-revisar", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<Revisar>(15, TimeUnit.MINUTES)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
        }
    }
}
