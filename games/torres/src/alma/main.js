// Página exterior de "Batalla de torres": carga el puente de Alma (barra superior,
// burbuja, avisos), escala el tablero (iframe arena.html, 720×1280) para que quepa en el
// móvil y muestra la portada de inicio y de revancha. La lógica del juego y del lado
// norte vive dentro del iframe (src/alma/arena.js) y usa window.almaTorres.

// El puente se sirve aparte en /play/_alma/alma.js; no se empaqueta.
const URL_PUENTE = "/play/_alma/alma.js";
const ALTO_BARRA = 44;
const ANCHO_TABLERO = 720;
const ALTO_TABLERO = 1_280;

const marco = document.querySelector("[data-marco]");
const portada = document.querySelector("[data-portada]");
const titulo = portada.querySelector("[data-titulo]");
const texto = portada.querySelector("[data-texto]");
const boton = portada.querySelector("[data-boton]");
const estadoTexto = portada.querySelector("[data-estado]");

function esc(valor) {
  return String(valor).replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function mostrarPortada({ tituloTexto, html = null, textoBoton, accion, habilitado = true }) {
  titulo.textContent = tituloTexto;
  if (html !== null) texto.innerHTML = html;
  boton.textContent = textoBoton;
  boton.disabled = !habilitado;
  boton.onclick = accion;
  portada.hidden = false;
}

let alma = null;
try {
  const modulo = await import(/* @vite-ignore */ URL_PUENTE);
  alma = modulo.createAlma("torres", { realtime: true });
} catch (error) {
  console.error(error);
}

// --- Escala del tablero: múltiplos de 1/64 como la aplicación original (pintado nítido) ---
let escala = 1;
let iframe = null;

function presentacion() {
  return { bodyCssPixels: window.innerWidth <= 600 ? 13 : 26, frameScale: escala };
}

function encajar() {
  const ancho = window.innerWidth;
  const alto = Math.max(1, window.innerHeight - ALTO_BARRA);
  const ajuste = Math.min(ancho / ANCHO_TABLERO, alto / ALTO_TABLERO);
  let unidades = Math.max(1, Math.floor(ajuste * 64));
  while (unidades > 1) {
    const reciproco = Math.fround(64 / unidades);
    if (Math.abs(reciproco * unidades - 64) / 64 <= 2 ** -25) break;
    unidades -= 1;
  }
  escala = unidades / 64;
  if (!iframe) return;
  iframe.style.left = `${Math.max(0, Math.round((ancho - ANCHO_TABLERO * escala) / 2))}px`;
  iframe.style.top = `${Math.max(0, Math.round((alto - ALTO_TABLERO * escala) / 2))}px`;
  iframe.style.transform = `scale(${escala})`;
  try { iframe.contentWindow?.torres?.presentacionCambiada(); } catch (error) { console.warn(error); }
}

async function empezar() {
  boton.disabled = true;
  estadoTexto.textContent = "Avisando a Alma…";
  try {
    const r = await alma.start(true);
    if (!r?.ok) {
      estadoTexto.textContent = r?.refused || "Alma no puede jugar ahora.";
      boton.disabled = false;
      return;
    }
    estadoTexto.textContent = "";
    portada.hidden = true;
    alma.status?.("Batalla de torres");
    iframe.contentWindow.torres.empezar();
    iframe.focus();
  } catch (error) {
    console.error(error);
    estadoTexto.textContent = "No se pudo hablar con Alma. Inténtalo otra vez.";
    boton.disabled = false;
  }
}

// Lo que el tablero (iframe, mismo origen) usa de esta página.
window.almaTorres = Object.freeze({
  alma,
  presentacion,
  // El tablero está montado y en pausa: ya se puede empezar.
  listo() {
    if (alma) mostrarPortada({ tituloTexto: "Batalla de torres", textoBoton: "Empezar", accion: empezar });
  },
  // Fin de la partida: tras ver el resultado en el tablero, se ofrece la revancha.
  fin({ frase, coronasAlma, coronasDueno }) {
    setTimeout(() => mostrarPortada({
      tituloTexto: frase,
      html: `<p>Coronas: Alma <strong>${esc(coronasAlma)}</strong> – tú <strong>${esc(coronasDueno)}</strong>.</p>`,
      textoBoton: "Revancha",
      accion: () => location.reload(), // partida nueva con otra semilla
    }), 2_500);
  },
  error(mensaje) {
    estadoTexto.textContent = mensaje;
    portada.hidden = false;
  },
});

if (!alma) {
  mostrarPortada({ tituloTexto: "Batalla de torres", textoBoton: "Empezar", accion: () => {}, habilitado: false });
  estadoTexto.textContent = "No se pudo conectar con Alma. Abre el juego desde Alma.";
} else {
  iframe = document.createElement("iframe");
  iframe.className = "torres-tablero";
  iframe.title = "Tablero de Batalla de torres";
  iframe.setAttribute("allow", "autoplay");
  iframe.src = "./arena.html";
  encajar();
  marco.appendChild(iframe);
  window.addEventListener("resize", encajar);
  window.visualViewport?.addEventListener("resize", encajar);
}
