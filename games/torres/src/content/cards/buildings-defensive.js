import { evaluateDeployment } from "../../sim/deployment.js";
import { AttackCycle } from "../../sim/attack-cycle.js";
import { AreaDamageSystem } from "../../sim/area-damage.js";
import { ProjectileCombat } from "../../sim/projectile.js";
import { retainOrAcquireTarget, targetCandidate } from "../../sim/targeting.js";
import { createCardCatalog } from "../schema.js";
import {
  ConsecutiveTargetRampEncounter,
  createRampFixture,
} from "./special-combat-ramp.js";
import {
  InvisibilityRevealEncounter,
  createInvisibilityFixture,
} from "./combat-status-invisibility.js";

const SOURCE = "pre-evolutions-building-corpus-and-unsourced-policy-fixture";
const FIXTURE = "defensive-building-encounter-v1";
const MAX_BUILDINGS = 16;
const MAX_TARGETS = 64;
const MAX_COMMANDS = 256;
const MAX_TICK = 4096;
const MAX_STEP_CHUNK = 4096;
const MAX_HEALTH = 1_000_000;
const MAX_POSITION = 1_000_000;
const MAX_RADIUS = 100_000;
const MAX_SNAPSHOT_BYTES = 1_048_576;
const PROJECTILE_SPEED = 3000;
const PROJECTILE_RADIUS = 0;

const ARCHETYPES = Object.freeze({
  "bulwark-needle": Object.freeze({
    areaDamageRadiusMillitiles: null,
    corpusFirstHitTicks: null,
    cost: 3, damage: 212, deployTicks: 60, firstHitTicks: 0,
    hitSpeedTicks: 54, hitpoints: 824, lifetimeTicks: 1800,
    maxRange: 5500, minRange: 0, mode: "ground", rarity: "standard",
    sightRange: 5500, stages: Object.freeze([212]), thresholds: Object.freeze([0]),
    variant: "plain",
  }),
  "ember-basin": Object.freeze({
    areaDamageRadiusMillitiles: 1000,
    cost: 4, damage: 222, deployTicks: 60, firstHitTicks: 66,
    hitSpeedTicks: 96, hitpoints: 1356, lifetimeTicks: 1800,
    maxRange: 6000, minRange: 0, mode: "ground", rarity: "uncommon",
    sightRange: 6000, stages: Object.freeze([222]), thresholds: Object.freeze([0]),
    variant: "splash",
  }),
  "prism-furnace": Object.freeze({
    areaDamageRadiusMillitiles: null,
    cost: 5, damage: 42, deployTicks: 60, firstHitTicks: 72,
    hitSpeedTicks: 24, hitpoints: 1749, lifetimeTicks: 1800,
    maxRange: 6000, minRange: 0, mode: "air_and_ground", rarity: "uncommon",
    sightRange: 6000, stages: Object.freeze([42, 84, 168]),
    thresholds: Object.freeze([0, 2, 4]), variant: "ramp",
  }),
  "buried-coil": Object.freeze({
    areaDamageRadiusMillitiles: null,
    cost: 4, damage: 230, deployTicks: 60, firstHitTicks: 42,
    hitSpeedTicks: 72, hitpoints: 1152, lifetimeTicks: 1800,
    maxRange: 5500, minRange: 0, mode: "air_and_ground", rarity: "standard",
    sightRange: 5500, stages: Object.freeze([230]), thresholds: Object.freeze([0]),
    variant: "hidden",
  }),
  "horizon-caster": Object.freeze({
    areaDamageRadiusMillitiles: null,
    cost: 4, damage: 266, deployTicks: 210, firstHitTicks: 240,
    hitSpeedTicks: 300, hitpoints: 1369, lifetimeTicks: 1800,
    maxRange: 11500, minRange: 3000, mode: "ground", rarity: "standard",
    sightRange: 11500, stages: Object.freeze([266]), thresholds: Object.freeze([0]),
    variant: "siege",
  }),
});

