'use strict';
/* =========================================================================
 * QPartida — controlador de "Muros" contra Alma.
 * Depende de: QRules (árbitro), QRender, QInput (dibujo y entrada del repo),
 *             QMuros (jugadas con ids, textos en español) y el puente de Alma
 *             (/play/_alma/alma.js, se carga con import() dinámico, no se copia).
 *
 * Sin red, Alma no juega: aquí no hay ningún bot de repuesto. La IA del repo
 * original (ai.js / ai-worker.js) se quitó por completo.
 *
 * Flujo lento (asíncrono):
 *   1. El dueño juega → se manda move({snapshot: estado ANTES de la jugada de Alma, async:true})
 *      → {pending:true}. Se puede cerrar la página.
 *   2. Con la página abierta se espera con waitPending(); la jugada que llega se aplica
 *      con QRules, luego seen() y save(estado DESPUÉS de la jugada de Alma).
 *   3. Al abrir la página: start(false) retoma la partida, se restaura el snapshot y,
 *      si Alma ya jugó y no se aplicó, se aplica; si sigue pensando, se espera.
 * ========================================================================= */
var QPartida = (function () {

    const R = QRules, M = QMuros, DUENO = M.DUENO, ALMA = M.ALMA;
    const board = QRender.board;
    const marco = document.getElementById('marco');
    const estadoEl = document.getElementById('estado');
    const jugadoresEl = document.getElementById('jugadores');
    const historialEl = document.getElementById('historial');
    const caminosBtn = document.getElementById('caminosBtn');
    const nuevaBtn = document.getElementById('nuevaBtn');
    const finOverlay = document.getElementById('finOverlay');
    const toastEl = document.getElementById('toast');

    let alma = null;          // objeto del puente (createAlma("muros"))
    let st = null;            // estado de QRules
    let empezo = 'dueno';     // quién empezó esta partida
    let matchId = null;
    let listo = false;        // hay partida abierta con Alma
    let esperando = false;    // turno de Alma (pidiendo o esperando su jugada)
    let epoca = 0;            // cambia con cada partida nueva: corta esperas viejas
    let hoverCell = null, hoverWall = null;
    let caminos = leer('muros.caminos') !== '0';
    let pathCache = { key: null, paths: null };

    /* ---------------- utilidades ---------------- */
    function leer(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function escribir(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
    function dormir(ms) { return new Promise(r => setTimeout(r, ms)); }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    let toastT = null;
    function toast(msg, error) {
        toastEl.textContent = msg;
        toastEl.className = 'toast show' + (error ? ' error' : '');
        clearTimeout(toastT);
        toastT = setTimeout(() => { toastEl.className = 'toast'; }, 2400);
    }

    /** Línea de estado; accion = {label, run} opcional (botón a la derecha). */
    function estado(html, accion) {
        estadoEl.innerHTML = html + (accion ? '<button type="button" class="btn btn-sm">' + esc(accion.label) + '</button>' : '');
        if (accion) estadoEl.querySelector('button').onclick = accion.run;
    }
    const PENSANDO = '<span class="pensando">Alma está pensando<i></i><i></i><i></i></span>';

    function snapshot() { return { v: 1, empezo, st: M.copiar(st) }; }

    function miTurno() {
        return listo && !esperando && st && st.winner === null && st.turn === DUENO;
    }

    /* ---------------- dibujo ---------------- */
    function computePaths() {
        if (!st || st.winner !== null || !caminos) return null;
        const key = JSON.stringify([st.players.map(p => [p.pos.x, p.pos.y]), st.hw, st.vw]);
        if (pathCache.key === key) return pathCache.paths;
        const paths = [];
        for (const p of st.players) {
            const cells = R.shortestPath(st, p.id);
            if (cells && cells.length > 1) paths.push({ color: p.color, cells });
        }
        pathCache = { key, paths };
        QRender.pathChanged(key);
        return paths;
    }

    /** Letras (a–i) abajo y números (1–9) a la izquierda, dentro del margen del tablero. */
    function coordenadas() {
        const ctx = QRender.ctx, dpr = board._dpr || 1;
        const pad = QRender.PAD;
        const size = board.width / dpr;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '600 ' + Math.max(8, Math.round(pad * 0.62)) + 'px Manrope, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < R.N; i++) {
            const r = QRender.cellRect(i, i);
            ctx.fillText('abcdefghi'[i], r.cx, size - pad / 2);
            ctx.fillText(String(9 - i), pad / 2, r.cy);
        }
        ctx.restore();
    }

    function redraw() {
        if (!st) return;
        const turnoDueno = miTurno();
        const ultimo = st.history[st.history.length - 1];
        QRender.draw(st, {
            hoverCell: turnoDueno ? hoverCell : null,
            hoverWall: turnoDueno ? hoverWall : null,
            legalCells: turnoDueno ? R.legalMoves(st, DUENO) : [],
            paths: computePaths(),
            currentPi: st.winner === null ? st.turn : st.winner,
            lastMove: ultimo && ultimo.type === 'move' ? ultimo : null,
            lastWall: ultimo && ultimo.type === 'wall' ? ultimo : null,
            cursor: turnoDueno && document.activeElement === board ? QInput.cursor : null
        });
        coordenadas();
    }

    function pintarJugadores() {
        jugadoresEl.innerHTML = '';
        for (const pi of [DUENO, ALMA]) {
            const p = st.players[pi];
            const card = document.createElement('div');
            card.className = 'player' + (st.winner === null && st.turn === pi ? ' turn' : '') + (st.winner === pi ? ' win' : '');
            card.style.setProperty('--pc', p.color);
            const d = M.dist(st, pi);
            card.innerHTML = '<div class="p-row"><span class="p-dot"></span><span class="p-name"></span>' +
                '<span class="p-dist"><b>' + (isFinite(d) ? d : '∞') + '</b> a la meta</span></div>' +
                '<div class="p-walls" title="Muros que quedan"></div>';
            card.querySelector('.p-name').textContent = pi === DUENO ? 'Tú' : 'Alma';
            const muros = card.querySelector('.p-walls');
            for (let i = 0; i < p.wallQuota; i++) {
                const w = document.createElement('span');
                w.className = 'p-wall' + (i < p.wallQuota - p.walls ? ' used' : '');
                muros.appendChild(w);
            }
            jugadoresEl.appendChild(card);
        }
    }

    function pintarHistorial() {
        historialEl.innerHTML = '';
        const h = M.historial(st, 0, false);
        for (let i = h.length - 1; i >= 0; i--) {
            const li = document.createElement('li');
            li.textContent = h[i];
            if (st.history[i].pi === ALMA) li.className = 'alma';
            historialEl.appendChild(li);
        }
    }

    function refrescar() {
        if (!st) return;
        pathCache = { key: null, paths: null };
        pintarJugadores();
        pintarHistorial();
        marco.classList.toggle('inactivo', !listo);
        redraw();
    }

    function estadoTurno() {
        if (!st) return;
        if (st.winner !== null) {
            estado(st.winner === DUENO ? '<b>¡Ganaste!</b>' : '<b>Ganó Alma.</b>',
                { label: 'Otra partida', run: () => nuevaPartida(false) });
            return;
        }
        if (st.turn === DUENO) {
            const p = st.players[DUENO];
            estado('<span class="punto" style="--pc:' + p.color + '"></span><b>Te toca</b>' +
                '<span class="meta">te quedan ' + p.walls + ' muro' + (p.walls === 1 ? '' : 's') +
                ' · toca una casilla iluminada o una ranura</span>');
        }
    }

    /* ---------------- tamaño ---------------- */
    function ajustarTablero() {
        const ancho = marco.clientWidth || 320;
        const alto = (window.innerHeight || 700) - 44 - 190;   // barra de Alma + cabecera, estado y tarjetas
        const size = Math.max(260, Math.min(ancho, alto, 640));
        QRender.resize(Math.floor(size));
        redraw();
    }
    window.addEventListener('resize', ajustarTablero);
    window.addEventListener('orientationchange', ajustarTablero);
    document.addEventListener('quoridor:redraw', redraw);   // animaciones de render.js
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const cambio = () => { QRender.invalidateTheme(); redraw(); };
        if (mq.addEventListener) mq.addEventListener('change', cambio);
        else if (mq.addListener) mq.addListener(cambio);
    }

    /* ---------------- entrada del dueño ---------------- */
    QInput.bind({ onTap: alTocar, onHover: alPasar, onCursor: alCursor });

    function alTocar(cell, wall) {
        if (!miTurno()) {
            if (esperando) toast('Espera: le toca a Alma');
            return;
        }
        let act;
        if (wall) {
            if (!R.canPlaceWall(st, DUENO, wall.x, wall.y, wall.isH)) {
                const p = st.players[DUENO];
                toast(p.walls <= 0 ? 'Ya no te quedan muros'
                    : R.wallConflicts(st, wall.x, wall.y, wall.isH) ? 'Ese muro se encima o se cruza con otro'
                    : 'Ese muro dejaría a alguien sin camino', true);
                return;
            }
            act = { type: 'wall', x: wall.x, y: wall.y, isH: wall.isH };
        } else {
            if (!cell) return;
            if (!R.legalMoves(st, DUENO).some(m => m.x === cell.x && m.y === cell.y)) {
                toast('Esa casilla no es una jugada válida', true);
                return;
            }
            act = { type: 'move', x: cell.x, y: cell.y };
        }
        jugadaDueno(act);
    }

    function alPasar(cell, wall) {
        if (!miTurno()) { cell = null; wall = null; }
        if (wall) wall = { x: wall.x, y: wall.y, isH: wall.isH, legal: R.canPlaceWall(st, DUENO, wall.x, wall.y, wall.isH) };
        const igual = (a, b) => (!a && !b) || (a && b && a.x === b.x && a.y === b.y && a.isH === b.isH && a.legal === b.legal);
        if (igual(cell, hoverCell) && igual(wall, hoverWall)) return;
        hoverCell = cell; hoverWall = wall;
        redraw();
    }

    function alCursor(cursor) {
        hoverCell = cursor.mode === 'cell' ? { x: cursor.x, y: cursor.y } : null;
        hoverWall = cursor.mode === 'wall' && st
            ? { x: cursor.x, y: cursor.y, isH: cursor.isH, legal: R.canPlaceWall(st, DUENO, cursor.x, cursor.y, cursor.isH) }
            : null;
        redraw();
    }

    async function jugadaDueno(act) {
        const res = M.aplicarAct(st, DUENO, act);   // el árbitro (QRules) valida y aplica
        if (!res.ok) { toast('Jugada no válida', true); return; }
        if (act.type === 'wall') QRender.landed(act.x, act.y, act.isH);
        hoverCell = hoverWall = null;
        refrescar();
        if (st.winner !== null) { await terminar(); return; }
        const ev = M.eventoJugada(DUENO, res);       // muro del dueño que alarga ≥3 el camino de Alma
        if (ev) alma.event(ev).catch(() => {});
        await pedirAlma(epoca, true);
    }

    /* ---------------- turno de Alma ---------------- */
    async function pedirAlma(mi, ownerMoved) {
        if (mi !== epoca || !st || st.winner !== null || st.turn !== ALMA) return;
        esperando = true;
        refrescar();
        estado(PENSANDO);
        let r;
        try {
            r = await alma.move({
                state: M.estadoTexto(st),
                legal: M.legalesPuente(st, ALMA),
                history: M.historial(st, 12, true),
                snapshot: snapshot(),                 // estado ANTES de la jugada de Alma
                ownerMoved,
                async: true,
                onRetry: () => pedirAlma(epoca, false)
            });
        } catch (e) {
            if (mi !== epoca) return;
            sinRed('No pude hablar con Alma (' + (e && e.message || 'sin red') + ').',
                () => pedirAlma(mi, false));
            return;
        }
        if (mi !== epoca) return;
        if (r.move) { await aplicarAlma(r.move, mi, false); return; }
        if (r.paused) {                                // el puente ya muestra el aviso con "Reintentar"
            estado('<span class="meta">Alma se quedó pensando.</span>');
            return;
        }
        await esperarAlma(mi);                         // {pending:true} (o {late:true}): esperar
    }

    async function esperarAlma(mi) {
        esperando = true;
        refrescar();
        estado(PENSANDO + '<span class="meta">Puedes cerrar la página: te avisa cuando juegue.</span>');
        let cada = 3000;
        while (mi === epoca) {
            let p = null;
            try {
                p = await alma.waitPending(600000, cada);
            } catch (e) {
                if (mi !== epoca) return;
                estado('<span class="meta">Sin conexión con Alma; reintento en un momento…</span>');
                await dormir(10000);
                continue;
            }
            if (mi !== epoca) return;
            if (p) { await aplicarAlma(p, mi, false); return; }
            const m = alma.match;
            if (!m || m.id !== matchId) {
                estado('<span class="meta">Esta partida ya no está abierta.</span>',
                    { label: 'Recargar', run: () => location.reload() });
                esperando = false;
                return;
            }
            // null: se acabó el tiempo de espera o Alma está en pausa (el puente muestra "Reintentar").
            cada = 15000;
            await dormir(m.paused ? 8000 : 1000);
        }
    }

    /** Aplica una jugada de Alma ({id, reaccion, pensamiento}) con el árbitro. */
    async function aplicarAlma(p, mi, alAbrir) {
        if (mi !== epoca) return;
        const res = M.aplicarId(st, ALMA, p.id);
        if (!res.ok) {
            esperando = false;
            estado('<span class="meta">Alma mandó una jugada que no vale (' + esc(p.id) + ').</span>',
                { label: 'Pedirle otra', run: () => pedirAlma(epoca, false) });
            return;
        }
        if (alAbrir && p.pensamiento) alma.say(p.pensamiento, p.reaccion);   // al volver a la página
        if (res.rec.type === 'wall') QRender.landed(res.rec.x, res.rec.y, res.rec.isH);
        esperando = false;
        refrescar();
        try { await alma.seen(); } catch (e) { /* se reintenta al guardar la siguiente */ }
        await guardar();                               // estado DESPUÉS de la jugada de Alma
        const ev = M.eventoJugada(ALMA, res);          // muro de Alma que alarga ≥3 tu camino
        if (st.winner !== null) { await terminar(); return; }
        if (ev) alma.event(ev).catch(() => {});
        estadoTurno();
        redraw();
    }

    async function guardar() {
        try { await alma.save(snapshot()); }
        catch (e) { toast('No se pudo guardar la partida', true); }
    }

    /* ---------------- fin ---------------- */
    async function terminar() {
        esperando = false;
        refrescar();
        estadoTurno();
        await guardar();                               // antes del evento: luego la partida se cierra
        const tipo = st.winner === ALMA ? 'gana_alma' : 'pierde_alma';
        try {
            await alma.event(tipo, { history: M.historial(st, 0, true) });
            listo = false;
        } catch (e) {
            toast('No pude avisarle a Alma del final; lo intento al volver', true);
        }
        mostrarFin();
    }

    function mostrarFin() {
        const gana = st.winner === DUENO;
        document.getElementById('finTitulo').textContent = gana ? '¡Ganaste!' : 'Ganó Alma';
        document.getElementById('finSub').textContent = st.history.length + ' jugadas · ' +
            (gana ? 'llegaste a la fila 9.' : 'llegó a la fila 1.');
        finOverlay.querySelector('.modal').style.setProperty('--win-color', st.players[st.winner].color);
        finOverlay.classList.remove('hidden');
    }
    document.getElementById('otraBtn').onclick = () => { finOverlay.classList.add('hidden'); nuevaPartida(false); };
    document.getElementById('verBtn').onclick = () => finOverlay.classList.add('hidden');
    finOverlay.addEventListener('click', e => { if (e.target === finOverlay) finOverlay.classList.add('hidden'); });

    /* ---------------- partidas ---------------- */
    /** Alterna quién empieza (recordado en este navegador); si no se puede recordar, al azar. */
    function quienEmpieza() {
        const ultimo = leer('muros.empezo');
        const toca = ultimo === 'alma' ? 'dueno' : ultimo === 'dueno' ? 'alma' : (Math.random() < 0.5 ? 'alma' : 'dueno');
        escribir('muros.empezo', toca);
        return toca;
    }

    function sinRed(texto, reintentar) {
        esperando = false;
        estado('<span class="meta">' + esc(texto) + ' Sin red, Alma no juega.</span>',
            { label: 'Reintentar', run: reintentar });
    }

    async function abrir(fresh) {
        const mi = ++epoca;
        listo = false; esperando = false;
        finOverlay.classList.add('hidden');
        estado('<span class="meta">Conectando con Alma…</span>');
        let r;
        try { r = await alma.start(fresh); }
        catch (e) { if (mi === epoca) sinRed('No pude abrir la partida.', () => abrir(fresh)); return; }
        if (mi !== epoca) return;
        if (!r.ok) {                                   // Alma no quiere/puede jugar (el puente muestra el motivo)
            estado('<span class="meta">' + esc(r.refused || 'Alma no puede jugar ahora.') + '</span>',
                { label: 'Reintentar', run: () => abrir(fresh) });
            refrescar();
            return;
        }
        const m = r.match;
        matchId = m.id;
        listo = true;
        const snap = m.snapshot;
        if (snap && snap.st && snap.st.players) {
            st = snap.st;
            empezo = snap.empezo || 'dueno';
            refrescar();
            if (st.winner !== null) { await terminar(); return; }   // el aviso del final no había llegado
            if (st.turn === ALMA) {
                const p = m.pending;
                // Alma ya jugó (el servidor devolvió el turno al dueño) pero aún no se aplicó aquí.
                if (p && m.turn !== 'alma' && M.legales(st, ALMA).some(j => j.id === p.id)) {
                    await aplicarAlma(p, mi, true);
                    return;
                }
                if (m.turn === 'alma') { await esperarAlma(mi); return; }
                await pedirAlma(mi, false);            // la petición no llegó: se vuelve a pedir
                return;
            }
            if (m.pending && !m.pending.seen) alma.seen().catch(() => {});
            estadoTurno();
            redraw();
            return;
        }
        // Partida nueva.
        empezo = quienEmpieza();
        st = M.nueva(empezo);
        QInput.focusPlayer(st.players[DUENO].pos);
        refrescar();   // "empieza" lo manda el relay al robot en start(); no se repite aquí
        if (empezo === 'alma') {
            toast('Empieza Alma');
            await pedirAlma(mi, false);
        } else {
            toast('Empiezas tú');
            await guardar();
            estadoTurno();
            redraw();
        }
    }

    function nuevaPartida(preguntar) {
        if (!alma) { location.reload(); return; }
        const enCurso = listo && st && st.winner === null && st.history.length > 0;
        if (preguntar && enCurso && !confirm('¿Empezar otra partida? La de ahora se abandona.')) return;
        abrir(true);
    }

    nuevaBtn.addEventListener('click', () => nuevaPartida(true));
    caminosBtn.setAttribute('aria-pressed', String(caminos));
    caminosBtn.addEventListener('click', () => {
        caminos = !caminos;
        escribir('muros.caminos', caminos ? '1' : '0');
        caminosBtn.setAttribute('aria-pressed', String(caminos));
        pathCache = { key: null, paths: null };
        redraw();
    });

    /* ---------------- arranque ---------------- */
    async function arrancar() {
        st = M.nueva('dueno');                         // tablero de fondo mientras conecta
        ajustarTablero();
        refrescar();
        try {
            const mod = await import('/play/_alma/alma.js');
            alma = mod.createAlma('muros');
        } catch (e) {
            sinRed('No encuentro a Alma.', () => location.reload());
            return;
        }
        ajustarTablero();                              // la barra de Alma ya ocupa su sitio
        await abrir(false);
    }
    arrancar();

    return { get state() { return st; }, redraw };
})();
