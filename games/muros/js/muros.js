'use strict';
/* =========================================================================
 * QMuros — lógica de "Muros" para jugar contra Alma (sin DOM).
 * Depende de: QRules (js/rules.js, el árbitro; no se modifica).
 *
 * Asientos fijos: jugador 0 = el dueño ("Tú", rojo, abajo, meta fila 9);
 *                 jugador 1 = Alma (azul, arriba, meta fila 1).
 *
 * Coordenadas algebraicas (como las ve el dueño):
 *   columnas a–i de izquierda a derecha (x = 0..8),
 *   filas 1–9 de abajo hacia arriba (fila = 9 − y).
 * Muros: se nombran por la casilla de abajo a la izquierda de su centro (a1–h8).
 *   "h c3" = muro horizontal entre las filas 3 y 4 que tapa las columnas c y d.
 *   "v c3" = muro vertical entre las columnas c y d que tapa las filas 3 y 4.
 *
 * Todo aquí es puro y probado en Node (tests/alma.test.mjs).
 * ========================================================================= */
var QMuros = (function () {

    const R = (typeof QRules !== 'undefined') ? QRules : require('./rules.js');
    const DUENO = 0, ALMA = 1;
    const COLS = 'abcdefghi';
    const MAX_LEGAL = 400;

    /* ---------------- notación ---------------- */
    function casilla(x, y) { return COLS[x] + (9 - y); }
    function muroCod(x, y) { return COLS[x] + (8 - y); }
    /** Nombre de quien juega: en pantalla el dueño es "Tú"; para Alma es "Dueño". */
    function quien(pi, paraAlma) { return pi === ALMA ? 'Alma' : (paraAlma ? 'Dueño' : 'Tú'); }

    /** Descripción en español de un registro del historial de QRules. */
    function describir(rec, paraAlma) {
        const tu = rec.pi === DUENO && !paraAlma;   // segunda persona solo en la pantalla del dueño
        if (rec.type === 'move') {
            const verbo = rec.jump ? (tu ? 'saltas a ' : 'salta a ') : (tu ? 'mueves a ' : 'mueve a ');
            return quien(rec.pi, paraAlma) + ': ' + verbo + casilla(rec.to.x, rec.to.y);
        }
        return quien(rec.pi, paraAlma) + ': ' + (tu ? 'pones' : 'pone') + ' muro ' +
            (rec.isH ? 'horizontal' : 'vertical') + ' en ' + muroCod(rec.x, rec.y);
    }

    /** Historial en español; paraAlma = true para mandarlo al puente. n = últimas n jugadas. */
    function historial(st, n, paraAlma) {
        const todo = st.history.map(r => describir(r, paraAlma));
        return n ? todo.slice(-n) : todo;
    }

    /* ---------------- partida ---------------- */
    /** Partida nueva; empieza "alma" o "dueno". */
    function nueva(empieza) {
        const st = R.createGame(2, [
            { name: 'Tú', type: 'human' },
            { name: 'Alma', type: 'human' }   // Alma no es la IA del repo: decide en el servidor
        ]);
        if (empieza === 'alma') st.turn = ALMA;
        return st;
    }

    /** Copia serializable (JSON) del estado completo. */
    function copiar(st) { return JSON.parse(JSON.stringify(st)); }

    function dist(st, pi) { return R.distanceToGoal(st, pi); }

    /* ---------------- jugadas legales con ids estables ---------------- */
    /**
     * Todas las jugadas legales del jugador pi: [{id, label, act}]
     *   act = {type:'move', x, y} | {type:'wall', x, y, isH}
     * Las etiquetas dicen el efecto en los caminos para que Alma decida con datos.
     */
    function legales(st, pi) {
        if (st.winner !== null || st.turn !== pi) return [];
        const yo = pi, el = 1 - pi;
        const out = [], vistos = new Set();
        for (const m of R.legalMoves(st, pi)) {
            const id = 'mv:' + casilla(m.x, m.y);
            if (vistos.has(id)) continue;
            vistos.add(id);
            const p = st.players[pi], ox = p.pos.x, oy = p.pos.y;
            p.pos = { x: m.x, y: m.y };          // prueba temporal, se deshace enseguida
            const d = dist(st, pi);
            p.pos = { x: ox, y: oy };
            out.push({
                id,
                label: (m.jump ? 'Saltar a ' : 'Mover a ') + casilla(m.x, m.y) +
                    (d === 0 ? ' (¡llegas a la meta!)' : ' (te quedan ' + d + ')'),
                act: { type: 'move', x: m.x, y: m.y }
            });
        }
        const d0yo = dist(st, yo), d0el = dist(st, el);
        for (const w of R.legalWalls(st, pi)) {
            const cod = muroCod(w.x, w.y);
            const id = 'wall:' + (w.isH ? 'h' : 'v') + ':' + cod;
            if (vistos.has(id)) continue;
            vistos.add(id);
            if (w.isH) st.hw[w.y][w.x] = 1; else st.vw[w.y][w.x] = 1;
            const d1yo = dist(st, yo), d1el = dist(st, el);
            if (w.isH) st.hw[w.y][w.x] = 0; else st.vw[w.y][w.x] = 0;
            out.push({
                id,
                label: 'Muro ' + (w.isH ? 'horizontal' : 'vertical') + ' en ' + cod +
                    ' · rival ' + flecha(d0el, d1el) + ', tú ' + flecha(d0yo, d1yo),
                act: { type: 'wall', x: w.x, y: w.y, isH: w.isH }
            });
        }
        return out.slice(0, MAX_LEGAL);
    }
    function flecha(a, b) { return a === b ? String(a) : a + '→' + b; }

    /** Lista para el puente: solo {id, label}. */
    function legalesPuente(st, pi) {
        return legales(st, pi).map(l => ({ id: l.id, label: l.label }));
    }

    /**
     * Aplica la jugada `id` del jugador pi a través de QRules.
     * Devuelve {ok, rec, antes:{yo,el}, despues:{yo,el}} o {ok:false, error}.
     */
    function aplicarId(st, pi, id) {
        const l = legales(st, pi).find(j => j.id === id);
        if (!l) return { ok: false, error: 'jugada no legal: ' + id };
        return aplicarAct(st, pi, l.act);
    }

    function aplicarAct(st, pi, act) {
        const el = 1 - pi;
        const antes = { yo: dist(st, pi), el: dist(st, el) };
        let rec;
        try {
            rec = act.type === 'move'
                ? R.applyMove(st, pi, { x: act.x, y: act.y })
                : R.applyWall(st, pi, act.x, act.y, act.isH);
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
        const despues = { yo: dist(st, pi), el: dist(st, el) };
        return { ok: true, rec, antes, despues };
    }

    /** Evento para el puente tras una jugada (o null). */
    function eventoJugada(pi, res) {
        if (!res || !res.ok || res.rec.type !== 'wall') return null;
        const alarga = res.despues.el - res.antes.el;
        if (alarga < 3) return null;
        return pi === ALMA ? 'buena_jugada' : 'mala_jugada';
    }

    /* ---------------- estado en texto para Alma ---------------- */
    function listaMuros(st) {
        const h = [], v = [];
        for (let y = 0; y < R.ANCH; y++) {
            for (let x = 0; x < R.ANCH; x++) {
                if (st.hw[y][x] > 0) h.push(muroCod(x, y) + (st.hw[y][x] - 1 === ALMA ? '(Alma)' : '(dueño)'));
                if (st.vw[y][x] > 0) v.push(muroCod(x, y) + (st.vw[y][x] - 1 === ALMA ? '(Alma)' : '(dueño)'));
            }
        }
        return { h, v };
    }

    /** Dibujo ASCII del tablero (fila 9 arriba). A = Alma, T = dueño, | y ─ = muros. */
    function dibujo(st) {
        const a = st.players[ALMA].pos, t = st.players[DUENO].pos;
        const lineas = ['   a b c d e f g h i'];
        for (let y = 0; y < R.N; y++) {
            let fila = (9 - y) + '  ';
            for (let x = 0; x < R.N; x++) {
                fila += (a.x === x && a.y === y) ? 'A' : (t.x === x && t.y === y) ? 'T' : '·';
                if (x < R.N - 1) fila += R.wallBetween(st, { x, y }, { x: x + 1, y }) ? '|' : ' ';
            }
            lineas.push(fila);
            if (y < R.N - 1) {
                let sep = '   ', alguno = false;
                for (let x = 0; x < R.N; x++) {
                    const b = R.wallBetween(st, { x, y }, { x, y: y + 1 });
                    if (b) alguno = true;
                    sep += (b ? '─' : ' ') + (x < R.N - 1 ? ' ' : '');
                }
                if (alguno) lineas.push(sep.replace(/\s+$/, ''));
            }
        }
        return lineas.join('\n');
    }

    function camino(st, pi) {
        const c = R.shortestPath(st, pi);
        return c ? c.map(p => casilla(p.x, p.y)).join(' ') : 'sin camino';
    }

    /** Texto compacto del tablero desde el punto de vista de Alma. */
    function estadoTexto(st) {
        const al = st.players[ALMA], du = st.players[DUENO];
        const m = listaMuros(st);
        const dA = dist(st, ALMA), dD = dist(st, DUENO);
        const partes = [
            'Muros 9×9. Columnas a–i (izquierda→derecha), filas 1–9. Eres Alma (A): empezaste en e9 y tu meta es la FILA 1. ' +
            'El dueño (T) empezó en e1 y su meta es la FILA 9.',
            'Tu ficha: ' + casilla(al.pos.x, al.pos.y) + ' · muros que te quedan: ' + al.walls + '.',
            'Ficha del dueño: ' + casilla(du.pos.x, du.pos.y) + ' · muros que le quedan: ' + du.walls + '.',
            'Camino más corto (ignorando fichas): tú ' + dA + ' pasos [' + camino(st, ALMA) + ']; ' +
            'el dueño ' + dD + ' pasos [' + camino(st, DUENO) + '].',
            'Notación de muros: "h c3" = horizontal entre filas 3 y 4 tapando columnas c y d; ' +
            '"v c3" = vertical entre columnas c y d tapando filas 3 y 4.',
            'Muros horizontales: ' + (m.h.length ? m.h.join(', ') : 'ninguno') + '.',
            'Muros verticales: ' + (m.v.length ? m.v.join(', ') : 'ninguno') + '.',
            'Tablero:\n' + dibujo(st),
            dA < dD ? 'Vas ganando la carrera.' : dA > dD ? 'El dueño va ganando la carrera.' : 'Carrera empatada.'
        ];
        return partes.join('\n').slice(0, 4000);
    }

    return {
        DUENO, ALMA, MAX_LEGAL,
        casilla, muroCod, describir, historial,
        nueva, copiar, dist,
        legales, legalesPuente, aplicarId, aplicarAct, eventoJugada,
        estadoTexto, dibujo
    };
})();

/* Node (pruebas): se exporta; en el navegador queda como global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QMuros;
