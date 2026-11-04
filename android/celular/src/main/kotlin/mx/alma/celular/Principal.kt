package mx.alma.celular

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class Principal : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Revisar.programar(this)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFF02FBFF), background = Color.Black, surface = Color.Black)) {
                Surface(Modifier.fillMaxSize()) { Pantalla() }
            }
        }
    }
}

@Composable
private fun Pantalla() {
    val ctx = LocalContext.current
    val cfg = remember { Config(ctx) }
    val srv = remember { Servidor(cfg) }
    val scope = rememberCoroutineScope()
    var vinculado by remember { mutableStateOf(cfg.llave != null) }
    var estado by remember { mutableStateOf<JSONObject?>(null) }
    var msg by remember { mutableStateOf("") }
    var rescate by remember { mutableStateOf<String?>(null) }

    suspend fun refrescar() {
        estado = withContext(Dispatchers.IO) { runCatching { srv.hello() }.getOrNull() }
        if (estado == null && vinculado) msg = "Sin conexión con el servidor"
    }

    LaunchedEffect(vinculado) {
        while (vinculado) { refrescar(); delay(10_000) }
    }

    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Alma", fontSize = 28.sp, color = MaterialTheme.colorScheme.primary)
        if (!vinculado) {
            var servidor by remember { mutableStateOf(cfg.servidor) }
            var codigo by remember { mutableStateOf("") }
            Text("En la app web de Alma, en la tarjeta ⌚ Reloj, genera un código y escríbelo aquí. El celular le pasa su llave al reloj.")
            OutlinedTextField(servidor, { servidor = it }, label = { Text("Servidor") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(codigo, { codigo = it.filter(Char::isDigit).take(8) }, label = { Text("Código") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            Button(onClick = {
                scope.launch {
                    cfg.servidor = servidor
                    val r = withContext(Dispatchers.IO) { runCatching { srv.vincular(codigo) } }
                    r.onSuccess {
                        cfg.llave = it.getString("celular")
                        val ok = runCatching { Reloj.mandarLlave(ctx, cfg.servidor, it.getString("reloj")) }.isSuccess
                        msg = if (ok) "¡Vinculados! El reloj ya tiene su llave." else "El celular quedó vinculado; el reloj no respondió (¿está conectado?)."
                        vinculado = true
                    }.onFailure { msg = it.message ?: "No se pudo vincular" }
                }
            }, enabled = codigo.length == 8, modifier = Modifier.fillMaxWidth()) { Text("Vincular") }
        } else {
            val w = estado?.optJSONObject("where")
            val donde = w?.optString("cuerpo") ?: "?"
            val listo = w?.optBoolean("robot_listo") ?: false
            Text(when (donde) { "robot" -> "🤖 Alma está en el robot"; "reloj" -> "⌚ Alma está en tu reloj"; "transito" -> "Alma se está mudando…"; else -> "…" }, fontSize = 20.sp)
            if (!listo && estado != null) Text("El robot todavía no sabe mudarse (le falta su firmware nuevo).", color = Color(0xFFFFB060))
            if (listo && donde == "robot") Button(onClick = {
                scope.launch {
                    val r = withContext(Dispatchers.IO) { runCatching { srv.mudanza("reloj", "boton") }.getOrNull() }
                    msg = if (r?.optBoolean("ok") == true) "En cuanto el robot la suelte, llega a tu reloj." else r?.optString("why") ?: "Sin conexión"
                    Reloj.despertar(ctx); refrescar()
                }
            }, modifier = Modifier.fillMaxWidth()) { Text("⌚ Llévame contigo") }
            if (listo && donde == "reloj") {
                Button(onClick = {
                    scope.launch {
                        val r = withContext(Dispatchers.IO) { runCatching { srv.mudanza("robot", "manual") }.getOrNull() }
                        msg = if (r?.optBoolean("ok") == true) "Regresando al robot…" else r?.optString("why") ?: "Sin conexión"
                        Reloj.despertar(ctx); refrescar()
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text("🤖 Regresa al robot") }
                OutlinedButton(onClick = {
                    scope.launch {
                        msg = "Preguntando al reloj…"
                        val c = Reloj.contesta(ctx)
                        rescate = when (c) {
                            true -> null
                            false -> "El reloj está conectado pero no responde."
                            null -> "El reloj no está conectado al celular (apagado, sin batería o lejos)."
                        }
                        if (c == true) {
                            withContext(Dispatchers.IO) { runCatching { srv.mudanza("robot", "manual") } }
                            msg = "El reloj contestó: regresa al robot sin perder nada."
                        }
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text("🆘 Rescatar a Alma") }
            }
            OutlinedButton(onClick = { scope.launch { refrescar() } }, modifier = Modifier.fillMaxWidth()) { Text("Actualizar") }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = { cfg.llave = null; vinculado = false; estado = null }) { Text("Desvincular este celular") }
        }
        if (msg.isNotEmpty()) Text(msg, color = Color(0xFFB0E0E6))
    }

    rescate?.let { porque ->
        AlertDialog(
            onDismissRequest = { rescate = null },
            title = { Text("Rescatar a Alma") },
            text = { Text("$porque\n\nAlma regresa al robot con su última copia; se pierde lo que vivió en el reloj después. Si el reloj vuelve a conectarse, lo que vivió llega como recuerdo.") },
            confirmButton = {
                TextButton(onClick = {
                    rescate = null
                    scope.launch {
                        val r = withContext(Dispatchers.IO) { runCatching { srv.mudanza("robot", "rescate") }.getOrNull() }
                        msg = if (r?.optBoolean("ok") == true) "Alma regresa al robot." else r?.optString("why") ?: "Sin conexión"
                        refrescar()
                    }
                }) { Text("Rescatar") }
            },
            dismissButton = { TextButton(onClick = { rescate = null }) { Text("Esperar") } },
        )
    }
}
