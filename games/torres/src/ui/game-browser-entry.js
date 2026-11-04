// Modificado para Alma, 2026-10-31: reiniciar una sesión con norte externo conserva su configuración.
// Original: Moss & Ember, ThatXliner/clash-royale-clone, commit 75d30d1 (AGPL-3.0-only).
import {
  createPlayableRoster,
  createPlayableRosterQuestionRecords,
} from "../content/playable-roster.js";
import { createSessionTroopWitness } from "../content/session-troop-roster.js";
import { createEditableGameSessionSetup } from "../content/editable-deck.js";
import { projectSessionNonUnitBattleCard } from "../content/session-card-catalog.js";
import {
  BrowserPcmAudioSink,
  createBrowserAudioContextFactoryCapability,
} from "../audio/browser-audio.js";
import {
  GAME_AUDIO_RUNTIME_MAX_ACCELERATED_CUES,
  GameAudioRuntime,
} from "../audio/game-audio-runtime.js";
import { DeckCycle } from "../sim/deck.js";
import { ElixirMatch } from "../sim/elixir.js";
import { GameSession } from "../sim/game-session.js";
import { createChainQuestionFixture } from "../sim/live-battle-chain.js";
import { mountArenaShell } from "./arena-shell.js";
import { getCombatEffectsStyleText } from "./combat-effects.js";
import { getCombatStyleText } from "./combat-state.js";
import { assertGameBrowserRootAvailable,
  checkedGameBrowserSnapshot, mountGameBrowserLoop } from "./game-browser-loop.js";
import { createGameSessionRestoreContinuation } from "./game-session-restore-continuation.js";
import {
  createArenaInputSessionContinuationCapability,
  mountArenaInputController,
  serializeArenaInputCards,
} from "./input-controller.js";
import { createGameAudioUiBridge } from "./game-audio-bridge.js";
import { mountGameAudioControls } from "./game-audio-controls.js";
import { getMatchFeedbackStyleText } from "./match-feedback.js";

const LOCAL_SIDE = "south";
const APP_FRAME_HUD_PREPARATION = new WeakMap();

/** Prepare the private, document-owned app-frame painter before mounting. */
export function prepareShippedAppFrameHud(document) {
  if (!document || typeof document.createElement !== "function") {
    return Promise.reject(new TypeError("app-frame HUD preparation requires a Document"));
  }
  const existing = APP_FRAME_HUD_PREPARATION.get(document);
  if (existing) return existing.promise;
  const entry = { factory: null, promise: null };
  entry.promise = import("./hud-card-painter.js").then(({ prepareHudCardPainter }) =>
    prepareHudCardPainter(document)).then((factory) => {
    entry.factory = factory;
    return factory;
  }, (error) => {
    APP_FRAME_HUD_PREPARATION.delete(document);
    throw error;
  });
  APP_FRAME_HUD_PREPARATION.set(document, entry);
  return entry.promise;
}

function preparedAppFrameHudFactory(document) {
  return APP_FRAME_HUD_PREPARATION.get(document)?.factory ?? null;
}

/** Return the already-prepared painter capability for this exact Document. */
export function getPreparedShippedAppFrameHud(document) {
  const factory = preparedAppFrameHudFactory(document);
  if (factory === null) {
    throw new RangeError("app-frame HUD painter is not ready for this document");
  }
  return factory;
}

/**
 * The sustained browser path is deliberately smaller than an ordinary manual
 * fast-forward. Simulation is sliced into fixed small batches below the
 * long-task cap, while input is
 * suspended and complete DOM/audio transactions are coalesced at a stable
 * presentation cadence before yielding back to real RAF.
 */
// A public three-tick GameSession slice can itself exceed the 40 ms browser
// margin under the active GH workload. Keep every simulation call to one
// explicit tick, then yield before any more work. Presentation remains on the
// separate fixed 100-tick cadence below.
export const GAME_BROWSER_ENDURANCE_MAX_CHUNK_TICKS = 1;
export const GAME_BROWSER_ENDURANCE_MAX_SEGMENT_TICKS = 300;
// Coalesce the exact GH workload into bounded, replay-derived transactions:
// three complete DOM/audio presentations per 300-tick attempt segment rather
// than allocating one after every tiny simulation slice.
export const GAME_BROWSER_ENDURANCE_PRESENTATION_TICKS = 100;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The loop validates again immediately before its atomic commit. This early,
// side-effect-free preflight avoids starting an asynchronous replay for a
// malformed browser envelope while keeping session reconstruction inside the
// bounded continuation below.
function enduranceRestoreSessionBytes(bytes) {
  return checkedGameBrowserSnapshot(bytes).session;
}

function createBulwarkNeedleSessionWitness() {
  const defaultRoster = createPlayableRoster();
  const roster = [projectSessionNonUnitBattleCard("bulwark-needle"),
    ...defaultRoster.filter(({ id }) => id !== "cinderlings")];
  if (roster.length !== 8 || new Set(roster.map(({ id }) => id)).size !== 8) {
    throw new Error("Bulwark Needle witness must contain eight unique admitted cards");
  }
  const questionKeys = [...new Set(roster.flatMap(({ entities }) => entities.flatMap((entity) =>
    [entity.bodyRadiusPolicy, entity.projectileSpeedPolicy, entity.deliveryPolicy,
      entity.layerPolicy, entity.damagePolicy]
      .filter((policy) => policy?.kind === "question")
      .map(({ questionKey }) => questionKey)
      .concat((entity.sourceConfidencePolicy?.fields ?? [])
        .map(({ questionKey }) => questionKey)))))].sort();
  const questionsByKey = new Map(createPlayableRosterQuestionRecords()
    .map((question) => [question.key, question]));
  const questions = questionKeys.map((key) => {
    const question = questionsByKey.get(key);
    if (question === undefined) throw new Error(`Bulwark Needle witness question ${key} is missing`);
    return question;
  });
  return { initialWindupTicks: { central: 0, lane: 0 }, questions, roster };
}

