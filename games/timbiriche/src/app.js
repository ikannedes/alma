// Interfaz de Timbiriche: tablero (dibujo del repo original, adaptado), marcador y controles en español.
// Dueño contra Alma, nada más. La IA del repo original no se incluye: sin red, Alma no juega.
import { Owner } from "./game/board.js";
import { BoardTopology } from "./game/board-topology.js";
import { TAMANOS, TAMANO_POR_DEFECTO, describirLinea } from "./game/timbiriche.js";
import { crearPartida } from "./game/partida.js";


function crearTablero(model, alPulsar) {
  const element = document.createElement("div");
  element.className = "board-stage";
  const lado = model.size * 10 + 18;
  const pct = (v) => `${(v / lado) * 100}%`;

  function poner(tag, className, left, top, width, height) {
    const child = document.createElement(tag);
    child.className = className;
    Object.assign(child.style, { left: pct(left), top: pct(top), width: pct(width), height: pct(height) });
    element.append(child);
    return child;
  }

  const cajas = Array.from({ length: model.boxCount }, (_, box) =>
    poner("div", "box", model.boxX(box) * 10 + 10, model.boxY(box) * 10 + 10, 8, 8));
  const lineas = Array.from({ length: model.edgeCount }, (_, edge) => {
    const dot = model.edgeDot1[edge];
    const vertical = model.edgeRotated(edge);
    const b = poner("button", vertical ? "edge edge-v" : "edge edge-h",
      8 + model.dotX(dot) * 10 + (vertical ? 0 : 1),
      8 + model.dotY(dot) * 10 + (vertical ? 1 : 0),
      vertical ? 2 : 10, vertical ? 10 : 2);
    b.type = "button";
    b.setAttribute("aria-label", describirLinea(model, edge));
    b.addEventListener("click", () => alPulsar(edge));
    return b;
  });
  for (let dot = 0; dot < model.dotCount; dot += 1) {
    poner("div", "dot", 8 + model.dotX(dot) * 10, 8 + model.dotY(dot) * 10, 2, 2);
  }

  return {
    element,
    // juego puede ser null (vista previa vacía).
    pintar(juego, interactivo, pensando) {
      element.setAttribute("aria-busy", String(pensando));
      const clase = (owner) =>
        owner === Owner.None || !juego ? "owner-none" : juego.esDeAlma(owner) ? "de-alma" : "del-dueno";
      cajas.forEach((c, i) => { c.className = `box ${juego ? clase(juego.board.boxOwner(i)) : "owner-none"}`; });
      const ultima = juego ? juego.board.lastEdge() : -1;
      lineas.forEach((b, i) => {
        const base = b.classList.contains("edge-v") ? "edge edge-v" : "edge edge-h";
        const owner = juego ? juego.board.edgeOwner(i) : Owner.None;
        b.className = `${base} ${clase(owner)}${i === ultima ? " edge-last" : ""}`;
        const libre = !juego || !juego.board.contains(i);
        b.setAttribute("aria-disabled", String(!interactivo || !libre));
        b.disabled = !interactivo || !libre;
      });
    },
  };
}

