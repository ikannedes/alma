/**
 * Dependency-injected deployment seam shared by the public helper facade and
 * the session ownership kernel. Keeping the authority identities as lexical
 * inputs avoids an import cycle while preserving the exact prototype checks.
 */
export function createStageSideDeployment({
  DeckCycle,
  ElixirMatch,
  LiveBattle,
  SessionCardRuntime,
  evaluateDeployment,
  isAuthenticSessionCardRuntime,
}) {
  return function stageSideDeployment(
    {
      battle,
      cardCosts,
      command,
      deck,
      elixir,
      deploymentSequence,
      sessionCards,
    },
  ) {
    const hasSessionCards = isAuthenticSessionCardRuntime(sessionCards) &&
      Object.getPrototypeOf(sessionCards) === SessionCardRuntime.prototype;
    if (
      Object.getPrototypeOf(battle) !== LiveBattle.prototype ||
      Object.getPrototypeOf(deck) !== DeckCycle.prototype ||
      Object.getPrototypeOf(elixir) !== ElixirMatch.prototype ||
      !(cardCosts instanceof Map) ||
      (sessionCards !== undefined && !hasSessionCards)
    ) {
      throw new TypeError("side deployment requires exact session systems");
    }
    const { cardId, commandId, destination = null, point, side, slot, target, tick } = command;
    if (
      !Number.isSafeInteger(commandId) || commandId < 0 ||
      !Number.isSafeInteger(slot) || slot < 0 || slot > 3 ||
      !Number.isSafeInteger(tick) || tick !== battle.state.tick ||
      !["north", "south"].includes(side) ||
      typeof cardId !== "string" || point === null ||
      typeof point !== "object" ||
      !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
      !Number.isSafeInteger(deploymentSequence) || deploymentSequence < 0
    ) {
      throw new TypeError("side deployment command is invalid or stale");
    }
    if (
      destination !== null &&
      (!destination || typeof destination !== "object" ||
        !Number.isSafeInteger(destination.x) ||
        !Number.isSafeInteger(destination.y))
    ) {
      throw new TypeError("side deployment destination is invalid");
    }
    const cost = cardCosts.get(cardId);
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > 10) {
      throw new TypeError("side deployment card is not in the admitted roster");
    }
    if (deck.state.hand[slot] !== cardId) {
      throw new RangeError("side deployment card does not match its hand slot");
    }
    const admittedCard = hasSessionCards
      ? sessionCards.card(cardId)
      : { kind: "unit", placementClass: "ground_entity" };
    const hasSourcedSpellProfile = admittedCard.kind === "effect" && battle.hasSpellProfile(cardId);
    const hasRadiusSpellProfile = hasSourcedSpellProfile && battle.hasRadiusSpellProfile(cardId);
    const effectQuestion = admittedCard.kind === "effect"
      ? battle.getSpellProfileQuestion(cardId)
      : null;
    if (effectQuestion !== null) {
      throw new RangeError(`side deployment effect ${effectQuestion.cardId} remains an explicit QUESTION (${effectQuestion.id}): ${effectQuestion.reason}`);
    }
    if ((!hasSourcedSpellProfile && target !== undefined) ||
        (hasSourcedSpellProfile && (hasRadiusSpellProfile ? target !== undefined : target === undefined))) {
      throw new TypeError(hasRadiusSpellProfile
        ? "radius spell placement accepts a trusted center without a target"
        : "direct-target spell placement requires one sourced shared unit target");
    }
    const placement = evaluateDeployment({
      destroyedOpposingLaneTowers: [],
      placementClass: admittedCard.placementClass,
      point,
      side,
    });
    if (!placement.legal) {
      throw new RangeError("side deployment is illegal: " + placement.reason);
    }
    const spendSequence = elixir.scheduleSpend(tick, side, cost);
    const cycle = deck.play(cardId);
    if (!cycle.accepted || cycle.slot !== slot) {
      throw new Error("prevalidated side deployment failed to cycle its deck");
    }
    const route = hasSessionCards
      ? sessionCards.route(JSON.stringify(hasSourcedSpellProfile && !hasRadiusSpellProfile
        ? { cardId, commandId, point, sequence: deploymentSequence, side, target, tick }
        : { cardId, commandId, point, sequence: deploymentSequence, side, tick }))
      : null;
    const structureMaterializes = admittedCard.kind === "structure" &&
      battle.supportsStructureRuntime(cardId);
    if (admittedCard.kind === "unit") {
      battle.scheduleDeploy(JSON.stringify({
        cardId,
        point: { x: point.x, y: point.y },
        sequence: deploymentSequence,
        side,
        tick,
      }));
    } else if (structureMaterializes) {
      battle.scheduleStructure(JSON.stringify({
        cardId,
        destination: destination === null ? null : { x: destination.x, y: destination.y },
        point: { x: point.x, y: point.y },
        sequence: deploymentSequence,
        side,
        tick,
      }));
    } else if (hasSourcedSpellProfile) {
      const spellIntent = battle.scheduleSpell({ cardId, point: { x: point.x, y: point.y },
        sequence: deploymentSequence, side, ...(target === undefined ? {} : { target: { ...target } }), tick });
      const staged = {
        cardId,
        commandId,
        cost,
        cycle: Object.freeze(cycle),
        deploymentSequence,
        destination: null,
        kind: admittedCard.kind,
        point: Object.freeze({ ...point }),
        route,
        side,
        spendSequence,
        spellIntent,
        structureMaterializes,
        tick,
        type: "side-deployment-staged",
      };
      return Object.freeze(staged);
    }
    const legacy = {
      cardId,
      commandId,
      cost,
      cycle: Object.freeze(cycle),
      deploymentSequence,
      point: Object.freeze({ ...point }),
      side,
      spendSequence,
      tick,
      type: "side-deployment-staged",
    };
    if (!hasSessionCards) return Object.freeze(legacy);
    return Object.freeze({
      cardId,
      commandId,
      cost,
      cycle: Object.freeze(cycle),
      deploymentSequence,
      destination: destination === null
        ? null
        : Object.freeze({ ...destination }),
      kind: admittedCard.kind,
      point: Object.freeze({ ...point }),
      route,
      side,
      spendSequence,
      structureMaterializes,
      tick,
      type: "side-deployment-staged",
    });
  };
}