export function createShippedGameSessionSetup(seed = 0, profile = "standard") {
  if (profile !== "standard" && profile !== "live-seed-2-terminal" &&
      profile !== "stonehauler-witness" && profile !== "bulwark-needle-witness") {
    throw new TypeError("shipped game session profile is invalid");
  }
  const terminalProfile = profile === "live-seed-2-terminal";
  const witnessProfile = profile === "stonehauler-witness";
  const buildingWitnessProfile = profile === "bulwark-needle-witness";
  const witness = witnessProfile ? createSessionTroopWitness("stonehauler") : null;
  const buildingWitness = buildingWitnessProfile ? createBulwarkNeedleSessionWitness() : null;
  const selectedWitness = witness ?? buildingWitness;
  const roster = selectedWitness?.roster ?? createPlayableRoster();
  const questions = selectedWitness?.questions ?? createPlayableRosterQuestionRecords();
  const battleSetup = canonical({ initialWindupTicks: terminalProfile
    ? { central: 10_000, lane: 10_000 }
    : selectedWitness?.initialWindupTicks ?? { central: 0, lane: 0 },
    questions, roster });
  const deck = roster.map(({ id }) => id);
  return canonical({
    battleSetup,
    deck,
    legalNorthDeployments: (terminalProfile ? [{ id: "coilblade" }] : roster)
      .map(({ id: cardId }) => ({ cardId, point: { x: 3_500, y: 17_500 } }))
      .sort((left, right) => left.cardId.localeCompare(right.cardId)),
    rosterWitness: canonical({ questions, roster }), seed: terminalProfile ? 2 : seed,
    startingElixir: { north: 10, south: 10 },
    thinkIntervalTicks: 60,
    thinkOffsetTicks: 0,
  });
}