export function createApp(root) {
  const main = document.createElement("main");
  main.className = "app-shell";
  main.innerHTML = `
    <header class="barra">
      <div class="marcador">
        <span class="chip del-dueno"><b>Tú</b> <span data-id="dueno">0</span></span>
        <span class="turno" data-id="turno">Elige y empieza</span>
        <span class="chip de-alma"><b>Alma</b> <span data-id="alma">0</span></span>
      </div>
      <div class="controles">
        <label>Tablero
          <select data-id="tamano">${TAMANOS.map((n) =>
            `<option value="${n}"${n === TAMANO_POR_DEFECTO ? " selected" : ""}>${n}×${n}</option>`).join("")}</select>
        </label>
        <label>Empieza
          <select data-id="empieza"><option value="dueno">Tú</option><option value="alma">Alma</option></select>
        </label>
        <button type="button" data-id="nueva">Nueva partida</button>
      </div>
    </header>
    <div class="zona" data-id="zona"></div>
    <p class="mensaje" data-id="mensaje" hidden></p>`;
  root.replaceChildren(main);
  const $ = (id) => main.querySelector(`[data-id="${id}"]`);

  let partida = null;
  let tablero = null;
  let tamanoTablero = 0;
  let dialogo = null;
  let resultadoMostrado = null;

  function montarTablero(size) {
    if (tablero && tamanoTablero === size) return;
    tablero = crearTablero(new BoardTopology(size), (edge) => partida && partida.jugarDueno(edge));
    tamanoTablero = size;
    $("zona").replaceChildren(tablero.element);
  }

  function mensaje(texto) {
    $("mensaje").textContent = texto || "";
    $("mensaje").hidden = !texto;
  }

  function dialogoFinal(juego) {
    const { alma, dueno } = juego.marcador();
    const r = juego.resultado();
    const texto = r === "pierde_alma" ? "¡Ganaste!" : r === "gana_alma" ? "Ganó Alma" : "Empate";
    dialogo = document.createElement("div");
    dialogo.className = "dialog-backdrop";
    dialogo.innerHTML = `
      <section class="result-dialog" role="dialog" aria-modal="true" aria-labelledby="resultado">
        <p id="resultado"><b>${texto}</b><br>Tú ${dueno} – Alma ${alma}</p>
        <div class="dialog-actions">
          <button type="button" data-a="otra">Otra partida</button>
          <button type="button" data-a="cerrar">Ver tablero</button>
        </div>
      </section>`;
    dialogo.querySelector('[data-a="otra"]').onclick = () => { cerrarDialogo(); empezar(); };
    dialogo.querySelector('[data-a="cerrar"]').onclick = cerrarDialogo;
    main.append(dialogo);
  }
  function cerrarDialogo() { dialogo?.remove(); dialogo = null; }

  function pintar() {
    const juego = partida && partida.juego;
    if (juego) montarTablero(juego.size);
    else montarTablero(Number($("tamano").value));
    const pensando = !!partida && partida.ocupado;
    tablero.pintar(juego, !!partida && partida.puedeJugarDueno, pensando);

    const { alma, dueno } = juego ? juego.marcador() : { alma: 0, dueno: 0 };
    $("alma").textContent = alma;
    $("dueno").textContent = dueno;
    let turno = "Elige y empieza";
    if (partida && partida.rechazada) turno = "Alma no puede jugar";
    else if (juego && juego.terminada) turno = "Fin de la partida";
    else if (partida && partida.enPausa) turno = "Esperando a Alma";
    else if (juego) turno = juego.turnoDeAlma ? "Turno de Alma…" : "Tu turno";
    $("turno").textContent = turno;
    $("turno").className = "turno" + (juego && !juego.terminada ? (juego.turnoDeAlma ? " de-alma" : " del-dueno") : "");
    $("nueva").disabled = !partida || (partida.ocupado && !partida.enPausa);
    mensaje(partida && partida.rechazada);

    if (juego && juego.terminada && !partida.ocupado && resultadoMostrado !== juego) {
      resultadoMostrado = juego;
      dialogoFinal(juego);
    }
  }

  function empezar() {
    if (!partida) return;
    cerrarDialogo();
    partida.nueva(Number($("tamano").value), $("empieza").value === "alma");
  }

  $("nueva").addEventListener("click", empezar);
  $("tamano").addEventListener("change", () => { if (!partida || !partida.juego) pintar(); });

  montarTablero(TAMANO_POR_DEFECTO);
  pintar();

  // El puente se sirve aparte en /play/_alma/alma.js; no se empaqueta.
  import(/* @vite-ignore */ "/play/_alma/alma.js")
    .then(({ createAlma }) => {
      partida = crearPartida({ alma: createAlma("timbiriche"), alCambiar: pintar, pausa: 700 });
      pintar();
    })
    .catch(() => {
      mensaje("Sin red, Alma no juega. Vuelve a abrir la página cuando haya conexión.");
      $("nueva").disabled = true;
    });
}
