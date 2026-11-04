// Modificado para Alma, 2026-10-31: textos visibles y etiquetas accesibles en español.
// Original: Moss & Ember, ThatXliner/clash-royale-clone, commit 75d30d1 (AGPL-3.0-only).
export const ARENA_SHELL_VIEWPORT = Object.freeze({
  width: 720,
  height: 1280,
});

export const ARENA_SHELL_PLAYFIELD = Object.freeze({
  left: 90,
  top: 108,
  width: 540,
  height: 960,
  columns: 18,
  rows: 32,
  tileWidth: 30,
  tileHeight: 30,
});

export const ARENA_SHELL_PROVENANCE = Object.freeze({
  kind: "original-authored-primitives",
  externalAssets: Object.freeze([]),
  calibration: "uncalibrated-no-licensed-reference-still",
});

const SHELL_MARKUP = `<main class="battle-shell" data-ui="arena-shell" aria-label="Batalla de torres">
  <button class="audio-toggle" type="button" data-ui="audio-toggle" aria-pressed="false" aria-label="Silenciar sonido">Sonido sí</button>
  <button class="deck-choice-open" type="button" data-ui="deck-choice-open" aria-haspopup="dialog" aria-controls="deck-choice" aria-expanded="false" hidden>Elegir mazo</button>
  <section class="deck-choice" id="deck-choice" data-ui="deck-choice" role="dialog" aria-modal="true" aria-labelledby="deck-choice-title" hidden>
    <div class="deck-choice__panel">
      <p class="deck-choice__eyebrow">READY YOUR DECK</p>
      <h1 id="deck-choice-title">Choose an eight-card deck</h1>
      <div class="deck-choice__options" role="group" aria-label="Supported decks">
        <button class="deck-choice__option" type="button" data-deck-choice="standard" aria-pressed="true">
          <strong>Standard</strong><span>Eight supported cards</span>
        </button>
        <button class="deck-choice__option" type="button" data-deck-choice="stonehauler" aria-pressed="false">
          <strong>Stonehauler</strong><span>Replaces Cinderlings</span>
        </button>
        <button class="deck-choice__option" type="button" data-deck-choice="bulwark-needle" aria-pressed="false">
          <strong>Bulwark Needle</strong><span>Replaces Cinderlings · combat QUESTION</span>
        </button>
      </div>
      <button class="deck-choice__start" type="button" data-ui="deck-start">Start match</button>
    </div>
  </section>
  <aside class="combat-policy-question" data-ui="policy-question" role="status" aria-live="polite" hidden></aside>
  <button class="restart-control" type="button" data-ui="restart" hidden>Otra vez</button>
  <header class="match-rail match-rail--top" data-ui="opponent-hud">
    <span class="player-mark player-mark--ember" aria-hidden="true"></span>
    <span class="crown-track" aria-label="Coronas de Alma"><i></i><i></i><i></i></span>
  </header>
  <section class="arena" data-ui="arena" aria-label="Arena">
    <div class="arena-half arena-half--north" aria-hidden="true"></div>
    <div class="arena-half arena-half--south" aria-hidden="true"></div>
    <div class="lane lane--west" data-lane="west" aria-hidden="true"></div>
    <div class="lane lane--east" data-lane="east" aria-hidden="true"></div>
    <div class="river" data-ui="river" aria-hidden="true"></div>
    <div class="bridge bridge--west" data-ui="bridge" data-lane="west" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="bridge bridge--east" data-ui="bridge" data-lane="east" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="tower-pad tower-pad--north-central" data-ui="tower-pad" data-side="north" data-role="central" aria-hidden="true"><i></i></div>
    <div class="tower-pad tower-pad--north-west" data-ui="tower-pad" data-side="north" data-role="lane" data-lane="west" aria-hidden="true"><i></i></div>
    <div class="tower-pad tower-pad--north-east" data-ui="tower-pad" data-side="north" data-role="lane" data-lane="east" aria-hidden="true"><i></i></div>
    <div class="tower-pad tower-pad--south-central" data-ui="tower-pad" data-side="south" data-role="central" aria-hidden="true"><i></i></div>
    <div class="tower-pad tower-pad--south-west" data-ui="tower-pad" data-side="south" data-role="lane" data-lane="west" aria-hidden="true"><i></i></div>
    <div class="tower-pad tower-pad--south-east" data-ui="tower-pad" data-side="south" data-role="lane" data-lane="east" aria-hidden="true"><i></i></div>
  </section>
  <aside class="timer" data-ui="timer" aria-label="Tiempo restante">3:00</aside>
  <footer class="match-rail match-rail--bottom" data-ui="player-hud">
    <span class="player-mark player-mark--aqua" aria-hidden="true"></span>
    <span class="crown-track" aria-label="Tus coronas"><i></i><i></i><i></i></span>
  </footer>
  <section class="hand-tray" data-ui="hand-tray" aria-label="Tu mano">
    <div class="next-card" data-ui="next-card" aria-label="Siguiente carta"></div>
    <div class="card-slot" data-ui="card-slot" aria-label="Carta 1"></div>
    <div class="card-slot" data-ui="card-slot" aria-label="Carta 2"></div>
    <div class="card-slot" data-ui="card-slot" aria-label="Carta 3"></div>
    <div class="card-slot" data-ui="card-slot" aria-label="Carta 4"></div>
  </section>
  <section class="elixir-rail" data-ui="elixir-rail" aria-label="Energía">
    <div class="elixir-fill" aria-hidden="true"></div>
    <div class="elixir-ticks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <output aria-label="Energía disponible">5</output>
  </section>
</main>`;

export function getArenaShellMarkup() {
  return SHELL_MARKUP;
}

export function mountArenaShell(target) {
  if (
    target === null ||
    typeof target !== "object" ||
    typeof target.replaceChildren !== "function" ||
    target.ownerDocument === null ||
    typeof target.ownerDocument !== "object" ||
    typeof target.ownerDocument.createElement !== "function"
  ) {
    throw new TypeError("arena shell target must be a DOM element");
  }

  const template = target.ownerDocument.createElement("template");
  template.innerHTML = SHELL_MARKUP;
  target.replaceChildren(template.content.cloneNode(true));
  return target.firstElementChild;
}