function sameValues(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/**
 * Input owns a local deck/elixir mirror solely to make the next physical
 * gesture legal before the session consumes it.  During a yielding segment
 * that mirror can continue from its last trusted public state instead of
 * repeatedly reconstructing an ever-longer session transcript.  The cache is
 * owned by one input-factory closure and keyed by the exact live session.
 * It is never command authority: GameInputBridge still validates/delivers to
 * GameSession. Cache use is invalidated by (1) a restore or restart session
 * identity change, (2) a rollback/non-monotonic mirror tick, and (3) any
 * public deck or elixir mismatch after the permitted tick-only catch-up. Each
 * invalidation falls back to canonical public session bytes; the WeakMap also
 * releases unreachable prior sessions with its owning graph.
 */
function matchesInputSystems(systems, state) {
  const deck = systems.deck.state;
  const expectedDeck = state.decks.south;
  const elixir = systems.elixir.state;
  const expectedElixir = state.elixir.sides.south;
  return deck.sequence === expectedDeck.sequence && deck.next === expectedDeck.next &&
    sameValues(deck.hand, expectedDeck.hand) && sameValues(deck.queue, expectedDeck.queue) &&
    elixir.tick === state.tick && elixir.sides.south.amount === expectedElixir.amount &&
    elixir.sides.south.accumulator === expectedElixir.accumulator;
}

function inputCardsForSession(session, cache) {
  const cached = cache.get(session);
  if (cached !== undefined) return cached;
  const setup = JSON.parse(session.serialize()).setup;
  const battleSetup = JSON.parse(setup.battleSetup);
  const profile = battleSetup.spellProfileReceipts?.profiles.find(({ profileId }) =>
    profileId === "squall-orb-radius-v2");
  const cards = battleSetup.roster.map((card) => ({
    areaDamageRadiusMillitiles: card.id === profile?.fact.cardId
      ? profile.fact.areaDamageRadiusMillitiles : card.areaDamageRadiusMillitiles,
    cost: card.cost,
    count: card.count,
    damage: card.damage,
    deployTimeTicks: card.deployTimeTicks,
    displayName: card.displayName,
    entities: card.entities,
    firstHitTicks: card.firstHitTicks,
    formation: card.formation,
    hitSpeedTicks: card.hitSpeedTicks,
    hitpoints: card.hitpoints,
    id: card.id,
    kind: card.kind,
    movementMillitilesPerSecond: card.movementMillitilesPerSecond,
    rangeMillitiles: card.rangeMillitiles,
    rarity: card.rarity,
    sightRangeMillitiles: card.sightRangeMillitiles,
    targetMode: card.targetMode,
  }));
  cache.set(session, cards);
  return cards;
}

function combatPolicyQuestion(session) {
  const setup = JSON.parse(session.serialize()).setup;
  const battleSetup = JSON.parse(setup.battleSetup);
  const defensive = battleSetup.roster.find(({ buildingRuntime }) =>
    buildingRuntime?.class === "defensive" &&
    buildingRuntime.policy?.disposition === "question");
  const questions = [];
  if (defensive !== undefined) {
    const fields = defensive.buildingRuntime.policy.corpusFields;
    const unverifiedFields = Object.entries(fields)
      .filter(([, record]) => record.authoritative !== true)
      .map(([field]) => field);
    questions.push({
      cardId: defensive.id,
      displayName: defensive.displayName,
      text: `${defensive.displayName} combat: QUESTION. First-hit timing is ${fields.firstHitTicks.value === null
        ? "absent" : "unverified"}; damage, HP, deploy, range and target fields are unverified.`,
      unverifiedFields,
    });
  } else if (setup.deck.includes("brackenwheel")) {
    const brackenwheel = battleSetup.roster.find(({ id }) => id === "brackenwheel");
    const meleeAreaEntity = brackenwheel?.entities.find(({ meleeAreaPolicy }) =>
      meleeAreaPolicy?.authoritative === false &&
      meleeAreaPolicy?.confidence === "question" &&
      meleeAreaPolicy?.version === "melee-area-question-v1");
    if (meleeAreaEntity === undefined) {
      throw new TypeError("Brackenwheel deck lacks its melee-area QUESTION policy");
    }
    questions.push({
      cardId: brackenwheel.id,
      displayName: brackenwheel.displayName,
      text: "Brackenwheel melee area/contact rule remains QUESTION and provisional for historical comparison.",
      unverifiedFields: ["melee-area-contact"],
    });
  }
  const stormkite = stormkitePolicyQuestion(setup, battleSetup);
  if (stormkite !== null) questions.push(stormkite);
  return questions.length === 0 ? null : questions;
}

function stormkitePolicyQuestion(setup, battleSetup) {
  if (!setup.deck.includes("stormkite")) return null;
  const policy = battleSetup.chainQuestionPolicy;
  const fixture = createChainQuestionFixture();
  if (policy?.cardId !== "stormkite" || policy.claimFamily !== "chain" ||
      policy.kind !== "execute-question-model-v1") {
    throw new TypeError("Stormkite deck lacks its admitted chain QUESTION policy");
  }
  for (const [key, record] of Object.entries(fixture)) {
    if (canonical(policy.questions?.[key]) !== canonical(record)) {
      throw new TypeError(`Stormkite chain notice diverges from its QUESTION fixture at ${key}`);
    }
  }
  const card = battleSetup.roster.find(({ id }) => id === "stormkite");
  if (card === undefined) throw new TypeError("Stormkite QUESTION card is absent from its selected roster");
  return {
    cardId: "stormkite",
    displayName: card.displayName,
    text: "Stormkite chain hops: QUESTION. Target choice, hop limits and timing remain unverified.",
    unverifiedFields: Object.keys(fixture),
  };
}

function projectCombatPolicyQuestion(questionNotice, session) {
  const policyQuestions = combatPolicyQuestion(session);
  if (questionNotice === null) {
    if (policyQuestions !== null) {
      throw new TypeError("shipped browser lacks the defensive QUESTION notice");
    }
    return null;
  }
  if (policyQuestions === null) {
    questionNotice.hidden = true;
    delete questionNotice.dataset.cardId;
    delete questionNotice.dataset.cardIds;
    delete questionNotice.dataset.disposition;
    delete questionNotice.dataset.unverifiedFields;
    questionNotice.replaceChildren();
    return null;
  }
  const unverifiedFields = [...new Set(policyQuestions.flatMap(({ unverifiedFields: fields }) => fields))];
  questionNotice.hidden = false;
  questionNotice.dataset.cardId = policyQuestions[0].cardId;
  if (policyQuestions.length > 1) {
    questionNotice.dataset.cardIds = policyQuestions.map(({ cardId }) => cardId).join(",");
  } else {
    delete questionNotice.dataset.cardIds;
  }
  questionNotice.dataset.disposition = "question";
  questionNotice.dataset.unverifiedFields = unverifiedFields.join(",");

  const document = questionNotice.ownerDocument;
  const cardNames = policyQuestions.map(({ displayName }) => {
    if (typeof displayName !== "string" || displayName.length === 0) {
      throw new TypeError("combat QUESTION notice lacks an admitted card display name");
    }
    return displayName;
  });
  const summaryText = `QUESTION · ${cardNames.join(" + ")} · Details`;
  const existingDetails = questionNotice.querySelector("details.policy-question-details");
  const existingSummary = existingDetails?.querySelector("summary");
  const existingCards = existingDetails?.querySelectorAll(".policy-question-detail-card") ?? [];
  const unchanged = existingSummary?.textContent === summaryText &&
    existingCards.length === policyQuestions.length &&
    policyQuestions.every((question, index) => {
      const item = existingCards[index];
      return item.dataset.cardId === question.cardId &&
        item.querySelector("p")?.textContent === question.text;
    });
  if (!unchanged) {
    const details = document.createElement("details");
    details.className = "policy-question-details";
    const summary = document.createElement("summary");
    summary.className = "policy-question-summary";
    summary.textContent = summaryText;
    details.append(summary);

    const detailList = document.createElement("div");
    detailList.className = "policy-question-detail-list";
    detailList.tabIndex = 0;
    detailList.setAttribute("role", "region");
    detailList.setAttribute("aria-label", `QUESTION details for ${cardNames.join(" and ")}`);
    for (const question of policyQuestions) {
      const item = document.createElement("section");
      item.className = "policy-question-detail-card";
      item.dataset.cardId = question.cardId;
      const heading = document.createElement("h2");
      heading.textContent = `${question.displayName} · QUESTION`;
      const copy = document.createElement("p");
      copy.textContent = question.text;
      item.append(heading, copy);
      detailList.append(item);
    }
    details.append(detailList);
    questionNotice.replaceChildren(details);
  }
  return policyQuestions;
}

function inputSystems(session, cards, cache) {
  const state = session.state;
  const continued = cache.get(session);
  if (continued !== undefined && continued.elixir.tick <= state.tick) {
    continued.elixir.advanceTicks(state.tick - continued.elixir.tick);
    if (matchesInputSystems(continued, state)) return continued;
  }

  const snapshot = JSON.parse(session.serialize());
  const setup = snapshot.setup;
  const costs = new Map(cards.map(({ cost, id }) => [id, cost]));
  const deck = new DeckCycle({ deck: setup.deck, seed: `${setup.seed}:${LOCAL_SIDE}` });
  const elixir = new ElixirMatch({ startingElixir: setup.startingElixir });
  const pending = new Set(state.pendingPlayerCommands.map(({ commandId }) => commandId));
  const commands = snapshot.transcript.filter(({ type }) => type === "submit")
    .map(({ command }) => command).filter(({ commandId }) => !pending.has(commandId))
    .sort((left, right) => left.tick - right.tick || left.commandId - right.commandId);
  let commandIndex = 0;
  for (let tick = 0; tick < state.tick; tick += 1) {
    const command = commands[commandIndex];
    if (command?.tick === tick) {
      if (deck.state.hand[command.slot] !== command.cardId) {
        throw new TypeError("shipped browser input deck diverges from session");
      }
      elixir.scheduleSpend(tick, LOCAL_SIDE, costs.get(command.cardId));
      deck.play(command.cardId); commandIndex += 1;
    }
    elixir.step();
  }
  const systems = { deck, elixir };
  cache.set(session, systems);
  return systems;
}

function createProjectionLayers(shell) {
  const document = shell.ownerDocument;
  const styles = document.createElement("style");
  styles.dataset.gameBrowserStyles = "";
  styles.textContent = [
    getCombatStyleText(),
    getCombatEffectsStyleText(),
    getMatchFeedbackStyleText(),
  ].join("\n");
  shell.appendChild(styles);
  const layers = {};
  for (const name of ["combat", "effects", "feedback", "hud"]) {
    const layer = document.createElement("div");
    layer.className = `game-browser-layer game-browser-layer--${name}`;
    layer.dataset.gameBrowserLayer = name;
    (name === "combat" || name === "effects"
      ? shell.querySelector('[data-ui="arena"]') : shell).appendChild(layer);
    layers[name] = layer;
  }
  return layers;
}

function createInputFactory(shell, audioUiBridge = null) {
  const inputSystemCache = new WeakMap();
  const cardsCache = new WeakMap();
  return (session, nextCommandId, selectedCardId = null, onSelection = null) => {
    const cards = inputCardsForSession(session, cardsCache);
    const cardsText = serializeArenaInputCards(cards);
    const systems = inputSystems(session, cards, inputSystemCache);
    let mounted = null;
    const updateHooks = (_selected = null, projected = systems) => {
      const slots = Array.from(shell.querySelectorAll('[data-ui="card-slot"]'));
      for (let index = 0; index < slots.length; index += 1) {
        slots[index].dataset.cardId = projected.deck.state.hand[index];
      }
      if (mounted !== null && typeof onSelection === "function") {
        onSelection(_selected, mounted, projected);
      }
    };
    updateHooks();
    mounted = mountArenaInputController(shell,
      createArenaInputSessionContinuationCapability(
      cardsText,
      systems.deck.serializeJson(),
      systems.elixir.serialize(),
      nextCommandId,
      () => {},
      updateHooks,
    ));
    if (selectedCardId !== null && systems.deck.state.hand.includes(selectedCardId)) {
      const selection = mounted.input.select(selectedCardId);
      // A remount may follow a hand change or a wallet change. In either
      // case an unavailable selection is cleared safely by the fresh input
      // controller instead of minting an invalid HUD option.
      if (selection.accepted !== true && mounted.input.selectedCardId !== null) {
        try { mounted.cleanup(); } catch {}
        throw new Error("shipped browser could not preserve selected card");
      }
    }
    if (audioUiBridge !== null) {
      try { audioUiBridge.attach(mounted); }
      catch (error) { try { mounted.cleanup(); } catch {} throw error; }
    }
    return mounted;
  };
}

function createNativeAudioContext() {
  const Constructor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (typeof Constructor !== "function") {
    throw new TypeError("this browser does not provide Web Audio");
  }
  return new Constructor();
}

export function mountShippedGameBrowser(
  root,
  scheduler,
  session = null,
  audioContextFactory = createNativeAudioContext,
  deckChoiceEnabled = false,
) {
  if (!scheduler || typeof scheduler.requestAnimationFrame !== "function" ||
      typeof scheduler.cancelAnimationFrame !== "function") {
    throw new TypeError("shipped browser scheduler is invalid");
  }
  if (typeof audioContextFactory !== "function") {
    throw new TypeError("shipped browser audio context factory is invalid");
  }
  if (typeof deckChoiceEnabled !== "boolean") {
    throw new TypeError("shipped browser deck choice option is invalid");
  }
  assertGameBrowserRootAvailable(root);
  const appFrame = root.ownerDocument?.body?.dataset?.appFrame === "true";
  const hudPainterFactory = appFrame
    ? preparedAppFrameHudFactory(root.ownerDocument)
    : null;
  if (appFrame && hudPainterFactory === null) {
    throw new RangeError("app-frame HUD painter must be prepared before mounting");
  }
  let active = true;
  let graph = null;
  let manualStepMode = false;
  let replacing = false;
  let restartCount = 0;
  let deckChoiceOpen = false;
  let deckChoiceAvailable = deckChoiceEnabled;
  let selectedDeckProfile = "standard";
  let lastSession = session ?? new GameSession(createShippedGameSessionSetup());
  let enduranceDrive = null;
  let enduranceYield = null;
  let enduranceYieldPolicy = scheduler.scheduler !== null &&
    (typeof scheduler.scheduler === "object" || typeof scheduler.scheduler === "function") &&
    typeof scheduler.scheduler.yield === "function"
    ? "raf-scheduler-yield-raf" : "raf-raf";

  const cleanup = (candidate) => {
    const errors = [];
    if (candidate === null) return errors;
    try {
      candidate.restart.removeEventListener("click", candidate.onRestart);
    } catch (error) { errors.push(error); }
    for (const [node, event, listener] of candidate.deckChoiceListeners ?? []) {
      try { node.removeEventListener(event, listener); }
      catch (error) { errors.push(error); }
    }
    try { candidate.loop?.dispose(); } catch (error) { errors.push(error); }
    try { candidate.audioUiBridge?.dispose(); } catch (error) { errors.push(error); }
    try { candidate.controls?.dispose(); } catch (error) { errors.push(error); }
    if (candidate.controls === null) {
      try { candidate.audioRuntime.dispose(); } catch (error) { errors.push(error); }
      try { candidate.browserAudio.dispose(); } catch (error) { errors.push(error); }
    }
    return errors;
  };
  const renderRestart = (candidate) => {
    if (candidate === null) return;
    const terminal = candidate.loop?.state.terminal === true;
    candidate.restart.hidden = !terminal;
    candidate.restart.setAttribute("aria-hidden", String(!terminal));
  };
  const assertActive = () => {
    if (!active || graph === null) throw new RangeError("shipped browser is disposed");
    if (replacing) throw new Error("shipped browser reentrant operation rejected");
  };
  const cancelEnduranceYield = () => {
    const pending = enduranceYield;
    if (pending === null) return false;
    enduranceYield = null;
    try {
      if (pending.frameHandle !== null) scheduler.cancelAnimationFrame(pending.frameHandle);
    } catch {}
    try {
      if (pending.secondFrameHandle !== null) {
        scheduler.cancelAnimationFrame(pending.secondFrameHandle);
      }
    } catch {}
    pending.reject(new Error("shipped browser endurance drive was cancelled"));
    return true;
  };
  const yieldToBrowser = () => new Promise((resolve, reject) => {
    if (!active || graph === null) {
      reject(new RangeError("shipped browser is disposed"));
      return;
    }
    const pending = { frameHandle: null, secondFrameHandle: null, reject };
    enduranceYield = pending;
    const complete = () => {
      if (enduranceYield !== pending) return;
      enduranceYield = null;
      resolve();
    };
    const completeOnSecondFrame = () => {
      if (enduranceYield !== pending) return;
      try {
        pending.secondFrameHandle = scheduler.requestAnimationFrame(() => {
          pending.secondFrameHandle = null;
          complete();
        });
      } catch (error) {
        if (enduranceYield === pending) enduranceYield = null;
        reject(error);
      }
    };
    try {
      pending.frameHandle = scheduler.requestAnimationFrame(() => {
        if (enduranceYield !== pending) return;
        pending.frameHandle = null;
        // RAF is scheduler authority. Chrome's task scheduler then yields an
        // event-loop/GC seam. Older or fake schedulers use one more
        // cancellable RAF. Neither value enters GameSession simulation.
        const taskScheduler = scheduler.scheduler;
        if (taskScheduler !== null &&
            (typeof taskScheduler === "object" || typeof taskScheduler === "function") &&
            typeof taskScheduler.yield === "function") {
          let yielded;
          try { yielded = taskScheduler.yield(); }
          catch (error) { if (enduranceYield === pending) enduranceYield = null; reject(error); return; }
          if (yielded === null || (typeof yielded !== "object" &&
              typeof yielded !== "function") || typeof yielded.then !== "function") {
            if (enduranceYield === pending) enduranceYield = null;
            reject(new TypeError("shipped browser scheduler yield is invalid"));
            return;
          }
          Promise.resolve(yielded).then(completeOnSecondFrame, (error) => {
            if (enduranceYield !== pending) return;
            enduranceYield = null;
            reject(error);
          });
          return;
        }
        enduranceYieldPolicy = "raf-raf";
        completeOnSecondFrame();
      });
    } catch (error) {
      if (enduranceYield === pending) enduranceYield = null;
      reject(error);
    }
  });
  const consumedRestoreCandidate = (bytes) => {
    if (typeof bytes !== "string") return null;
    try {
      const snapshot = JSON.parse(bytes);
      if (snapshot === null || Array.isArray(snapshot) ||
          typeof snapshot.session !== "string") return null;
      return GameSession.restore(snapshot.session);
    } catch {
      // The loop remains the canonical snapshot validator and will report its
      // own error without replacing either graph for malformed snapshots.
      return null;
    }
  };
  const buildGraph = (authenticSession, policy) => {
    const browserAudio = new BrowserPcmAudioSink(
      createBrowserAudioContextFactoryCapability(audioContextFactory),
    );
    const audioRuntime = new GameAudioRuntime(
      authenticSession,
      browserAudio.createRuntimeSinkCapability(),
    );
    const audioUiBridge = createGameAudioUiBridge(audioRuntime);
    let controls = null;
    let loop = null;
    let restart = null;
    let candidate = null;
    try {
      if (policy !== null) {
        audioRuntime.setGainBasisPoints(policy.gainBasisPoints);
        audioRuntime.setMuted(policy.muted);
      }
      const shell = mountArenaShell(root);
      const questionNotice = shell.querySelector('[data-ui="policy-question"]');
      projectCombatPolicyQuestion(questionNotice, authenticSession);
      const deckChoiceInertState = deckChoiceEnabled
        ? Array.from(shell.children, (node) => [node, node.inert]) : [];
      const deckChoiceOpenButton = deckChoiceEnabled
        ? shell.querySelector('[data-ui="deck-choice-open"]') : null;
      const deckChoice = deckChoiceEnabled
        ? shell.querySelector('[data-ui="deck-choice"]') : null;
      const deckChoiceButtons = deckChoiceEnabled
        ? Array.from(shell.querySelectorAll("[data-deck-choice]")) : [];
      const deckChoiceStart = deckChoiceEnabled
        ? shell.querySelector('[data-ui="deck-start"]') : null;
      if (deckChoiceEnabled && (deckChoiceOpenButton === null ||
          deckChoice === null || deckChoiceButtons.length !== 3 ||
          deckChoiceStart === null)) {
        throw new TypeError("shipped browser deck choice controls are incomplete");
      }
      const deckChoiceListeners = [];
      const listenDeckChoice = (node, event, listener) => {
        if (node === null) return;
        node.addEventListener(event, listener);
        deckChoiceListeners.push([node, event, listener]);
      };
      const syncDeckChoice = () => {
        if (!deckChoiceEnabled) return;
        deckChoiceOpenButton.hidden = !deckChoiceAvailable || deckChoiceOpen;
        deckChoiceOpenButton.setAttribute("aria-expanded", String(deckChoiceOpen));
        deckChoice.hidden = !deckChoiceOpen;
        for (const [node, wasInert] of deckChoiceInertState) {
          node.inert = wasInert || (deckChoiceOpen && node !== deckChoice);
        }
        for (const button of deckChoiceButtons) {
          button.setAttribute("aria-pressed",
            String(button.dataset.deckChoice === selectedDeckProfile));
        }
      };
      const onDeckChoiceOpen = (event) => {
        if (event?.isTrusted !== true || !active || graph !== candidate || replacing) {
          return false;
        }
        return api.openDeckChoice();
      };
      const onDeckChoiceSelect = (event) => {
        if (event?.isTrusted !== true || !active || graph !== candidate || replacing ||
            !deckChoiceOpen) return false;
        const value = event.currentTarget?.dataset?.deckChoice;
        if (value !== "standard" && value !== "stonehauler" &&
            value !== "bulwark-needle") return false;
        selectedDeckProfile = value;
        syncDeckChoice();
        return true;
      };
      const onDeckChoiceStart = (event) => {
        if (event?.isTrusted !== true || !active || graph !== candidate || replacing) {
          return false;
        }
        return api.startDeckChoice();
      };
      const onDeckChoiceKeydown = (event) => {
        if (event?.isTrusted !== true || !active || graph !== candidate || replacing ||
            !deckChoiceOpen) return false;
        if (event.key === "Escape") {
          event.preventDefault();
          deckChoiceOpen = false;
          syncDeckChoice();
          deckChoiceOpenButton.focus({ preventScroll: true });
          return true;
        }
        if (event.key !== "Tab") return false;

        const focusable = [...deckChoiceButtons, deckChoiceStart].filter((node) =>
          !node.disabled && !node.hidden && !node.inert);
        if (focusable.length === 0) return false;
        const currentIndex = focusable.indexOf(shell.ownerDocument.activeElement);
        const wrapsForward = !event.shiftKey && currentIndex === focusable.length - 1;
        const wrapsBackward = event.shiftKey && currentIndex === 0;
        const focusIsOutside = currentIndex === -1;
        if (!wrapsForward && !wrapsBackward && !focusIsOutside) return false;
        event.preventDefault();
        const next = focusable[event.shiftKey ? focusable.length - 1 : 0];
        next.focus({ preventScroll: true });
        return true;
      };
      const restarts = Array.from(shell.querySelectorAll('[data-ui="restart"]'));
      if (restarts.length !== 1 ||
          typeof restarts[0].addEventListener !== "function" ||
          typeof restarts[0].removeEventListener !== "function" ||
          typeof restarts[0].setAttribute !== "function") {
        throw new TypeError("shipped browser requires one restart control");
      }
      restart = restarts[0];
      syncDeckChoice();
      listenDeckChoice(deckChoiceOpenButton, "click", onDeckChoiceOpen);
      for (const button of deckChoiceButtons) {
        listenDeckChoice(button, "click", onDeckChoiceSelect);
      }
      listenDeckChoice(deckChoiceStart, "click", onDeckChoiceStart);
      if (deckChoiceEnabled) {
        listenDeckChoice(shell.ownerDocument, "keydown", onDeckChoiceKeydown);
      }
      controls = mountGameAudioControls(shell, browserAudio, audioRuntime, audioUiBridge);
      loop = mountGameBrowserLoop({
        createInput: createInputFactory(shell, audioUiBridge),
        ...(hudPainterFactory === null ? {} : { hudPainterFactory }),
        layers: createProjectionLayers(shell),
        root,
        scheduler: {
          cancelAnimationFrame: scheduler.cancelAnimationFrame.bind(scheduler),
          requestAnimationFrame(callback) {
            return scheduler.requestAnimationFrame((timestamp) => {
              callback(timestamp);
              audioRuntime.renderFrame();
              renderRestart(candidate);
            });
          },
        },
        session: authenticSession,
      });
      if (manualStepMode && !loop.state.terminal) loop.enterManualStepMode();
      const onRestart = (event) => {
        if (event?.isTrusted !== true || !active || graph !== candidate || replacing) {
          return false;
        }
        return api.restart();
      };
      candidate = {
        audioRuntime, audioToggle: shell.querySelector('[data-ui="audio-toggle"]'),
        audioUiBridge, browserAudio, controls, deckChoice,
        deckChoiceButtons, deckChoiceListeners, deckChoiceOpenButton, deckChoiceStart,
        loop, onRestart, restart, syncDeckChoice,
        questionNotice,
      };
      restart.addEventListener("click", onRestart);
      audioRuntime.renderFrame();
      renderRestart(candidate);
      if (deckChoiceOpen) deckChoiceButtons[0]?.focus({ preventScroll: true });
      return candidate;
    } catch (error) {
      const failed = candidate ?? {
        audioRuntime, audioUiBridge, browserAudio, controls, loop,
        deckChoiceListeners,
        onRestart() {}, restart: restart ?? { removeEventListener() {} },
      };
      cleanup(failed);
      throw error;
    }
  };
  const advanceManualSegment = (count, accelerated) => {
    const events = graph.loop.stepMany(count);
    const audio = accelerated
      ? graph.audioRuntime.renderAcceleratedFrame()
      : graph.audioRuntime.renderFrame();
    renderRestart(graph);
    return { audio, events };
  };
  const replaceMountedSession = (freshSession, failureMessage) => {
    replacing = true;
    cancelEnduranceYield();
    graph.loop.abortEnduranceSegment();
    enduranceDrive = null;
    const previous = graph;
    const policy = {
      gainBasisPoints: previous.controls.state.gainBasisPoints,
      muted: previous.controls.state.muted,
    };
    lastSession = previous.loop.session;
    graph = null;
    const cleanupErrors = cleanup(previous);
    if (cleanupErrors.length > 0) {
      active = false;
      replacing = false;
      throw new AggregateError(cleanupErrors, "shipped browser deck-choice cleanup failed");
    }
    try {
      graph = buildGraph(freshSession, policy);
      lastSession = freshSession;
      return api.state;
    } catch (error) {
      active = false;
      graph = null;
      throw new AggregateError([error], failureMessage);
    } finally {
      replacing = false;
    }
  };
  const api = Object.freeze({
    get audio() { assertActive(); return graph.controls.state; },
    get audioDiagnostics() { assertActive(); return graph.audioRuntime.state; },
    get audioMixAudit() { assertActive(); return graph.audioRuntime.mixAudit; },
    get audioPcmObservations() {
      assertActive(); return graph.browserAudio.scheduledPcmObservations;
    },
    get audioScheduledPcm() {
      assertActive(); return graph.browserAudio.scheduledPcmObservations;
    },
    // Read-only continuation witness: intentionally excludes the browser sink's
    // already-heard transaction history and reset generation, neither of which
    // can affect future deterministic audio projection after a restore.
    get audioContinuationBytes() {
      assertActive();
      const audio = graph.audioRuntime.state;
      return canonical({ cursor: audio.cursor, disposed: audio.disposed,
        gainBasisPoints: audio.gainBasisPoints, muted: audio.muted,
        sessionBytes: graph.loop.session.serialize(),
        suppressedAcceleratedCueCount: audio.suppressedAcceleratedCueCount,
        terminal: audio.terminal, version: 1 });
    },
    get enduranceYieldPolicy() { assertActive(); return enduranceYieldPolicy; },
    dispose() {
      if (!active) return false;
      if (graph === null || replacing) {
        throw new Error("shipped browser reentrant operation rejected");
      }
      // Rejecting a pending RAF yield is asynchronous.  Detach the loop's
      // endurance transaction first so loop.dispose() cannot observe a stale
      // input-suspended transaction while this public disposal continues.
      cancelEnduranceYield();
      graph.loop.abortEnduranceSegment();
      enduranceDrive = null;
      active = false;
      const current = graph;
      graph = null;
      const errors = cleanup(current);
      if (errors.length > 0) {
        throw new AggregateError(errors, "shipped browser cleanup failed");
      }
      return true;
    },
    /** Stop RAF advancement while retaining live pointer input for deterministic verification. */
    enterManualStepMode() {
      assertActive();
      const changed = graph.loop.enterManualStepMode();
      if (changed) manualStepMode = true;
      return changed;
    },
    /**
     * Advance one bounded manual segment.  This compatibility path is kept for
     * the short browser journey; sustained play uses driveEnduranceSegment().
     */
    fastForwardSegment(count) {
      assertActive();
      if (!manualStepMode || !Number.isSafeInteger(count) || count < 0 || count > 1_200) {
        throw new TypeError("shipped browser fast-forward segment is invalid");
      }
      const remaining = 18_000 - graph.loop.state.sessionTick;
      return advanceManualSegment(Math.min(count, remaining), true).events;
    },
    /**
     * Browser endurance driver: fixed one-tick simulation slices yield through real
     * RAF. Input is detached for that short segment; every 100 ticks (and the
     * terminal/final boundary) the loop atomically projects DOM and the audio runtime
     * consumes every new authority record with its bounded accelerated policy.
     * RAF is only an event-loop yield seam and never enters simulation state.
     */
    async driveEnduranceSegment(count) {
      assertActive();
      if (!manualStepMode || !Number.isSafeInteger(count) || count < 1 ||
          count > GAME_BROWSER_ENDURANCE_MAX_SEGMENT_TICKS) {
        throw new TypeError("shipped browser endurance segment is invalid");
      }
      if (enduranceDrive !== null) {
        throw new Error("shipped browser endurance drive is already active");
      }
      const token = Object.freeze({});
      enduranceDrive = token;
      const candidate = graph;
      const chunks = [];
      const initialState = candidate.loop.state;
      let currentTick = initialState.sessionTick;
      let terminal = initialState.terminal;
      let remaining = Math.min(count, 18_000 - currentTick);
      let opened = false;
      try {
        candidate.loop.beginEnduranceSegment();
        opened = true;
        let simulationSliceCount = 0;
        let simulationTickCount = 0;
        let presentationEventCount = 0;
        while (remaining > 0 && !terminal) {
          const fromTick = currentTick;
          const slice = candidate.loop.advanceEnduranceSlice(
            Math.min(GAME_BROWSER_ENDURANCE_MAX_CHUNK_TICKS, remaining,
              GAME_BROWSER_ENDURANCE_PRESENTATION_TICKS - simulationTickCount),
          );
          const advanced = slice.sessionTick - fromTick;
          if (advanced <= 0) throw new Error("shipped browser endurance segment did not advance");
          remaining -= advanced;
          currentTick = slice.sessionTick;
          terminal = slice.terminal;
          simulationSliceCount += 1;
          simulationTickCount += advanced;
          presentationEventCount += slice.events.length;
          const present = simulationTickCount >= GAME_BROWSER_ENDURANCE_PRESENTATION_TICKS ||
            remaining === 0 || slice.terminal;
          if (present) {
            // The final one-tick simulation continuation and its complete
            // 100-tick presentation are both required work, but need not run
            // in one browser task. Keep their exact simulation boundary and
            // single DOM/audio transaction intact while giving Chrome the
            // same real scheduler seam used between ordinary slices.
            await yieldToBrowser();
            const state = candidate.loop.presentEnduranceFrame();
            // Projection is one atomic same-tick DOM transaction. Its audio
            // authority transaction is equally required, but the browser may
            // schedule it in the following task without changing any
            // simulation tick, event cursor, or presentation cadence.
            await yieldToBrowser();
            const audio = candidate.audioRuntime.renderAcceleratedFrame();
            // Keep the bounded audio transaction intact, then give the
            // post-audio view bookkeeping and final input remount their own
            // browser task. No simulation or audio authority can advance
            // across this seam because the transaction remains suspended.
            await yieldToBrowser();
            renderRestart(candidate);
            chunks.push(Object.freeze({
              audio: Object.freeze({
                authorityRecordCount: audio.state.eventCount,
                audibleCueCap: GAME_AUDIO_RUNTIME_MAX_ACCELERATED_CUES,
                candidateCueCount: audio.candidateCueCount,
                cursor: audio.state.cursor,
                cueSequences: Object.freeze(audio.cues.map(({ sequence }) => sequence)),
                skippedCueCount: audio.skippedCueCount,
                startSequences: Object.freeze(audio.starts.map(({ sequence }) => sequence)),
                transactionCount: audio.state.transactionCount,
              }),
              domTick: state.domTick,
              eventCount: presentationEventCount,
              fromTick: state.sessionTick - simulationTickCount,
              sessionTick: state.sessionTick,
              simulationChunkTicks: GAME_BROWSER_ENDURANCE_MAX_CHUNK_TICKS,
              simulationSliceCount,
              simulationTickCount,
            }));
            simulationSliceCount = 0;
            simulationTickCount = 0;
            presentationEventCount = 0;
          }
          if (remaining > 0 && !slice.terminal) await yieldToBrowser();
        }
        candidate.loop.finishEnduranceSegment();
        opened = false;
        return Object.freeze({ chunks: Object.freeze(chunks), state: api.state,
          yieldPolicy: enduranceYieldPolicy });
      } finally {
        if (opened) candidate.loop.abortEnduranceSegment();
        if (enduranceDrive === token) enduranceDrive = null;
      }
    },
    pause() {
      assertActive();
      const changed = graph.loop.pause();
      graph.audioRuntime.renderFrame();
      renderRestart(graph);
      return changed;
    },
    openDeckChoice() {
      assertActive();
      if (!deckChoiceEnabled || !deckChoiceAvailable || deckChoiceOpen) return false;
      deckChoiceOpen = true;
      selectedDeckProfile = "standard";
      manualStepMode = true;
      replaceMountedSession(new GameSession(createShippedGameSessionSetup(0)),
        "shipped browser deck-choice reset failed");
      return true;
    },
    replaceDeck(deckIds) {
      assertActive();
      if (!graph.loop.state.paused) {
        throw new Error("shipped browser deck replacement requires a paused match");
      }
      const setup = createEditableGameSessionSetup(deckIds, 0);
      const currentIds = JSON.parse(graph.loop.session.serialize()).setup.deck;
      if (sameValues(currentIds, setup.deck)) return api.state;
      const state = replaceMountedSession(new GameSession(setup),
        "shipped browser custom deck mount failed");
      if (!graph.loop.state.paused) {
        graph.loop.pause();
        graph.audioRuntime.renderFrame();
        renderRestart(graph);
      }
      return state;
    },
    restart() {
      assertActive();
      if (!graph.loop.state.terminal) return false;
      replacing = true;
      cancelEnduranceYield(); graph.loop.abortEnduranceSegment(); enduranceDrive = null;
      const previous = graph;
      const audioState = previous.controls.state;
      const policy = { gainBasisPoints: audioState.gainBasisPoints, muted: audioState.muted };
      const currentSetup = JSON.parse(previous.loop.session.serialize()).setup;
      const defaultDeck = createPlayableRoster().map(({ id }) => id);
      // Alma: una sesión con norte externo (sin despliegues del bot) se reinicia con su
      // propia configuración; nunca se vuelve al bot integrado.
      const restartDefaultDeck = sameValues(currentSetup.deck, defaultDeck) &&
        currentSetup.legalNorthDeployments.length > 0;
      lastSession = previous.loop.session;
      graph = null;
      const cleanupErrors = cleanup(previous);
      if (cleanupErrors.length > 0) {
        active = false;
        replacing = false;
        throw new AggregateError(cleanupErrors, "shipped browser restart cleanup failed");
      }
      try {
        const freshSession = restartDefaultDeck
          ? new GameSession(createShippedGameSessionSetup(0))
          : new GameSession(canonical(currentSetup));
        graph = buildGraph(freshSession, policy);
        lastSession = freshSession;
        restartCount += 1;
        return api.state;
      } catch (error) {
        active = false;
        graph = null;
        throw new AggregateError([error], "shipped browser restart mount failed");
      } finally {
        replacing = false;
      }
    },
    restore(bytes) {
      assertActive();
      // Preflight before loop.restore() swaps DOM/input graph so an unseen
      // snapshot cannot be silently marked as heard by a prefix rebase.
      const candidate = consumedRestoreCandidate(bytes);
      let audioRestorePolicy = "prefix";
      if (candidate !== null) {
        try { graph.audioRuntime.assertRebaseable(candidate); }
        catch (error) {
          if (!(error instanceof RangeError)) throw error;
          // A valid restore after a fresh restart has authority this runtime
          // never observed. It must be projected silently, never relabelled
          // as already heard and never replayed into the browser sink.
          audioRestorePolicy = "silent-unseen";
        }
      }
      const state = graph.loop.restore(bytes);
      if (audioRestorePolicy === "prefix") {
        // Rebase instead of replaying a previously consumed prefix into sink.
        graph.audioRuntime.rebase(graph.loop.session);
      } else graph.audioRuntime.rebaseSilently(graph.loop.session);
      lastSession = graph.loop.session;
      projectCombatPolicyQuestion(graph.questionNotice, graph.loop.session);
      renderRestart(graph);
      return state;
    },
    /**
     * Restore a serialized browser snapshot without a synchronous transcript
     * reconstruction task. The existing session transcript remains the sole
     * authority: every replayed simulation advancement is one explicit tick,
     * and browser yields are only seams between those public operations.
     */
    async restoreEndurance(bytes) {
      assertActive();
      if (!manualStepMode) {
        throw new Error("shipped browser endurance restore requires manual step mode");
      }
      if (enduranceDrive !== null) {
        throw new Error("shipped browser endurance drive is already active");
      }
      const token = Object.freeze({});
      enduranceDrive = token;
      const candidate = graph;
      let opened = false;
      try {
        // Detach E2 input before any yielded reconstruction. The loop commits
        // the completed, byte-witnessed session directly from this same
        // transaction, so no half-restored graph becomes observable.
        candidate.loop.beginEnduranceSegment();
        opened = true;
        const continuation = createGameSessionRestoreContinuation(
          enduranceRestoreSessionBytes(bytes),
        );
        // Keep envelope/setup preflight separate from the first replay tick.
        await yieldToBrowser();
        while (!continuation.ready) {
          continuation.advance();
          // This includes the final replay operation: exact byte witnessing is
          // intentionally a later, independently yielded transaction.
          await yieldToBrowser();
        }
        continuation.finalize();
        await yieldToBrowser();

        let audioRestorePolicy = "prefix";
        try { candidate.audioRuntime.assertRebaseable(continuation.session); }
        catch (error) {
          if (!(error instanceof RangeError)) throw error;
          audioRestorePolicy = "silent-unseen";
        }
        await yieldToBrowser();

        const capability = candidate.loop.prepareEnduranceRestore(bytes, continuation);
        const state = candidate.loop.commitEnduranceRestore(bytes, capability);
        opened = false;
        if (audioRestorePolicy === "prefix") {
          candidate.audioRuntime.rebase(candidate.loop.session);
        } else candidate.audioRuntime.rebaseSilently(candidate.loop.session);
        lastSession = candidate.loop.session;
      projectCombatPolicyQuestion(candidate.questionNotice, candidate.loop.session);
        renderRestart(candidate);
        return state;
      } finally {
        if (opened) candidate.loop.abortEnduranceSegment();
        if (enduranceDrive === token) enduranceDrive = null;
      }
    },
    resume() {
      assertActive();
      const changed = graph.loop.resume();
      graph.audioRuntime.renderFrame();
      renderRestart(graph);
      return changed;
    },
    setAudioGainBasisPoints(value) {
      assertActive();
      return graph.controls.setGainBasisPoints(value);
    },
    startDeckChoice() {
      assertActive();
      if (!deckChoiceEnabled || !deckChoiceOpen) return false;
      deckChoiceOpen = false;
      deckChoiceAvailable = false;
      const focusMatchControl = () => {
        const control = graph?.audioToggle;
        if (control !== null && control !== undefined && !control.hidden && !control.inert) {
          control.focus({ preventScroll: true });
        }
      };
      if (selectedDeckProfile === "standard") {
        manualStepMode = false;
        graph.syncDeckChoice();
        const started = graph.loop.start();
        focusMatchControl();
        return started;
      }
      const witnessProfile = selectedDeckProfile === "stonehauler"
        ? "stonehauler-witness" : "bulwark-needle-witness";
      manualStepMode = false;
      replaceMountedSession(
        new GameSession(createShippedGameSessionSetup(1, witnessProfile)),
        `shipped browser ${selectedDeckProfile} deck mount failed`,
      );
      focusMatchControl();
      return true;
    },
    serialize() { assertActive(); return graph.loop.serialize(); },
    get session() { return graph?.loop.session ?? lastSession; },
    start() {
      assertActive();
      const changed = graph.loop.start();
      if (changed) manualStepMode = false;
      return changed;
    },
    get state() {
      if (graph === null) return Object.freeze({ active: false, restartCount });
      return Object.freeze({ ...graph.loop.state, restartCount });
    },
    advanceTerminalPresentation(count = 1) {
      assertActive();
      return graph.loop.advanceTerminalPresentation(count);
    },
    stepMany(count = 1) {
      assertActive();
      return advanceManualSegment(count, false).events;
    },
  });
  try {
    graph = buildGraph(lastSession, null);
  } catch (error) {
    active = false;
    throw error;
  }
  return api;
}
