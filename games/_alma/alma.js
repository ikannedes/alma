// Puente "Jugar con Alma" (PLAN-JUEGOS del dueño, 2026-10-31). Lo usan todos los juegos de /play/<juego>/.
// El juego es el árbitro: genera las jugadas legales, aplica la de Alma y decide quién gana. Aquí solo se habla con el
// relay (/app/play/...) y se muestra a Alma: burbuja de pensamiento con su reacción, avisos y el botón para volver.
// Sin dependencias; módulo ES: import { createAlma } from "/play/_alma/alma.js"

const FACE = { presumida: "😏", nerviosa: "😬", picada: "😤", aburrida: "🥱", concentrada: "🧐",
               farol: "🧐", contenta: "😊", dudosa: "🤔" };   // el farol se ve como concentración: no se delata
const CSS = `
.alma-bar{position:fixed;left:0;right:0;top:0;z-index:9998;display:flex;align-items:center;gap:10px;padding:8px 12px;
 background:rgba(15,17,23,.92);color:#e9e6f2;font:600 14px system-ui,sans-serif;backdrop-filter:blur(6px)}
.alma-bar a{color:#b7a3ff;text-decoration:none;font-weight:700}.alma-bar .sp{flex:1}
.alma-bubble{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(20px);z-index:9999;max-width:min(92vw,420px);
 display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:18px;background:#1c1f2b;color:#f3f1fa;
 box-shadow:0 8px 30px rgba(0,0,0,.45);font:500 15px system-ui,sans-serif;opacity:0;transition:.25s;pointer-events:none}
.alma-bubble.on{opacity:1;transform:translateX(-50%) translateY(0)}.alma-bubble i{font-style:normal;font-size:28px}
.alma-note{position:fixed;inset:auto 12px 80px 12px;z-index:9999;padding:12px 14px;border-radius:14px;background:#2a2033;
 color:#ffd9de;font:600 14px system-ui,sans-serif;text-align:center;display:none}
.alma-note button{margin-left:8px;border:0;border-radius:10px;padding:6px 10px;background:#b7a3ff;color:#1a1424;font-weight:700}
.alma-think{opacity:.7;font-style:italic}`;

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]) }

export function createAlma(game, opts = {}) {
  const base = opts.base || "/app/play/" + game;
  let match = null, bar, bubble, note, hideT;

  async function req(path, body) {
    const r = await fetch(base + path, body === undefined ? { credentials: "same-origin" }
      : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { location.href = "/"; throw new Error("login") }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "error " + r.status);
    return j;
  }

  function ui() {
    if (bar) return;
    const st = el("style"); st.textContent = CSS; document.head.appendChild(st);
    bar = el("div", "alma-bar", `<a href="/">← Alma</a><span class="sp"></span><span class="alma-st"></span>`);
    bubble = el("div", "alma-bubble"); note = el("div", "alma-note");
    document.body.append(bar, bubble, note);
    if (opts.padTop !== false) document.body.style.paddingTop = "44px";
  }
  ui();

  function status(t) { bar.querySelector(".alma-st").innerHTML = t || "" }
  function say(thought, reaction, ms = 4500) {
    clearTimeout(hideT);
    bubble.innerHTML = `<i>${FACE[reaction] || "🤖"}</i><span>${esc(thought || "…")}</span>`;
    bubble.classList.add("on");
    if (ms) hideT = setTimeout(() => bubble.classList.remove("on"), ms);
  }
  function thinking() {
    clearTimeout(hideT);
    bubble.innerHTML = '<i>🤔</i><span class="alma-think">Alma está pensando…</span>';
    bubble.classList.add("on");
  }
  function notice(text, action) {
    note.innerHTML = esc(text) + (action ? ` <button>${esc(action.label)}</button>` : "");
    note.style.display = text ? "block" : "none";
    if (action) note.querySelector("button").onclick = () => { note.style.display = "none"; action.run() };
  }

  return {
    get match() { return match },
    say, thinking, notice, status,
    // Empieza o retoma. {ok, match, refused, resumed}
    async start(fresh = false) {
      const r = await req("/start", { new: fresh });
      if (!r.ok) { notice(r.refused); return r }
      match = r.match; notice("");
      return r;
    },
    async load() { const r = await req(""); match = r.match; if (r.paused_text) notice(r.paused_text); return r },
    // Turno de Alma. legal: [{id, label}] (ids estables); state: texto compacto de lo que Alma ve.
    // Devuelve {move:{id,reaccion,pensamiento}} | {pending:true} | {paused, text} | {late:true}
    async move({ state, legal, history = [], snapshot, ownerMoved = true, async = true, onRetry }) {
      if (!match) throw new Error("no hay partida");
      if (!opts.realtime) thinking();   // en tiempo real no hay burbuja de "pensando" a cada rato
      const body = { match: match.id, state, legal, history, owner_moved: ownerMoved, async };
      if (snapshot !== undefined) body.snapshot = snapshot;
      const r = await req("/move", body);
      if (r.move) { say(r.move.pensamiento, r.move.reaccion); }
      else if (r.paused) { bubble.classList.remove("on"); notice(r.text, { label: "Reintentar", run: onRetry || (() => this.resume()) }) }
      else if (r.pending) say("Lo pienso y te aviso 😉", "concentrada");
      else bubble.classList.remove("on");
      return r;
    },
    // Partidas lentas: espera (consultando) a que Alma juegue. Devuelve la jugada pendiente o null.
    async waitPending(ms = 600000, every = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const r = await req(""); match = r.match;
        if (r.paused_text) { notice(r.paused_text, { label: "Reintentar", run: () => this.resume() }); return null }
        const p = match && match.pending;
        if (p && !p.seen) { say(p.pensamiento, p.reaccion); return p }
        await new Promise(res => setTimeout(res, every));
      }
      return null;
    },
    async resume() { notice(""); thinking(); return req("/resume", {}) },
    async seen() { if (match) await req("/seen", { match: match.id }) },
    async save(snapshot) { if (match) await req("/save", { match: match.id, snapshot }) },
    // tipos: empieza, buena_jugada, mala_jugada, gana_alma, pierde_alma, empate, farol_descubierto
    async event(type, { reaccion, history } = {}) {
      const r = await req("/event", { match: match && match.id, type, reaccion, history });
      if (r.result) match = null;
      return r;
    },
  };
}
