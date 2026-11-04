package mx.alma.reloj

import android.content.Context
import android.util.Base64
import mx.alma.protocolo.Directiva
import mx.alma.protocolo.Evento
import mx.alma.protocolo.Hello
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Servidor y llave del reloj (la llave llega de la APK del celular o del código de vinculación). */
class Config(ctx: Context) {
    private val p = ctx.getSharedPreferences("alma", Context.MODE_PRIVATE)
    var servidor: String
        get() = p.getString("servidor", null) ?: BuildConfig.SERVIDOR
        set(v) = p.edit().putString("servidor", v.trimEnd('/')).apply()
    var llave: String?
        get() = p.getString("llave", null)
        set(v) = p.edit().putString("llave", v).apply()
    val vinculado get() = !llave.isNullOrEmpty()
}

class SinRed(msg: String, val codigo: Int = 0) : IOException(msg)

/** Peticiones HTTP sueltas al servidor (PLAN-RELOJ-v2.md, 4): sin WebSocket. */
class Red(private val cfg: Config) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()
    private val json = "application/json".toMediaType()

    private fun llamar(metodo: String, ruta: String, cuerpo: JSONObject? = null, conLlave: Boolean = true): JSONObject {
        val b = Request.Builder().url(cfg.servidor + ruta)
        if (conLlave) b.header("Authorization", "Bearer " + (cfg.llave ?: throw SinRed("sin vincular")))
        if (metodo == "POST") b.post((cuerpo ?: JSONObject()).toString().toRequestBody(json)) else b.get()
        http.newCall(b.build()).execute().use { r ->
            val txt = r.body?.string().orEmpty()
            if (r.code == 401) throw SinRed("llave rechazada")
            if (!r.isSuccessful) throw SinRed("servidor ${r.code}: ${txt.take(120)}", r.code)
            return if (txt.isBlank()) JSONObject() else JSONObject(txt)
        }
    }

    fun vincular(codigo: String): String {
        val r = llamar("POST", "/v1/vincular", JSONObject().put("code", codigo).put("solo", "reloj"), conLlave = false)
        return r.getString("reloj")
    }

    class Respuesta(val directiva: Directiva, val donde: JSONObject, val robot: JSONObject?, val horaServidor: Double)

    fun hello(h: Hello, candados: Map<String, Boolean> = emptyMap(), salud: JSONObject? = null): Respuesta {
        val b = JSONObject()
            .put("n", h.n)
            .put("events", JSONArray(h.eventos.map { eventoJson(it) }))
            .put("acked", JSONArray(h.acuses))
            .put("locks", JSONObject(candados as Map<*, *>))
        if (salud != null) b.put("salud", salud)
        val r = llamar("POST", "/v1/reloj/hello", b)
        return Respuesta(directiva(r.getJSONObject("directive")), r.getJSONObject("where"),
            r.optJSONObject("robot"), r.optDouble("server_time", 0.0))
    }

    fun respaldo(n: Int, seq: Int, pkg: ByteArray, meta: List<Evento>): Boolean =
        llamar("POST", "/v1/reloj/backup", JSONObject().put("n", n).put("seq", seq).put("pkg", b64(pkg))
            .put("meta", JSONArray(meta.map { eventoJson(it) }))).optBoolean("ok")

    fun soltar(mid: String, pkg: ByteArray, meta: List<Evento>): Boolean =
        llamar("POST", "/v1/reloj/release", JSONObject().put("mid", mid).put("pkg", b64(pkg))
            .put("meta", JSONArray(meta.map { eventoJson(it) }))).optBoolean("ok")

    fun acuse(mid: String, ok: Boolean, por: String): Boolean =
        llamar("POST", "/v1/reloj/ack", JSONObject().put("mid", mid).put("ok", ok).put("why", por)).optBoolean("ok")

    fun mudanza(mid: String, a: String, razon: String): JSONObject =
        llamar("POST", "/v1/mudanza", JSONObject().put("mid", mid).put("to", a).put("reason", razon))

    /** Lo que el dueño hace en el reloj con Alma en el robot (8.4): el robot reacciona. */
    fun eventoRemoto(e: Evento): JSONObject =
        llamar("POST", "/v1/reloj/evento", JSONObject().put("id", e.id).put("kind", e.tipo).put("data", JSONObject(e.datos as Map<*, *>)))

    fun comer(comida: String, estado: String, animo: String): JSONObject =
        llamar("POST", "/v1/reloj/comer", JSONObject().put("food", comida).put("state", estado).put("mood", animo))

    fun voz(texto: String): JSONObject = llamar("POST", "/v1/reloj/voz", JSONObject().put("texto", texto))

    fun comidas(): JSONArray = llamar("GET", "/v1/reloj/comidas").getJSONArray("foods")

    fun ordenes(): JSONObject = llamar("GET", "/v1/reloj/ordenes")

    // ---- juegos del reloj (relay/alma_relay/juegos_reloj.py) ----
    fun juegoEmpezar(id: String): JSONObject = llamar("POST", "/v1/juegos/$id/empezar")
    fun juegoEvento(id: String, b: JSONObject): JSONObject = llamar("POST", "/v1/juegos/$id/evento", b)
    fun preguntas(n: Int): JSONObject = llamar("GET", "/v1/juegos/preguntas?n=$n")
    fun respuesta(id: String, acerto: Boolean): JSONObject =
        llamar("POST", "/v1/juegos/preguntas/respuesta", JSONObject().put("id", id).put("acerto", acerto))

    companion object {
        fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)

        fun eventoJson(e: Evento): JSONObject = JSONObject().put("id", e.id).put("kind", e.tipo)
            .put("data", JSONObject(e.datos as Map<*, *>)).put("at", e.en).apply { e.recuerdoDe?.let { put("recuerdo_de", it) } }

        fun evento(o: JSONObject): Evento {
            val d = o.optJSONObject("data")
            val datos = mutableMapOf<String, String>()
            d?.keys()?.forEach { k -> datos[k] = d.optString(k) }
            return Evento(o.getString("id"), o.optString("kind", "recuerdo"), datos, o.optDouble("at", 0.0),
                o.optString("recuerdo_de").ifEmpty { null })
        }

        /** El robot puede mandar solo ids en su meta: también se aceptan. */
        private fun eventos(a: JSONArray?): List<Evento> =
            if (a == null) emptyList() else (0 until a.length()).map { i ->
                a.optJSONObject(i)?.let { evento(it) } ?: Evento(a.optString(i), "recuerdo")
            }

        fun directiva(d: JSONObject): Directiva = when (d.getString("t")) {
            "keep" -> Directiva.Seguir(d.getInt("n"), d.getDouble("lease_s"), eventos(d.optJSONArray("events")))
            "release" -> Directiva.Soltar(d.getString("mid"), d.getInt("n"))
            "deliver" -> Directiva.Recibir(
                d.getString("mid"), d.getInt("n"), Base64.decode(d.getString("pkg"), Base64.DEFAULT),
                eventos(d.optJSONArray("meta")), d.getDouble("at"), d.getDouble("now"), d.optString("reason"),
                d.optInt("seq", 0))
            else -> Directiva.NoEsta(d.optInt("n", 0))
        }
    }
}
