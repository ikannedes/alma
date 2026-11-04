import {
  DeathSpawnEncounter,
  createDeathSpawnFixture,
} from "./death-spawns.js";

const FIXTURE = "gloam-mark-death-conversion-question-v1";
const MAX_EVENTS = 4096;
const MAX_SNAPSHOT_BYTES = 524_288;
const MAX_STEP_CHUNK = 256;
const MAX_TICK = 256;
const MAX_CONVERSIONS = 16;

function clone(value) {
  return structuredClone(value);
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

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function ordinaryMeta(source) {
  return source.spec.ordinaryChildren.map((spec, index) => ({
    initial: false,
    key: `${source.key}/ordinary/${index}`,
    ownerId: source.ownerId,
    provenance: null,
    spec,
  }));
}

function periodicMeta(source) {
  if (source.spec.periodic === null) return [];
  return source.spec.periodic.children.map((spec, index) => ({
    initial: false,
    key: `${source.key}/periodic/${index}`,
    ownerId: source.ownerId,
    provenance: null,
    spec,
  }));
}

function conversionMeta(source, plans) {
  const plan = plans.get(source.key);
  if (plan === undefined) return [];
  return plan.children.map((spec, index) => ({
    initial: false,
    key: `${source.key}/conversion/${index}`,
    ownerId: plan.ownerId,
    provenance: {
      converterId: plan.converterId,
      fromOwnerId: source.ownerId,
      sourceId: null,
      toOwnerId: plan.ownerId,
    },
    spec,
  }));
}

function deathMeta(source, plans) {
  return [...ordinaryMeta(source), ...conversionMeta(source, plans)];
}

function spawnedMeta(event, source, plans) {
  if (event.kind === "periodic") return periodicMeta(source);
  if (event.kind === "death") return deathMeta(source, plans);
  throw new TypeError("shared death spawn emitted an unknown batch kind");
}

function sharedPeriodic(meta, plans) {
  if (meta.spec.periodic === null) return null;
  return {
    cadenceTicks: meta.spec.periodic.cadenceTicks,
    children: periodicMeta(meta).map((child) => sharedChild(child, plans)),
    initialDelayTicks: meta.spec.periodic.initialDelayTicks,
    lifetimeTicks: meta.spec.periodic.lifetimeTicks,
  };
}

function sharedChild(meta, plans) {
  return {
    archetypeId: meta.spec.archetypeId,
    children: deathMeta(meta, plans).map((child) =>
      sharedChild(child, plans)
    ),
    health: meta.spec.health,
    periodic: sharedPeriodic(meta, plans),
    radius: meta.spec.radius,
    role: meta.spec.role,
  };
}

function sharedSetup(setup, plans) {
  return createDeathSpawnFixture(
    setup.entities.map((spec) => {
      const meta = {
        initial: true,
        key: `entity/${spec.id}`,
        ownerId: spec.ownerId,
        provenance: null,
        spec,
      };
      return {
        anchor: clone(spec.anchor),
        archetypeId: spec.archetypeId,
        children: deathMeta(meta, plans).map((child) =>
          sharedChild(child, plans)
        ),
        health: spec.health,
        id: spec.id,
        ownerId: spec.ownerId,
        periodic: sharedPeriodic(meta, plans),
        sourceId: spec.id,
      };
    }),
    setup.commands.filter(({ kind }) => kind === "damage").map((command) => ({
      amount: command.amount,
      cause: command.cause,
      sourceId: command.sourceId,
      targetId: command.targetId,
      tick: command.tick,
    })),
  );
}

function initialMetadata(setup) {
  return new Map(setup.entities.map((spec) => [spec.id, {
    initial: true,
    key: `entity/${spec.id}`,
    ownerId: spec.ownerId,
    provenance: null,
    spec,
  }]));
}

function mapSharedSpawn(event, metadata, plans) {
  const source = metadata.get(event.sourceId);
  if (source === undefined) {
    throw new TypeError("shared death spawn emitted an unknown source");
  }
  const children = spawnedMeta(event, source, plans);
  if (children.length !== event.childIds.length) {
    throw new TypeError("shared death spawn child metadata diverged");
  }
  event.childIds.forEach((id, index) => {
    const meta = clone(children[index]);
    if (meta.provenance !== null) meta.provenance.sourceId = event.sourceId;
    metadata.set(id, meta);
  });
  return children;
}

function livingById(state) {
  return new Map(state.entities.map((entity) => [entity.id, entity.alive]));
}

function activeCurse(curses, targetId) {
  return curses.find((curse) => curse.targetId === targetId) ?? null;
}

function applyCurse(curses, command, alive, metadata, tick) {
  const source = metadata.get(command.sourceId);
  const target = metadata.get(command.targetId);
  if (
    source === undefined ||
    target === undefined ||
    alive.get(command.sourceId) !== true ||
    alive.get(command.targetId) !== true ||
    !target.spec.eligible
  ) {
    return {
      accepted: false,
      event: {
        accepted: false,
        expiryTick: null,
        ownerId: source?.ownerId ?? null,
        sourceId: command.sourceId,
        targetId: command.targetId,
        tick,
        type: "curse-applied",
      },
    };
  }
  const proposed = {
    appliedTick: tick,
    expiryTick: tick + command.durationTicks,
    ownerId: source.ownerId,
    sourceId: command.sourceId,
    targetId: command.targetId,
  };
  const index = curses.findIndex(({ targetId }) =>
    targetId === command.targetId
  );
  const existing = index === -1 ? null : curses[index];
  let accepted = false;
  let winner = existing;
  if (existing === null) {
    accepted = true;
    winner = proposed;
  } else if (existing.sourceId === proposed.sourceId) {
    if (proposed.expiryTick > existing.expiryTick) {
      accepted = true;
      winner = {
        ...proposed,
        appliedTick: Math.max(existing.appliedTick, proposed.appliedTick),
      };
    }
  } else if (
    proposed.appliedTick > existing.appliedTick ||
    (
      proposed.appliedTick === existing.appliedTick &&
      proposed.sourceId > existing.sourceId
    )
  ) {
    accepted = true;
    winner = proposed;
  }
  if (index === -1) curses.push(winner);
  else curses[index] = winner;
  curses.sort((left, right) => left.targetId - right.targetId);
  return {
    accepted,
    event: {
      accepted,
      expiryTick: winner.expiryTick,
      ownerId: winner.ownerId,
      sourceId: command.sourceId,
      targetId: command.targetId,
      tick,
      type: "curse-applied",
    },
  };
}

function expireCurses(curses, tick, events = null) {
  const expired = curses.filter(({ expiryTick }) => expiryTick === tick)
    .sort((left, right) => left.targetId - right.targetId);
  if (events !== null) {
    for (const curse of expired) {
      events.push({
        sourceId: curse.sourceId,
        targetId: curse.targetId,
        tick,
        type: "curse-expired",
      });
    }
  }
  if (expired.length > 0) {
    const ids = new Set(expired.map(({ targetId }) => targetId));
    curses.splice(0, curses.length,
      ...curses.filter(({ targetId }) => !ids.has(targetId)));
  }
}

function observePlans(setup, plans) {
  const shared = new DeathSpawnEncounter(sharedSetup(setup, plans));
  const metadata = initialMetadata(setup);
  const curses = [];
  const observed = new Map();
  const alive = new Map(setup.entities.map(({ id }) => [id, true]));
  const allEvents = shared.run();
  for (let tick = 0; tick < MAX_TICK; tick += 1) {
    for (const command of setup.commands) {
      if (command.tick !== tick || command.kind !== "curse") continue;
      applyCurse(curses, command, alive, metadata, tick);
    }
    const events = allEvents.filter((event) => event.tick === tick);
    for (const event of events) {
      if (event.type !== "death" || event.cause !== "combat-damage") continue;
      const target = metadata.get(event.targetId);
      const curse = activeCurse(curses, event.targetId);
      const converter = curse === null
        ? undefined
        : metadata.get(curse.sourceId);
      if (
        target !== undefined &&
        target.spec.eligible &&
        curse !== null &&
        converter !== undefined &&
        converter.spec.replacementChildren.length > 0
      ) {
        observed.set(target.key, {
          children: clone(converter.spec.replacementChildren),
          converterId: curse.sourceId,
          ownerId: curse.ownerId,
        });
      }
    }
    for (const event of events) {
      if (event.type === "spawn-batch") {
        mapSharedSpawn(event, metadata, plans);
        for (const id of event.childIds) alive.set(id, true);
      }
    }
    const dead = new Set(events.filter(({ type }) => type === "death")
      .map(({ targetId }) => targetId));
    for (const id of dead) alive.set(id, false);
    if (dead.size > 0) {
      curses.splice(0, curses.length,
        ...curses.filter(({ targetId }) => !dead.has(targetId)));
    }
    expireCurses(curses, tick);
  }
  return observed;
}

function planBytes(plans) {
  return canonicalJson([...plans].sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function compilePlans(setup) {
  let plans = new Map();
  for (let round = 0; round <= 64; round += 1) {
    const observed = observePlans(setup, plans);
    if (planBytes(observed) === planBytes(plans)) return plans;
    plans = observed;
  }
  throw new RangeError("death conversion delegation did not converge");
}

function publicEntity(entity, meta) {
  return {
    alive: entity.alive,
    anchor: clone(entity.anchor),
    archetypeId: entity.archetypeId,
    bornTick: entity.bornTick,
    eligible: meta.spec.eligible,
    health: entity.health,
    id: entity.id,
    ordinaryChildren: clone(meta.spec.ordinaryChildren),
    ownerId: meta.ownerId,
    periodic: clone(meta.spec.periodic),
    periodicBatchCount: entity.periodicBatchCount,
    replacementChildren: clone(meta.spec.replacementChildren),
    sourceId: meta.initial ? null : entity.sourceId,
  };
}

function makeState(sharedState, metadata, values) {
  return {
    batchCount: sharedState.batchCount,
    commandIndex: values.commandIndex,
    curses: clone(values.curses),
    entities: sharedState.entities.map((entity) => {
      const meta = metadata.get(entity.id);
      if (meta === undefined) {
        throw new TypeError("shared death state emitted an unknown entity");
      }
      return publicEntity(entity, meta);
    }),
    history: clone(values.history),
    latches: clone(values.latches),
    tick: sharedState.tick,
  };
}

function publicChildren(sharedChildren, metadata) {
  return sharedChildren.map((child) => {
    const meta = metadata.get(child.id);
    if (meta === undefined) {
      throw new TypeError("shared placement emitted an unknown child");
    }
    const projected = clone(child);
    projected.data.ownerId = meta.ownerId;
    return projected;
  });
}

function publicSpawn(event, metadata) {
  const overlays = event.childIds.flatMap((childId) => {
    const meta = metadata.get(childId);
    if (meta === undefined) {
      throw new TypeError("shared batch emitted an unknown child");
    }
    if (meta.provenance === null) return [];
    return [{
      childId,
      converterId: meta.provenance.converterId,
      fromOwnerId: meta.provenance.fromOwnerId,
      sourceId: meta.provenance.sourceId,
      toOwnerId: meta.provenance.toOwnerId,
    }];
  });
  return {
    ...clone(event),
    ownershipOverlays: overlays,
  };
}

function snapshot(setup, shared, state) {
  return canonicalJson({
    identity: { fixture: FIXTURE, setup },
    placementSnapshotBytes:
      JSON.parse(shared.serialize()).placementSnapshotBytes,
    state,
    version: 1,
  });
}

export class DelegatedDeathConversionEncounter {
  #metadata;
  #plans;
  #setup;
  #shared;
  #values;

  constructor(setup) {
    this.#setup = clone(setup);
    this.#plans = compilePlans(this.#setup);
    this.#shared = new DeathSpawnEncounter(
      sharedSetup(this.#setup, this.#plans),
    );
    this.#metadata = initialMetadata(this.#setup);
    this.#values = {
      commandIndex: 0,
      curses: [],
      history: [],
      latches: [],
    };
  }

  get children() {
    return publicChildren(this.#shared.children, this.#metadata);
  }

  get replay() {
    return clone(this.#values.history);
  }

  get state() {
    return clone(makeState(
      this.#shared.state,
      this.#metadata,
      this.#values,
    ));
  }

  get sharedChildren() {
    return this.#shared.children;
  }

  get sharedReplay() {
    return this.#shared.replay;
  }

  get sharedState() {
    return this.#shared.state;
  }

  get deathSpawnSnapshotBytes() {
    return this.#shared.serialize();
  }

  step() {
    return this.stepMany(1);
  }

  stepMany(count) {
    integer(count, 0, MAX_STEP_CHUNK, "death conversion step count");
    const start = this.#shared.state.tick;
    const target = start + count;
    if (target > MAX_TICK) {
      throw new RangeError("death conversion step count exceeds encounter bound");
    }
    const candidate = {
      metadata: new Map([...this.#metadata].map(([id, meta]) =>
        [id, clone(meta)])),
      shared: DeathSpawnEncounter.restore(this.#shared.serialize()),
      values: clone(this.#values),
    };
    const alive = livingById(candidate.shared.state);
    const sharedEvents = candidate.shared.stepMany(count);
    const returned = [];
    for (let tick = start; tick < target; tick += 1) {
      const events = [];
      const canonical = sharedEvents.filter((event) => event.tick === tick);
      const damages = canonical.filter(({ type }) => type === "damage");
      let damageIndex = 0;
      for (const command of this.#setup.commands) {
        if (command.tick !== tick) continue;
        candidate.values.commandIndex += 1;
        if (command.kind === "curse") {
          events.push(applyCurse(
            candidate.values.curses,
            command,
            alive,
            candidate.metadata,
            tick,
          ).event);
        } else {
          const damage = damages[damageIndex];
          damageIndex += 1;
          if (damage === undefined) {
            throw new TypeError("shared death executor omitted canonical damage");
          }
          events.push(clone(damage));
        }
      }
      const deaths = new Set();
      for (const event of canonical) {
        if (event.type === "damage") continue;
        if (event.type === "death") {
          deaths.add(event.targetId);
          events.push(clone(event));
          continue;
        }
        if (event.type === "source-despawn") {
          events.push(clone(event));
          continue;
        }
        if (event.type === "death-triggered") {
          const source = candidate.metadata.get(event.sourceId);
          if (source === undefined) {
            throw new TypeError(
              "shared death trigger has no conversion metadata",
            );
          }
          const plan = this.#plans.get(source.key);
          if (plan !== undefined) {
            if (candidate.values.latches.length >= MAX_CONVERSIONS) {
              throw new RangeError(
                `death conversion recursion bound ${MAX_CONVERSIONS} exceeded`,
              );
            }
            candidate.values.latches.push(event.sourceId);
            events.push({
              converterId: plan.converterId,
              ownerId: plan.ownerId,
              sourceId: event.sourceId,
              tick,
              type: "conversion-triggered",
            });
          }
          continue;
        }
        if (event.type === "spawn-batch") {
          mapSharedSpawn(event, candidate.metadata, this.#plans);
          for (const id of event.childIds) alive.set(id, true);
          events.push(publicSpawn(event, candidate.metadata));
          continue;
        }
        events.push(clone(event));
      }
      for (const id of deaths) alive.set(id, false);
      if (deaths.size > 0) {
        candidate.values.curses.splice(0, candidate.values.curses.length,
          ...candidate.values.curses.filter(
            ({ targetId }) => !deaths.has(targetId),
          ));
      }
      expireCurses(candidate.values.curses, tick, events);
      if (candidate.values.history.length + events.length > MAX_EVENTS) {
        throw new RangeError(
          `death conversion event bound ${MAX_EVENTS} exceeded`,
        );
      }
      candidate.values.history.push(...clone(events));
      returned.push(...events);
    }
    const bytes = snapshot(
      this.#setup,
      candidate.shared,
      makeState(candidate.shared.state, candidate.metadata, candidate.values),
    );
    if (new TextEncoder().encode(bytes).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("death conversion step exceeds snapshot byte bound");
    }
    this.#metadata = candidate.metadata;
    this.#shared = candidate.shared;
    this.#values = candidate.values;
    return clone(returned);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#shared.state.tick);
  }

  serialize() {
    const serialized = snapshot(
      this.#setup,
      this.#shared,
      makeState(this.#shared.state, this.#metadata, this.#values),
    );
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("death conversion snapshot exceeds its byte bound");
    }
    return serialized;
  }
}

export function restoreDelegatedEncounter(
  serialized,
  checkedSetup,
  EncounterClass,
) {
  if (typeof serialized !== "string") {
    throw new TypeError("death conversion snapshot must be a string");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new RangeError("death conversion snapshot exceeds its byte bound");
  }
  let raw;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new TypeError("death conversion snapshot must be valid JSON");
  }
  if (canonicalJson(raw) !== serialized) {
    throw new TypeError("death conversion snapshot must use canonical bytes");
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    canonicalJson(Object.keys(raw).sort()) !==
      canonicalJson(["identity", "placementSnapshotBytes", "state", "version"])
  ) {
    throw new TypeError("death conversion snapshot has an invalid shape");
  }
  if (
    raw.version !== 1 ||
    raw.identity === null ||
    typeof raw.identity !== "object" ||
    Array.isArray(raw.identity) ||
    canonicalJson(Object.keys(raw.identity).sort()) !==
      canonicalJson(["fixture", "setup"]) ||
    raw.identity.fixture !== FIXTURE
  ) {
    throw new TypeError("death conversion snapshot identity is invalid");
  }
  const setup = checkedSetup(raw.identity.setup);
  const tick = integer(raw.state?.tick, 0, MAX_TICK,
    "death conversion snapshot tick");
  const encounter = new EncounterClass(setup);
  encounter.stepMany(tick);
  if (encounter.serialize() !== serialized) {
    throw new TypeError(
      "death conversion snapshot shared lifecycle, winner, expiry, latches, ownership, history, graph, or placement is forged",
    );
  }
  return encounter;
}
