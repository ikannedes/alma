// Timbiriche (puntos y cajas) para "Jugar con Alma".
// Envuelve el motor de reglas original (board.js + board-topology.js), que es el árbitro: solo él sabe qué líneas
// quedan libres, las aplica, cuenta cajas y decide quién sigue. Aquí solo se traduce a ids estables, etiquetas en
// español y un texto compacto del tablero para Alma. Sin DOM: se usa igual en el navegador y en las pruebas de node.
import { Board, Owner } from "./board.js";
import { BoardTopology } from "./board-topology.js";

// Tamaños ofrecidos (cajas por lado). El motor admite de 1 a 6.
export const TAMANOS = [3, 4, 5, 6];
export const TAMANO_POR_DEFECTO = 3;

// Coordenadas del motor: dotX = columna (x), dotY = fila (y); caja = columna * size + fila.
// Línea par = horizontal (de (x,y) a (x+1,y)); línea impar = vertical (de (x,y) a (x,y+1)).
function coords(model, edge) {
  const dot = model.edgeDot1[edge];
  return { vertical: model.edgeRotated(edge), x: model.dotX(dot), y: model.dotY(dot) };
}

// Id estable: "h:r<fila de puntos>c<columna>" o "v:r<fila>c<columna de puntos>", base 0.
export function idDeLinea(model, edge) {
  const { vertical, x, y } = coords(model, edge);
  return `${vertical ? "v" : "h"}:r${y}c${x}`;
}

export function nombreCaja(model, box) {
  return `f${model.boxY(box) + 1}c${model.boxX(box) + 1}`;
}

// Descripción sin etiquetas tácticas, con cajas en base 1 (fila, columna).
export function describirLinea(model, edge) {
  const n = model.size;
  const { vertical, x, y } = coords(model, edge);
  if (!vertical) {
    if (y < n) {
      return `Línea horizontal arriba de la caja fila ${y + 1}, columna ${x + 1}${y === 0 ? " (borde superior)" : ""}`;
    }
    return `Línea horizontal abajo de la caja fila ${n}, columna ${x + 1} (borde inferior)`;
  }
  if (x < n) {
    return `Línea vertical a la izquierda de la caja fila ${y + 1}, columna ${x + 1}${x === 0 ? " (borde izquierdo)" : ""}`;
  }
  return `Línea vertical a la derecha de la caja fila ${y + 1}, columna ${n} (borde derecho)`;
}

function cajasDeLinea(model, edge) {
  const a = model.edgeBoxA[edge];
  const b = model.edgeBoxB[edge];
  return b === -1 ? [a] : [a, b];
}

export class Timbiriche {
  constructor(size = TAMANO_POR_DEFECTO, almaEmpieza = false) {
    if (!TAMANOS.includes(size)) throw new RangeError("tamaño no soportado: " + size);
    this.model = new BoardTopology(size);
    this.board = new Board(this.model);
    this.almaEmpieza = almaEmpieza;
    // En el motor siempre empieza el jugador 1.
    this.jugadorAlma = almaEmpieza ? Owner.Player1 : Owner.Player2;
    this.idALinea = new Map();
    for (let e = 0; e < this.model.edgeCount; e += 1) this.idALinea.set(idDeLinea(this.model, e), e);
    this.turnoActual = { quien: this.turnoDeAlma ? "alma" : "dueno", cajas: 0 };
  }

  get size() { return this.model.size; }
  get totalCajas() { return this.model.boxCount; }
  get terminada() { return !this.board.gaming(); }
  get turnoDeAlma() { return this.board.isPlayer1Turn() === this.almaEmpieza; }

  esDeAlma(owner) { return owner === this.jugadorAlma; }

  marcador() {
    const p1 = this.board.player1Score();
    const p2 = this.board.player2Score();
    return this.almaEmpieza ? { alma: p1, dueno: p2 } : { alma: p2, dueno: p1 };
  }

  // "gana_alma" | "pierde_alma" | "empate" | null si sigue la partida.
  resultado() {
    if (!this.terminada) return null;
    const { alma, dueno } = this.marcador();
    return alma > dueno ? "gana_alma" : alma < dueno ? "pierde_alma" : "empate";
  }

  libre(edge) {
    return Number.isInteger(edge) && edge >= 0 && edge < this.model.edgeCount && !this.board.contains(edge);
  }

  // Línea por id; -1 si no existe o ya está puesta.
  lineaPorId(id) {
    const edge = this.idALinea.get(String(id));
    return edge !== undefined && this.libre(edge) ? edge : -1;
  }

  // Qué pasaría al poner esta línea: cajas que cierra y cajas a las que les deja el tercer lado.
  efecto(edge) {
    const cierran = [];
    const regaladas = [];
    for (const box of cajasDeLinea(this.model, edge)) {
      const lados = this.board.counters[box];
      if (lados === 3) cierran.push(nombreCaja(this.model, box));
      else if (lados === 2) regaladas.push(nombreCaja(this.model, box));
    }
    return { cierra: cierran.length, regala: regaladas.length, cierran, regaladas };
  }