const CARD_DEFINITIONS = Object.entries(ARCHETYPES).map(([id, value]) => ({
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: value.cost,
  count: 1,
  damage: value.damage,
  deployTimeTicks: value.deployTicks,
  displayName: ({
    "bulwark-needle": "Bulwark Needle",
    "ember-basin": "Ember Basin",
    "prism-furnace": "Prism Furnace",
    "buried-coil": "Buried Coil",
    "horizon-caster": "Horizon Caster",
  })[id],
  firstHitTicks: Object.hasOwn(value, "corpusFirstHitTicks")
    ? value.corpusFirstHitTicks
    : value.firstHitTicks,
  hitSpeedTicks: value.hitSpeedTicks,
  hitpoints: value.hitpoints,
  id,
  kind: "structure",
  movementMillitilesPerSecond: 0,
  rangeMillitiles: value.maxRange,
  rarity: value.rarity,
  sightRangeMillitiles: value.sightRange,
  targetMode: value.mode === "air_and_ground" ? "ground-and-air" : value.mode,
}));

const QUESTION_VALUES = Object.freeze({
  attackContactPolicy: "canonical-static-projectile-launch-then-contact",
  attackTimingPolicy: "deploy-then-first-windup-then-fixed-cadence",
  commandOrderingPolicy: "commands-then-lifetime-then-reveal-targeting-then-attack",
  hiddenInitialPolicy: "concealed-and-untargetable-until-an-eligible-target-is-in-sight",
  hiddenReconcealPolicy: "reconceal-on-first-boundary-with-no-eligible-target",
  hiddenRevealAttackBoundary: "reveal-and-begin-windup-on-the-same-integer-boundary",
  lifetimeDestructionBoundary: "alive-before-and-destroyed-at-placement-plus-1800-ticks",
  lifetimeTicks: 1800,
  placementPolicy: "ordinary-ground-entity-mask-at-the-building-center",
  plainFirstHitTicks: 0,
  rampDamageProgression: Object.freeze([42, 84, 168]),
  rampResetPolicy: "target-loss-change-or-death-resets-before-that-boundarys-attack",
  rampSplashCoupling: "ramp-is-single-target-and-splash-does-not-ramp",
  rampStageThresholds: Object.freeze([0, 2, 4]),
  siegeMaximumBoundary: "inclusive-edge-to-edge-11500-millitiles",
  siegeMinimumBoundary: "inclusive-at-3000-millitiles-with-smaller-distances-dead",
  siegeMinimumRangeMillitiles: 3000,
  splashDamagePolicy: "full-damage-to-each-living-target-in-the-impact-circle",
  splashRadiusBoundary: "inclusive-circle-overlap-at-1000-millitiles",
  splashRadiusMillitiles: 1000,
  stableDeathOrdering: "ascending-positive-entity-id-after-simultaneous-damage",
  targetModePolicy: "ground-air-and-structure-eligibility-follows-corpus-target-mode",
  targetRetentionPolicy: "retain-while-eligible-and-in-range-otherwise-nearest-then-lowest-id",
});

