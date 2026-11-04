// Pruebas de la integración con Alma (sin red, sin navegador).
//
// Simula 100 partidas completas: Alma elige al azar (uniforme) de la lista `legal`
// que se le mandaría al puente; el dueño juega con una estrategia simple (avanza por
// su camino más corto y a veces pone un muro o mueve al azar). Todo se aplica con
// el motor de reglas (QRules), igual que en la página.
//
//   node tests/alma.test.mjs
'use strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const js = name => readFileSync(join(ROOT, 'js', name), 'utf8');

const ctx = vm.createContext({ console, module: { exports: {} } });
vm.runInContext(js('rules.js'), ctx, { filename: 'rules.js' });
vm.runInContext(js('muros.js'), ctx, { filename: 'muros.js' });
const QRules = vm.runInContext('QRules', ctx);
const QMuros = vm.runInContext('QMuros', ctx);
const { ALMA, DUENO } = QMuros;

let passed = 0;
function ok(cond, msg) {
    if (cond) { passed++; return true; }
    console.error('FALLO: ' + msg); process.exitCode = 1; return false;
}

// Generador pseudoaleatorio con semilla (las pruebas se pueden repetir igual).
let seed = 20261031;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; }
const pick = arr => arr[Math.floor(rnd() * arr.length)];

/* ---------------- 1. tablero vacío ---------------- */
{
    const st = QMuros.nueva('alma');
    const l = QMuros.legales(st, ALMA);
    ok(st.turn === ALMA, 'si empieza Alma, el turno es suyo');
    ok(l.length === 3 + 128, 'tablero vacío: 3 movimientos + 128 muros (' + l.length + ')');
    ok(l.some(j => j.id === 'mv:e8'), 'Alma puede bajar a e8');
    ok(l.some(j => j.id === 'wall:h:a1') && l.some(j => j.id === 'wall:v:h8'), 'ids de muros a1–h8');
    ok(QMuros.legales(st, DUENO).length === 0, 'fuera de turno no hay jugadas');
    const d = QMuros.nueva('dueno');
    ok(d.turn === DUENO && QMuros.casilla(d.players[DUENO].pos.x, d.players[DUENO].pos.y) === 'e1', 'el dueño empieza en e1');
    ok(QMuros.casilla(d.players[ALMA].pos.x, d.players[ALMA].pos.y) === 'e9', 'Alma empieza en e9');
}

/* ---------------- 2. eventos por muros que alargan el camino ---------------- */
{
    // Muros horizontales de Alma entre las filas 1 y 2 tapando a–b, c–d y g–h:
    // el dueño (e1) aún sube por e/f (8 pasos). El muro "h e1" tapa e–f y lo obliga
    // a ir hasta la columna i: 12 pasos → +4 → buena_jugada.
    const st = QMuros.nueva('alma');
    for (const x of [0, 2, 6]) { QRules.applyWall(st, ALMA, x, 7, true); st.turn = ALMA; }
    ok(QMuros.dist(st, DUENO) === 8, 'antes del muro el dueño está a 8');
    const res = QMuros.aplicarId(st, ALMA, 'wall:h:e1');
    ok(res.ok, 'el muro h e1 se aplica');
    ok(res.antes.el === 8 && res.despues.el === 12, 'el camino del dueño pasa de 8 a 12');
    ok(QMuros.eventoJugada(ALMA, res) === 'buena_jugada', 'muro de Alma que alarga ≥3 → buena_jugada');
    ok(QMuros.eventoJugada(DUENO, { ok: true, rec: { type: 'wall' }, antes: { el: 5 }, despues: { el: 8 } }) === 'mala_jugada',
        'muro del dueño que alarga 3 el de Alma → mala_jugada');
    ok(QMuros.eventoJugada(DUENO, { ok: true, rec: { type: 'wall' }, antes: { el: 5 }, despues: { el: 7 } }) === null,
        'alargar 2 no es evento');
    ok(QMuros.eventoJugada(ALMA, { ok: true, rec: { type: 'move' }, antes: { el: 5 }, despues: { el: 9 } }) === null,
        'mover no es evento');
    ok(QMuros.historial(st, 0, true).slice(-1)[0] === 'Alma: pone muro horizontal en e1', 'historial en español para Alma');
    ok(QMuros.dibujo(st).startsWith('   a b c d e f g h i\n9  · · · · A'), 'dibujo ASCII con la fila 9 arriba');
}

/* ---------------- 3. jugada inválida rechazada ---------------- */
{
    const st = QMuros.nueva('dueno');
    ok(!QMuros.aplicarId(st, ALMA, 'mv:e8').ok, 'Alma no juega fuera de turno');
    ok(!QMuros.aplicarId(st, DUENO, 'mv:e5').ok, 'casilla no adyacente rechazada');
    ok(!QMuros.aplicarId(st, DUENO, 'inventada').ok, 'id desconocido rechazado');
}

