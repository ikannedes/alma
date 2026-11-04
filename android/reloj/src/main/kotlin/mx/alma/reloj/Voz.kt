package mx.alma.reloj

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Reconocimiento de voz con el servicio del sistema, sin la interfaz de Google encima (9): la escucha se ve como
 * Alma escuchando, con resultados parciales. Si el servicio no está, `disponible` es falso.
 */
class Voz(private val ctx: Context, private val parcial: (String) -> Unit, private val final: (String?) -> Unit) {
    private var sr: SpeechRecognizer? = null

    val disponible get() = SpeechRecognizer.isRecognitionAvailable(ctx)

    fun escuchar() {
        detener()
        val r = SpeechRecognizer.createSpeechRecognizer(ctx)
        sr = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onPartialResults(b: Bundle?) {
                b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let(parcial)
            }
            override fun onResults(b: Bundle?) {
                final(b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
                detener()
            }
            override fun onError(error: Int) {
                final(null)
                detener()
            }
            override fun onReadyForSpeech(p: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(v: Float) {}
            override fun onBufferReceived(b: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(t: Int, p: Bundle?) {}
        })
        r.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-MX")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        })
    }

    fun detener() {
        sr?.destroy()
        sr = null
    }
}