const CORPUS_FIELDS = Object.freeze([
  "cost", "damage", "deployTicks", "firstHitTicks", "hitSpeedTicks",
  "hitpoints", "maxRange", "mode", "sightRange",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactRecord(value, keys, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => (
      typeof key !== "string" || !keys.includes(key) ||
      !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")
    ))
  ) throw new TypeError(`${label} has an invalid shape`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, label, maximum) {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) throw new TypeError(`${label} must be a bounded plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some((index) =>
      !descriptors[index]?.enumerable || !Object.hasOwn(descriptors[index], "value"))
  ) throw new TypeError(`${label} must contain dense data properties`);
  return Array.from({ length: value.length }, (_, index) => descriptors[index].value);
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
}

function position(value, label) {
  const checked = exactRecord(value, ["x", "y"], label);
  integer(checked.x, `${label}.x`, -MAX_POSITION, MAX_POSITION);
  integer(checked.y, `${label}.y`, -MAX_POSITION, MAX_POSITION);
  return { x: checked.x, y: checked.y };
}

function checkedBuildings(value) {
  const result = denseArray(value, "defensive buildings", MAX_BUILDINGS)
    .map((entry, index) => {
      const item = exactRecord(entry, [
        "archetypeId", "destroyedOpposingLaneTowers", "id", "position", "side",
      ], `defensive building ${index}`);
      integer(item.id, `defensive building ${index}.id`, 1);
      if (!Object.hasOwn(ARCHETYPES, item.archetypeId)) {
        throw new TypeError(`defensive building ${index}.archetypeId is invalid`);
      }
      const placement = evaluateDeployment({
        destroyedOpposingLaneTowers: denseArray(
          item.destroyedOpposingLaneTowers,
          `defensive building ${index}.destroyedOpposingLaneTowers`,
          2,
        ),
        placementClass: "ground_entity",
        point: position(item.position, `defensive building ${index}.position`),
        side: item.side,
      });
      if (!placement.legal) {
        throw new TypeError(`defensive building ${index} placement is illegal: ${placement.reason}`);
      }
      return {
        archetypeId: item.archetypeId,
        destroyedOpposingLaneTowers: clone(item.destroyedOpposingLaneTowers),
        id: item.id,
        placement,
        position: clone(item.position),
        side: item.side,
      };
    }).sort((a, b) => a.id - b.id);
  const ids = new Set();
  for (const item of result) {
    if (ids.has(item.id)) throw new TypeError("defensive buildings must have unique IDs");
    ids.add(item.id);
  }
  return result;
}

function checkedTargets(value) {
  const result = denseArray(value, "defensive targets", MAX_TARGETS)
    .map((entry, index) => {
      const item = exactRecord(entry, [
        "health", "id", "kind", "layer", "position", "radius", "targetable",
      ], `defensive target ${index}`);
      integer(item.id, `defensive target ${index}.id`, 1);
      integer(item.health, `defensive target ${index}.health`, 1, MAX_HEALTH);
      integer(item.radius, `defensive target ${index}.radius`, 0, MAX_RADIUS);
      targetCandidate({
        alive: true, id: item.id, kind: item.kind, layer: item.layer,
        position: position(item.position, `defensive target ${index}.position`),
        radius: item.radius, targetable: item.targetable,
      });
      return {
        alive: true, health: item.health, id: item.id, hidden: false,
        kind: item.kind, layer: item.layer, position: clone(item.position),
        radius: item.radius, targetable: item.targetable,
      };
    }).sort((a, b) => a.id - b.id);
  const ids = new Set();
  for (const item of result) {
    if (ids.has(item.id)) throw new TypeError("defensive targets must have unique IDs");
    ids.add(item.id);
  }
  return result;
}

const COMMAND_TYPES = new Set([
  "damage-building", "damage-target", "hide-target", "move-target", "reveal-target",
]);

function checkedCommands(value, buildingIds, targetIds) {
  const result = denseArray(value, "defensive commands", MAX_COMMANDS)
    .map((entry, index) => {
      const item = exactRecord(entry, [
        "amount", "buildingId", "position", "targetId", "tick", "type",
      ], `defensive command ${index}`);
      integer(item.tick, `defensive command ${index}.tick`, 0, MAX_TICK - 1);
      if (!COMMAND_TYPES.has(item.type)) {
        throw new TypeError(`defensive command ${index}.type is invalid`);
      }
      if (item.type === "damage-building") {
        integer(item.amount, `defensive command ${index}.amount`, 1, MAX_HEALTH);
        integer(item.buildingId, `defensive command ${index}.buildingId`, 1);
        if (!buildingIds.has(item.buildingId)) throw new TypeError("unknown building ID");
        if (item.targetId !== null || item.position !== null) throw new TypeError("inapplicable command field");
      } else {
        integer(item.targetId, `defensive command ${index}.targetId`, 1);
        if (!targetIds.has(item.targetId)) throw new TypeError("unknown target ID");
        if (item.buildingId !== null) throw new TypeError("inapplicable command field");
        if (item.type === "damage-target") {
          integer(item.amount, `defensive command ${index}.amount`, 1, MAX_HEALTH);
          if (item.position !== null) throw new TypeError("inapplicable command field");
        } else if (item.type === "move-target") {
          if (item.amount !== null) throw new TypeError("inapplicable command field");
          position(item.position, `defensive command ${index}.position`);
        } else if (item.amount !== null || item.position !== null) {
          throw new TypeError("inapplicable command field");
        }
      }
      return clone(item);
    });
  let prior = -1;
  for (const item of result) {
    if (item.tick < prior) throw new TypeError("defensive commands must be ordered by tick");
    prior = item.tick;
  }
  return result;
}

function checkedSetup(value) {
  const setup = exactRecord(value, ["buildings", "commands", "targets"], "defensive setup");
  const buildings = checkedBuildings(setup.buildings);
  const targets = checkedTargets(setup.targets);
  const commands = checkedCommands(
    setup.commands,
    new Set(buildings.map(({ id }) => id)),
    new Set(targets.map(({ id }) => id)),
  );
  return { buildings, commands, targets };
}

function initialState(setup) {
  const area = new AreaDamageSystem();
  for (const target of setup.targets) {
    area.add(target.id, MAX_HEALTH, target.health);
  }
  return {
    areaDamageEvents: [],
    areaDamagePrimitive: area.serialize(),
    buildings: setup.buildings.map((item) => {
      const archetype = ARCHETYPES[item.archetypeId];
      return {
        alive: true, archetypeId: item.archetypeId, attackSequence: 0,
        consecutiveHits: 0, deathReason: null, health: archetype.hitpoints,
        hidden: archetype.variant === "hidden", id: item.id,
        placement: clone(item.placement), position: clone(item.position),
        rampEvents: [], rampPrimitive: null,
        side: item.side, stageIndex: 0, targetable: archetype.variant !== "hidden",
        targetId: null, visibilityPrimitive: archetype.variant === "hidden"
          ? visibilitySnapshot()
          : null,
        visibilityEvents: [],
      };
    }),
    commandIndex: 0,
    history: [],
    nextProjectileId: 1,
    projectiles: [],
    targets: clone(setup.targets),
    tick: 0,
  };
}

function circleWithin(origin, target, range) {
  const dx = BigInt(origin.x) - BigInt(target.position.x);
  const dy = BigInt(origin.y) - BigInt(target.position.y);
  const reach = BigInt(range + target.radius);
  return dx * dx + dy * dy <= reach * reach;
}

function candidateOf(target) {
  return {
    alive: target.alive, id: target.id, kind: target.kind, layer: target.layer,
    position: target.position, radius: target.radius,
    targetable: target.targetable && !target.hidden,
  };
}

function eligibleCandidates(building, targets, archetype) {
  return targets.filter((target) => (
    target.alive && target.targetable && !target.hidden &&
    circleWithin(building.position, target, archetype.maxRange) &&
    !(
      archetype.minRange > 0 &&
      circleWithin(building.position, target, archetype.minRange - 1)
    )
  ));
}

function destroyBuilding(state, building, reason) {
  if (!building.alive) return;
  if (building.rampPrimitive !== null) {
    const ramp = ConsecutiveTargetRampEncounter.restore(building.rampPrimitive);
    if (ramp.state.targetId !== null) {
      rebuildRampPrimitive(
        building,
        { targetId: null, tick: state.tick, type: "target-lost" },
        state.tick,
      );
    }
  }
  building.alive = false;
  building.health = 0;
  building.hidden = false;
  building.targetable = false;
  building.targetId = null;
  building.stageIndex = 0;
  building.consecutiveHits = 0;
  building.deathReason = reason;
  state.history.push({
    buildingId: building.id, reason, tick: state.tick, type: "building-destroyed",
  });
}

function visibilitySnapshot(commands = [], tick = 0) {
  const target = {
    alive: true, health: MAX_HEALTH, id: 1, kind: "structure", layer: "ground",
    position: { x: 0, y: 0 }, radius: 0,
  };
  const primitive = new InvisibilityRevealEncounter(
    createInvisibilityFixture([target], commands),
  );
  primitive.stepMany(tick);
  return primitive.serialize();
}

function setBuildingVisibility(state, building, visible) {
  let primitive = InvisibilityRevealEncounter.restore(building.visibilityPrimitive);
  const canonicalVisible = primitive.state.targets[0].visible;
  if (canonicalVisible !== visible) {
    const prior = JSON.parse(building.visibilityPrimitive);
    const commands = prior.identity.commands.concat({
      sourceId: visible ? 2 : 1,
      targetId: 1,
      tick: state.tick,
      type: visible ? "reveal" : "hide",
    });
    primitive = InvisibilityRevealEncounter.restore(
      visibilitySnapshot(commands, state.tick),
    );
  }
  if (primitive.state.tick !== state.tick) {
    throw new TypeError("building visibility primitive tick is misaligned");
  }
  primitive.step();
  const resolvedVisible = primitive.state.targets[0].visible;
  building.visibilityPrimitive = primitive.serialize();
  building.visibilityEvents = primitive.replay;
  const hidden = !resolvedVisible;
  if (hidden === building.hidden) return;
  building.hidden = hidden;
  building.targetable = resolvedVisible;
  state.history.push({
    buildingId: building.id, tick: state.tick,
    type: hidden ? "building-hidden" : "building-revealed",
  });
}

function areaCandidates(state) {
  return state.targets.map((target) => candidateOf(target));
}

function resolveAreaDamage(
  state, building, center, radius, amount, mode,
  candidates = areaCandidates(state), expose = true,
) {
  const area = AreaDamageSystem.restore(state.areaDamagePrimitive);
  const result = area.resolve({
    center, damage: amount, mode, radius, tick: state.tick,
  }, candidates);
  state.areaDamagePrimitive = area.serialize();
  state.areaDamageEvents.push(...clone(result.events));
  for (const event of result.events) {
    if (event.type === "damage") {
      const target = state.targets.find(({ id }) => id === event.targetId);
      target.health = event.currentHealthAfter;
      if (expose) state.history.push({
        amount: event.amount, buildingId: building.id,
        healthAfter: event.currentHealthAfter,
        healthBefore: event.currentHealthBefore,
        targetId: event.targetId, tick: state.tick, type: "damage",
      });
    } else if (event.type === "death") {
      const target = state.targets.find(({ id }) => id === event.targetId);
      target.alive = false;
      if (expose) state.history.push({
        targetId: event.targetId, tick: state.tick, type: "target-destroyed",
      });
    }
  }
  return result;
}

function projectileSetup(building, target, archetype) {
  return {
    entities: [
      {
        attackRange: archetype.maxRange, id: 1, kind: "structure",
        layer: "ground", maxHealth: archetype.hitpoints,
        position: building.position, radius: 0, targetMode: archetype.mode,
        targetable: true,
      },
      {
        attackRange: 0, id: 2, kind: target.kind, layer: target.layer,
        maxHealth: target.health, position: target.position, radius: target.radius,
        targetMode: "none", targetable: true,
      },
      {
        attackRange: 0, id: 3, kind: "structure", layer: "ground",
        maxHealth: 1, position: target.position, radius: 0,
        targetMode: "air_and_ground", targetable: true,
      },
    ],
  };
}

function launchProjectile(state, building, target, archetype, amount, sequence, stageIndex) {
  const combat = new ProjectileCombat(projectileSetup(building, target, archetype));
  const canonical = combat.launch({
    attackerId: 1, damage: amount, radius: PROJECTILE_RADIUS,
    speed: PROJECTILE_SPEED, targetId: 2, tick: 0,
  });
  const projectileId = state.nextProjectileId++;
  state.projectiles.push({
    amount, buildingId: building.id, combat: combat.serialize(),
    canonicalEvents: combat.replay, cancellationInjected: false,
    impactTick: state.tick + canonical.impactTick, launchTick: state.tick,
    launchHealth: target.health, projectileId, sequence, stageIndex,
    resolvedTick: null, status: "pending", targetId: target.id,
    targetPosition: canonical.targetPosition,
  });
  state.history.push({
    amount, buildingId: building.id, impactTick: state.tick + canonical.impactTick,
    projectileId, sequence, stageIndex, targetId: target.id,
    tick: state.tick, type: "projectile-launched",
  });
}

function rebuildRampPrimitive(building, command, tick) {
  const commands = building.rampPrimitive === null
    ? []
    : JSON.parse(building.rampPrimitive).identity.commands;
  const primitive = new ConsecutiveTargetRampEncounter(createRampFixture([
    ...commands, command,
  ]));
  primitive.stepMany(tick);
  building.rampPrimitive = primitive.serialize();
  building.rampEvents = primitive.replay;
}

function advanceRampPrimitive(building, tick) {
  if (building.rampPrimitive === null) return [];
  const primitive = ConsecutiveTargetRampEncounter.restore(building.rampPrimitive);
  if (primitive.state.tick !== tick) {
    throw new TypeError("building ramp primitive tick is misaligned");
  }
  const events = primitive.step();
  building.rampPrimitive = primitive.serialize();
  building.rampEvents = primitive.replay;
  building.consecutiveHits = primitive.state.consecutiveContacts;
  building.stageIndex = primitive.state.stageIndex;
  return events;
}

function resolveProjectiles(state, commands, rampEvents) {
  for (const flight of state.projectiles) {
    if (flight.status !== "pending") continue;
    const target = state.targets.find(({ id }) => id === flight.targetId);
    const combat = ProjectileCombat.restore(flight.combat);
    const relativeTick = state.tick - flight.launchTick;
    const lethalNextCommand = commands.slice(state.commandIndex).find((command) => (
      command.tick === state.tick + 1 &&
      command.type === "damage-target" &&
      command.targetId === flight.targetId &&
      command.amount >= target.health
    ));
    if (
      !flight.cancellationInjected &&
      ((!target?.alive && relativeTick < flight.impactTick - flight.launchTick) ||
        (lethalNextCommand !== undefined && state.tick < flight.impactTick))
    ) {
      combat.launch({
        attackerId: 3, damage: flight.launchHealth, radius: 0,
        speed: 1, targetId: 2, tick: combat.state.tick,
      });
      flight.cancellationInjected = true;
    }
    if (combat.state.tick !== relativeTick) {
      throw new TypeError("building projectile primitive tick is misaligned");
    }
    const boundaryEvents = combat.step(relativeTick);
    flight.combat = combat.serialize();
    flight.canonicalEvents = combat.replay;
    const canonicalImpact = boundaryEvents.find(
      (event) => event.type === "impact" && event.projectileId === 1,
    );
    if (canonicalImpact === undefined) continue;
    flight.resolvedTick = state.tick;
    flight.status = canonicalImpact.status;
    state.history.push({
      projectileId: flight.projectileId,
      status: canonicalImpact.status,
      targetId: flight.targetId, tick: state.tick, type: "projectile-impact",
    });
    if (canonicalImpact.status !== "contact") continue;
    const building = state.buildings.find(({ id }) => id === flight.buildingId);
    if (ARCHETYPES[building.archetypeId].variant === "splash") {
      resolveAreaDamage(
        state, building, flight.targetPosition,
        ARCHETYPES[building.archetypeId].areaDamageRadiusMillitiles,
        flight.amount, ARCHETYPES[building.archetypeId].mode,
      );
    } else {
      resolveAreaDamage(
        state, building, target.position, 0, flight.amount,
        ARCHETYPES[building.archetypeId].mode,
      );
    }
    if (
      ARCHETYPES[building.archetypeId].variant === "ramp" &&
      building.targetId === flight.targetId
    ) {
      const canonical = rampEvents.get(building.id)?.find(
        (event) => event.type === "damage" && event.targetId === flight.targetId,
      );
      if (canonical === undefined) {
        throw new TypeError("building ramp primitive did not resolve causally");
      }
      state.history.push({
        buildingId: building.id,
        consecutiveContacts: building.consecutiveHits,
        primitiveAmount: canonical.amount,
        stageIndex: building.stageIndex, targetId: flight.targetId,
        tick: state.tick, type: "ramp-contact",
      });
    }
  }
}

function applyCommands(state, commands) {
  while (
    state.commandIndex < commands.length &&
    commands[state.commandIndex].tick === state.tick
  ) {
    const command = commands[state.commandIndex++];
    if (command.type === "damage-building") {
      const building = state.buildings.find(({ id }) => id === command.buildingId);
      if (building.alive) {
        building.health = Math.max(0, building.health - command.amount);
        state.history.push({
          amount: command.amount, buildingId: building.id, tick: state.tick,
          type: "building-damaged",
        });
        if (building.health === 0) destroyBuilding(state, building, "damage");
      }
    } else {
      const target = state.targets.find(({ id }) => id === command.targetId);
      if (command.type === "damage-target" && target.alive) {
        const wasAlive = target.alive;
        resolveAreaDamage(
          state,
          { id: 0 },
          target.position,
          0,
          command.amount,
          "air_and_ground",
          [candidateOf(target)],
          false,
        );
        if (wasAlive && !target.alive) {
          state.history.push({
            targetId: target.id, tick: state.tick, type: "target-destroyed",
          });
        }
      } else if (command.type === "move-target") {
        target.position = clone(command.position);
      } else if (command.type === "hide-target") {
        target.hidden = true;
      } else if (command.type === "reveal-target") {
        target.hidden = false;
      }
      state.history.push({
        command: command.type, targetId: target.id, tick: state.tick, type: "command",
      });
    }
  }
}

function advance(state, cycles, commands) {
  const historyStart = state.history.length;
  applyCommands(state, commands);
  for (const building of state.buildings) {
    if (building.alive && state.tick >= ARCHETYPES[building.archetypeId].lifetimeTicks) {
      destroyBuilding(state, building, "lifetime");
    }
  }
  for (const building of state.buildings) {
    if (!building.alive) {
      cycles.get(building.id).step({ targetEligible: false, targetId: null });
      continue;
    }
    const archetype = ARCHETYPES[building.archetypeId];
    const candidates = eligibleCandidates(building, state.targets, archetype);
    const target = retainOrAcquireTarget(
      { position: building.position, radius: 0 },
      candidates.map(candidateOf),
      {
        currentTargetId: building.targetId,
        mode: archetype.mode,
        sightRange: archetype.sightRange,
      },
    );
    const priorTarget = building.targetId;
    building.targetId = target?.id ?? null;
    if (archetype.variant === "hidden") {
      setBuildingVisibility(state, building, target !== null);
    }
    if (
      archetype.variant === "ramp" &&
      priorTarget !== null && priorTarget !== building.targetId
    ) {
      if (building.rampPrimitive !== null) {
        rebuildRampPrimitive(
          building,
          { targetId: null, tick: state.tick, type: "target-lost" },
          state.tick,
        );
      }
      state.history.push({
        buildingId: building.id, reason: "target-change-or-loss",
        tick: state.tick, type: "ramp-reset",
      });
    }
    const ready = cycles.get(building.id).step({
      targetEligible: target !== null,
      targetId: target?.id ?? null,
    });
    for (const event of ready) {
      building.attackSequence = event.sequence;
      const primary = state.targets.find(({ id }) => id === event.targetId);
      if (!primary?.alive) continue;
      if (archetype.variant === "ramp") {
        const primitiveTarget = building.rampPrimitive === null
          ? null
          : ConsecutiveTargetRampEncounter.restore(building.rampPrimitive)
            .state.targetId;
        if (primitiveTarget !== primary.id) {
          rebuildRampPrimitive(
            building,
            { targetId: primary.id, tick: state.tick, type: "target-acquired" },
            state.tick,
          );
        }
      }
      const amount = archetype.stages[building.stageIndex];
      state.history.push({
        amount, buildingId: building.id, sequence: event.sequence,
        stageIndex: building.stageIndex, targetId: primary.id,
        tick: state.tick, type: "attack",
      });
      launchProjectile(
        state, building, primary, archetype, amount, event.sequence,
        building.stageIndex,
      );
    }
  }
  const rampEvents = new Map();
  for (const building of state.buildings) {
    rampEvents.set(building.id, advanceRampPrimitive(building, state.tick));
  }
  resolveProjectiles(state, commands, rampEvents);
  state.tick += 1;
  return clone(state.history.slice(historyStart));
}

function createCycles(buildings) {
  return new Map(buildings.map((building) => {
    const value = ARCHETYPES[building.archetypeId];
    return [building.id, new AttackCycle({
      deployTicks: value.deployTicks,
      firstHitTicks: value.firstHitTicks,
      hitSpeedTicks: value.hitSpeedTicks,
    })];
  }));
}

export function createDefensiveBuildingCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

/**
 * Runtime-facing projection of the already verified defensive reducer data.
 *
 * This deliberately exposes no encounter state or private reducer. A unified
 * session can share one clock, ID stream, target list, and event history while
 * preserving the individual building policies that the isolated reducer
 * established. Fields whose behaviour is corpus-absent remain labelled as a
 * QUESTION policy by the caller; this projection only prevents a second copy
 * of the card constants from becoming a competing source of truth.
 */
export function createDefensiveBuildingRuntimeProfiles(...args) {
  if (args.length !== 0) {
    throw new TypeError("defensive building runtime profiles do not accept overrides");
  }
  const corpusRecords = createDefensiveBuildingCorpusRecords();
  return deepFreeze(Object.fromEntries(Object.entries(ARCHETYPES).map(([id, value]) => [id, {
    areaDamageRadiusMillitiles: value.areaDamageRadiusMillitiles,
    damage: value.damage,
    deployTicks: value.deployTicks,
    firstHitTicks: value.firstHitTicks,
    hitSpeedTicks: value.hitSpeedTicks,
    hitpoints: value.hitpoints,
    lifetimeTicks: value.lifetimeTicks,
    maxRangeMillitiles: value.maxRange,
    minRangeMillitiles: value.minRange,
    policy: {
      confidence: "unverified",
      corpusFields: clone(corpusRecords[id]),
      disposition: "question",
      source: SOURCE,
    },
    rampStages: clone(value.stages),
    rampThresholds: clone(value.thresholds),
    targetMode: value.mode,
    variant: value.variant,
  }])));
}

export function createDefensiveBuildingCorpusRecords() {
  return Object.fromEntries(Object.entries(ARCHETYPES).map(([id, value]) => [
    id,
    deepFreeze(Object.fromEntries(CORPUS_FIELDS.map((field) => [
      field,
      {
        authoritative: field === "cost" || id === "bulwark-needle" && field === "hitSpeedTicks",
        confidence: field === "cost" || id === "bulwark-needle" && field === "hitSpeedTicks"
          ? "high"
          : "unverified",
        source: field === "cost"
          ? "pinned-pre-march-2023-card-roster-identity"
          : "pinned-pre-march-2023-building-constants",
        value: field === "firstHitTicks" && Object.hasOwn(value, "corpusFirstHitTicks")
          ? value.corpusFirstHitTicks
          : value[field],
      },
    ]))),
  ]));
}

export function createDefensiveBuildingQuestionRecords(...args) {
  if (args.length !== 0) throw new TypeError("defensive QUESTION records do not accept overrides");
  return deepFreeze(Object.fromEntries(Object.entries(QUESTION_VALUES).map(([key, value]) => [
    key,
    {
      authoritative: false, confidence: "unverified", disposition: "question",
      key, source: SOURCE, value: clone(value),
    },
  ])));
}

export function createDefensiveBuildingFixture(buildings = [], targets = [], commands = []) {
  return clone({ buildings, commands, targets });
}

export class DefensiveBuildingEncounter {
  #setup;
  #state;
  #cycles;

  constructor(setup = createDefensiveBuildingFixture()) {
    this.#setup = checkedSetup(setup);
    this.#state = initialState(this.#setup);
    this.#cycles = createCycles(this.#setup.buildings);
  }

  get state() { return clone(this.#state); }
  get replay() { return clone(this.#state.history); }

  step() { return this.stepMany(1); }

  stepMany(count) {
    integer(count, "defensive step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("defensive step count exceeds the encounter bound");
    }
    const state = clone(this.#state);
    const cycles = new Map(
      [...this.#cycles].map(([id, cycle]) => [id, AttackCycle.restore(cycle.serialize())]),
    );
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(state, cycles, this.#setup.commands));
    }
    this.#state = state;
    this.#cycles = cycles;
    return clone(events);
  }

  run() { return this.stepMany(MAX_TICK - this.#state.tick); }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        buildings: this.#setup.buildings.map((item) => ({
          archetypeId: item.archetypeId,
          destroyedOpposingLaneTowers: item.destroyedOpposingLaneTowers,
          id: item.id, position: item.position, side: item.side,
        })),
        commands: this.#setup.commands,
        fixture: FIXTURE,
        targets: this.#setup.targets.map((item) => ({
          health: item.health, id: item.id, kind: item.kind, layer: item.layer,
          position: item.position, radius: item.radius, targetable: item.targetable,
        })),
      },
      state: this.#state,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("defensive snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") throw new TypeError("defensive snapshot must be a string");
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("defensive snapshot exceeds its byte bound");
    }
    let value;
    try { value = JSON.parse(serialized); } catch {
      throw new TypeError("defensive snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) throw new TypeError("defensive snapshot must be canonical JSON");
    const snapshot = exactRecord(value, ["identity", "state", "version"], "defensive snapshot");
    if (snapshot.version !== 1) throw new TypeError("defensive snapshot version is unsupported");
    const identity = exactRecord(
      snapshot.identity, ["buildings", "commands", "fixture", "targets"],
      "defensive snapshot.identity",
    );
    if (identity.fixture !== FIXTURE) throw new TypeError("defensive snapshot fixture is invalid");
    const encounter = new DefensiveBuildingEncounter({
      buildings: identity.buildings, commands: identity.commands, targets: identity.targets,
    });
    integer(snapshot.state?.tick, "defensive snapshot.state.tick", 0, MAX_TICK);
    encounter.stepMany(snapshot.state.tick);
    if (canonicalJson(encounter.#state) !== canonicalJson(snapshot.state)) {
      throw new TypeError("defensive snapshot state is not a causal execution");
    }
    return encounter;
  }
}