/* ---------------- 4. 100 partidas completas ---------------- */
const PARTIDAS = 100;
let invalidas = 0, sinGanador = 0, repetidos = 0, demasiadas = 0, idLargo = 0, etiquetaLarga = 0, estadoLargo = 0;
let ganaAlma = 0, ganaDueno = 0, empiezaAlma = 0, turnosAlma = 0, maxLegal = 0, jugadasTot = 0;
let eventosBuenos = 0, eventosMalos = 0;
for (let g = 0; g < PARTIDAS; g++) {
    const empieza = g % 2 === 0 ? 'dueno' : 'alma';   // se alterna, como en la página
    if (empieza === 'alma') empiezaAlma++;
    let st = QMuros.nueva(empieza);
    let plies = 0;
    while (st.winner === null && plies < 3000) {
        plies++;
        if (st.turn === ALMA) {
            // la página guarda el snapshot ANTES de la jugada de Alma y lo restaura al volver
            st = JSON.parse(JSON.stringify(QMuros.copiar(st)));
            const legal = QMuros.legalesPuente(st, ALMA);
            turnosAlma++;
            maxLegal = Math.max(maxLegal, legal.length);
            if (legal.length > 400) demasiadas++;
            if (new Set(legal.map(j => j.id)).size !== legal.length) repetidos++;
            for (const j of legal) {
                if (j.id.length > 40) idLargo++;
                if (j.label.length > 80) etiquetaLarga++;
            }
            if (QMuros.estadoTexto(st).length > 4000) estadoLargo++;
            const elegido = pick(legal).id;
            const res = QMuros.aplicarId(st, ALMA, elegido);
            if (!res.ok) { invalidas++; console.error('inválida', elegido, res.error); break; }
            if (QMuros.eventoJugada(ALMA, res) === 'buena_jugada') eventosBuenos++;
        } else {
            // dueño: 70 % avanza por el camino más corto, 15 % muro al azar, 15 % cualquier jugada
            const todas = QMuros.legales(st, DUENO);
            const movs = todas.filter(j => j.act.type === 'move');
            const muros = todas.filter(j => j.act.type === 'wall');
            const r = rnd();
            let j;
            if (r < 0.7) {
                let mejor = Infinity;
                for (const m of movs) {
                    const c = QMuros.copiar(st);
                    c.players[DUENO].pos = { x: m.act.x, y: m.act.y };
                    const d = QMuros.dist(c, DUENO);
                    if (d < mejor) { mejor = d; j = m; }
                }
            } else if (r < 0.85 && muros.length) j = pick(muros);
            else j = pick(todas);
            const res = QMuros.aplicarId(st, DUENO, j.id);
            if (!res.ok) { invalidas++; console.error('inválida (dueño)', j.id, res.error); break; }
            if (QMuros.eventoJugada(DUENO, res) === 'mala_jugada') eventosMalos++;
        }
        jugadasTot++;
    }
    if (st.winner === null) sinGanador++;
    else if (st.winner === ALMA) ganaAlma++;
    else ganaDueno++;
    // el historial en español para el evento final está completo
    const h = QMuros.historial(st, 0, true);
    if (h.length !== st.history.length || h.some(s => !/^(Alma|Dueño): /.test(s))) invalidas++;
}
ok(invalidas === 0, '0 jugadas inválidas (' + invalidas + ')');
ok(sinGanador === 0, 'todas las partidas terminan con ganador (' + sinGanador + ' sin ganador)');
ok(repetidos === 0, 'ids únicos en cada turno (' + repetidos + ' turnos con repetidos)');
ok(demasiadas === 0 && maxLegal <= 400, 'lista ≤ 400 (máximo visto ' + maxLegal + ')');
ok(idLargo === 0, 'ids ≤ 40 caracteres');
ok(etiquetaLarga === 0, 'etiquetas ≤ 80 caracteres (el relay corta en 80)');
ok(estadoLargo === 0, 'estado ≤ 4000 caracteres');
ok(empiezaAlma === 50, 'Alma empezó la mitad de las partidas');
ok(ganaAlma + ganaDueno === PARTIDAS, 'ganadores contados');

/* ---------------- 5. Alma también puede ganar (cierre de partida "gana_alma") ----------------
 * 20 partidas extra: Alma elige al azar entre las jugadas de su lista que más la acercan a
 * la meta y el dueño juega al azar. Comprueba que el final con victoria de Alma funciona. */
let ganaAlma2 = 0, invalidas2 = 0;
for (let g = 0; g < 20; g++) {
    let st = QMuros.nueva(g % 2 ? 'alma' : 'dueno');
    let plies = 0;
    while (st.winner === null && plies++ < 3000) {
        if (st.turn === ALMA) {
            const movs = QMuros.legales(st, ALMA).filter(j => j.act.type === 'move');
            let mejor = Infinity, opciones = [];
            for (const m of movs) {
                const c = QMuros.copiar(st);
                c.players[ALMA].pos = { x: m.act.x, y: m.act.y };
                const d = QMuros.dist(c, ALMA);
                if (d < mejor) { mejor = d; opciones = [m]; } else if (d === mejor) opciones.push(m);
            }
            if (!QMuros.aplicarId(st, ALMA, pick(opciones).id).ok) invalidas2++;
        } else if (!QMuros.aplicarId(st, DUENO, pick(QMuros.legales(st, DUENO)).id).ok) invalidas2++;
    }
    if (st.winner === ALMA) ganaAlma2++;
}
ok(invalidas2 === 0, 'partidas extra sin jugadas inválidas');
ok(ganaAlma2 > 0, 'Alma gana alguna partida cuando juega hacia su meta (' + ganaAlma2 + '/20)');

console.log(`partidas: ${PARTIDAS} · gana Alma ${ganaAlma} · gana el dueño ${ganaDueno} · ` +
    `turnos de Alma ${turnosAlma} · jugadas ${jugadasTot} · lista máx ${maxLegal} · ` +
    `buena_jugada ${eventosBuenos} · mala_jugada ${eventosMalos}`);
console.log(`\n${passed} comprobaciones de Alma pasadas ✓`);
if (process.exitCode) console.error('hubo fallos');