  // Ej.: "Línea vertical ... (cierra caja f1c2; tercer lado: regala caja f2c1)".
  etiqueta(edge) {
    const { cierran, regaladas } = this.efecto(edge);
    const marcas = [];
    if (cierran.length) marcas.push((cierran.length === 1 ? "cierra caja " : "cierra 2 cajas ") + cierran.join(" y "));
    if (regaladas.length) {
      marcas.push((regaladas.length === 1 ? "tercer lado: regala caja " : "tercer lado: regala 2 cajas ") + regaladas.join(" y "));
    }
    const base = describirLinea(this.model, edge);
    return marcas.length ? `${base} (${marcas.join("; ")})` : base;
  }

  // Jugadas legales en el orden del motor: [{id, label, edge}].
  legales() {
    const out = [];
    for (let e = 0; e < this.model.edgeCount; e += 1) {
      if (!this.board.contains(e)) out.push({ id: idDeLinea(this.model, e), label: this.etiqueta(e), edge: e });
    }
    return out;
  }

  // Aplica una línea por el árbitro. Devuelve qué pasó, incluida la línea del historial.
  // turnoTerminado/cajasDelTurno sirven para los eventos (buena_jugada / mala_jugada).
  jugar(edge) {
    if (this.terminada) throw new Error("la partida ya terminó");
    if (!this.libre(edge)) throw new Error("línea no válida: " + edge);
    const quien = this.turnoDeAlma ? "alma" : "dueno";
    if (this.turnoActual.quien !== quien) this.turnoActual = { quien, cajas: 0 };
    const cajas = this.board.add(edge);
    this.turnoActual.cajas += cajas;
    const terminada = this.terminada;
    const otraVez = !terminada && cajas > 0;
    const { alma, dueno } = this.marcador();
    const nombre = quien === "alma" ? "Alma" : "Dueño";
    let entrada = `${nombre}: ${describirLinea(this.model, edge)}`;
    if (cajas) entrada += ` → cierra ${cajas === 1 ? "1 caja" : cajas + " cajas"} y repite`;
    entrada += ` [Alma ${alma} – Dueño ${dueno}]`;
    const turnoTerminado = !otraVez;
    const res = { quien, id: idDeLinea(this.model, edge), cajas, otraVez, terminada, turnoTerminado,
                  cajasDelTurno: this.turnoActual.cajas, entrada };
    if (turnoTerminado && !terminada) this.turnoActual = { quien: this.turnoDeAlma ? "alma" : "dueno", cajas: 0 };
    return res;
  }

  // Dibujo de texto: "+" punto, "---" y "|" líneas puestas, A/D dueño de la caja, 1–3 = lados puestos.
  dibujo() {
    const m = this.model;
    const n = m.size;
    const h = (x, y) => this.board.contains(this.idALinea.get(`h:r${y}c${x}`));
    const v = (x, y) => this.board.contains(this.idALinea.get(`v:r${y}c${x}`));
    const filas = [];
    for (let y = 0; y <= n; y += 1) {
      let linea = "+";
      for (let x = 0; x < n; x += 1) linea += (h(x, y) ? "---" : "   ") + "+";
      filas.push(linea);
      if (y === n) break;
      let celdas = "";
      for (let x = 0; x <= n; x += 1) {
        celdas += v(x, y) ? "|" : " ";
        if (x === n) break;
        const box = x * n + y;
        const owner = this.board.boxOwner(box);
        const lados = this.board.counters[box];
        celdas += owner ? (this.esDeAlma(owner) ? " A " : " D ") : lados ? ` ${lados} ` : "   ";
      }
      filas.push(celdas);
    }
    return filas.join("\n");
  }

  // Texto compacto de lo que ve Alma.
  estadoTexto() {
    const m = this.model;
    const { alma, dueno } = this.marcador();
    const deAlma = [];
    const delDueno = [];
    const tres = [];
    const dos = [];
    for (let box = 0; box < m.boxCount; box += 1) {
      const owner = this.board.boxOwner(box);
      const nombre = nombreCaja(m, box);
      if (owner) (this.esDeAlma(owner) ? deAlma : delDueno).push(nombre);
      else if (this.board.counters[box] === 3) tres.push(nombre);
      else if (this.board.counters[box] === 2) dos.push(nombre);
    }
    const lista = (xs) => (xs.length ? xs.join(", ") : "ninguna");
    const quedan = m.boxCount - alma - dueno;
    const extra = this.turnoActual.quien === "alma" && this.turnoActual.cajas > 0
      ? ` Turno extra de Alma (ya cerró ${this.turnoActual.cajas} en este turno).` : "";
    return [
      `Timbiriche ${m.size}×${m.size} cajas (fNcM = fila N, columna M; fila 1 arriba, columna 1 a la izquierda).`,
      `Marcador: Alma ${alma} – Dueño ${dueno}. Quedan ${quedan} de ${m.boxCount} cajas y ${m.edgeCount - this.board.step} líneas libres.${extra}`,
      `Cerrar una caja (poner su 4.º lado) la gana y da otro turno.`,
      `Cajas de Alma: ${lista(deAlma)}. Cajas del dueño: ${lista(delDueno)}.`,
      `Con 3 lados (se cierran ya): ${lista(tres)}.`,
      `Con 2 lados (el tercer lado se la regala al rival): ${lista(dos)}.`,
      `Tablero (A = de Alma, D = del dueño, número = lados puestos):`,
      this.dibujo(),
    ].join("\n");
  }
}
