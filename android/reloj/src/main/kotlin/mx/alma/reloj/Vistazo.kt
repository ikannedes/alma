package mx.alma.reloj

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import android.content.Context
import android.graphics.drawable.Icon
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.data.SmallImage
import androidx.wear.watchface.complications.data.SmallImageComplicationData
import androidx.wear.watchface.complications.data.SmallImageType
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/** Lo último que se supo de Alma, para el vistazo y la complicación (se guarda en cada refresco de Vida). */
object Instantanea {
    private fun p(ctx: Context) = ctx.getSharedPreferences("instantanea", Context.MODE_PRIVATE)

    fun guardar(ctx: Context, v: Vista) {
        p(ctx).edit().putString("donde", v.donde).putBoolean("aqui", v.aqui).putString("animo", v.animo)
            .putString("estado", v.estado).putString("conducta", v.conducta).putFloat("hambre", v.hambre.toFloat()).apply()
    }

    fun leer(ctx: Context): Vista = p(ctx).let {
        Vista(donde = it.getString("donde", "?")!!, aqui = it.getBoolean("aqui", false), animo = it.getString("animo", "SM_CALM")!!,
            estado = it.getString("estado", "ST_AWAKE")!!, conducta = it.getString("conducta", "")!!,
            hambre = it.getFloat("hambre", 0f).toDouble())
    }

    val ANIMOS = listOf("SM_SCARED", "SM_SLEEPY", "SM_GRUMPY", "SM_BORED", "SM_PLAYFUL", "SM_HAPPY", "SM_CALM")

    /**
     * Número para la carátula WFF (10; android/tools/caratula_xml.py): dónde × 10 + expresión.
     * Dónde: 0 robot, 1 reloj, 2 mudándose. Expresión: 0 asustada, 1 con sueño, 2 enojada, 3 triste (aburrida),
     * 4 feliz (juguetona), 5 feliz, 6 neutral, 7 parpadeo (dormida), 8 enamorada (disfrutando caricias).
     */
    fun codigo(v: Vista): Int {
        val d = when { v.aqui -> 1; v.donde == "transito" -> 2; else -> 0 }
        val a = when {
            v.estado == "ST_SLEEPING" -> 7
            v.conducta == "bhv_enjoy_pet" -> 8
            else -> ANIMOS.indexOf(v.animo).takeIf { it >= 0 } ?: 6
        }
        return d * 10 + a
    }

    fun emoji(v: Vista) = when {
        v.estado == "ST_SLEEPING" -> "😴"
        v.animo == "SM_HAPPY" -> "😊"; v.animo == "SM_PLAYFUL" -> "😜"; v.animo == "SM_GRUMPY" -> "😠"
        v.animo == "SM_SCARED" -> "😨"; v.animo == "SM_BORED" -> "😑"; v.animo == "SM_SLEEPY" -> "🥱"
        else -> "🙂"
    }

    fun animoTexto(v: Vista) = when (v.animo) {
        "SM_HAPPY" -> "feliz"; "SM_PLAYFUL" -> "juguetona"; "SM_GRUMPY" -> "enojada"; "SM_SCARED" -> "asustada"
        "SM_BORED" -> "aburrida"; "SM_SLEEPY" -> "con sueño"; else -> "tranquila"
    }
}

/** Vistazo (Tile): su carita, dónde está, hambre y ánimo; un toque abre la app. */
class Vistazo : TileService() {
    override fun onTileRequest(req: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
        val v = Instantanea.leer(this)
        val donde = when { v.aqui -> "⌚ contigo"; v.donde == "transito" -> "mudándose…"; else -> "🤖 en el robot" }
        fun texto(t: String, tam: Float, color: Int) = LayoutElementBuilders.Text.Builder().setText(t)
            .setFontStyle(LayoutElementBuilders.FontStyle.Builder().setSize(androidx.wear.protolayout.DimensionBuilders.sp(tam))
                .setColor(argb(color)).build()).build()
        val abrir = ModifiersBuilders.Clickable.Builder().setId("abrir").setOnClick(
            ActionBuilders.LaunchAction.Builder().setAndroidActivity(
                ActionBuilders.AndroidActivity.Builder().setPackageName(packageName).setClassName(Principal::class.java.name).build()
            ).build()).build()
        val col = LayoutElementBuilders.Column.Builder()
            .setModifiers(ModifiersBuilders.Modifiers.Builder().setClickable(abrir).build())
            .addContent(texto(Instantanea.emoji(v), 30f, 0xFF02FBFF.toInt()))
            .addContent(texto("Alma $donde", 15f, 0xFFFFFFFF.toInt()))
            .addContent(LayoutElementBuilders.Spacer.Builder().setHeight(dp(4f)).build())
            .addContent(texto(Instantanea.animoTexto(v) + if (v.aqui) " · hambre ${(v.hambre * 100).toInt()}%" else "", 12f, 0xFFB0E0E6.toInt()))
            .build()
        val tile = TileBuilders.Tile.Builder().setResourcesVersion("1").setFreshnessIntervalMillis(15 * 60 * 1000L)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(col)).build()
        return Futures.immediateFuture(tile)
    }

    @Deprecated("API de tiles")
    override fun onTileResourcesRequest(req: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
        Futures.immediateFuture(ResourceBuilders.Resources.Builder().setVersion("1").build())
}

/** Complicación: su carita en cualquier carátula; RANGED_VALUE lleva el código para la carátula WFF (10). */
class Carita : SuspendingComplicationDataSourceService() {
    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        datos(type, Vista(donde = "reloj", aqui = true, animo = "SM_HAPPY"))

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? =
        datos(request.complicationType, Instantanea.leer(this))

    private fun datos(type: ComplicationType, v: Vista): ComplicationData? {
        val desc = PlainComplicationText.Builder("Alma " + Instantanea.animoTexto(v)).build()
        val icono = MonochromaticImage.Builder(Icon.createWithResource(this, R.drawable.ic_alma)).build()
        // un toque en su carita (o en sus ojos de la carátula) abre la app (10)
        val abrir = PendingIntent.getActivity(this, 0, Intent(this, Principal::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE)
        return when (type) {
            ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(
                PlainComplicationText.Builder(Instantanea.emoji(v)).build(), desc)
                .setTitle(PlainComplicationText.Builder(if (v.aqui) "⌚" else "🤖").build())
                .setMonochromaticImage(icono).setTapAction(abrir).build()
            ComplicationType.RANGED_VALUE -> RangedValueComplicationData.Builder(
                Instantanea.codigo(v).toFloat(), 0f, 29f, desc)
                .setText(PlainComplicationText.Builder(Instantanea.emoji(v)).build())
                .setMonochromaticImage(icono).setTapAction(abrir).build()
            ComplicationType.SMALL_IMAGE -> SmallImageComplicationData.Builder(
                SmallImage.Builder(Icon.createWithResource(this, R.drawable.ic_alma), SmallImageType.ICON).build(), desc).setTapAction(abrir).build()
            else -> null
        }
    }

    companion object {
        fun actualizar(ctx: Context) {
            runCatching { ComplicationDataSourceUpdateRequester.create(ctx, ComponentName(ctx, Carita::class.java)).requestUpdateAll() }
            // en Wear OS 5+ con targetSdk 35 la librería de tiles puede negarse; el vistazo igual se refresca cada 15 min
            runCatching { TileService.getUpdater(ctx).requestUpdate(Vistazo::class.java) }
        }
    }
}
