import {
  DelegatedDeathConversionEncounter,
  restoreDelegatedEncounter,
} from "./death-conversion-delegated.js";

const SOURCE = "unsourced-death-conversion-policy-fixture";
const FIXTURE = "gloam-mark-death-conversion-question-v1";
const MAX_COMMANDS = 128;
const MAX_ENTITIES = 64;
const MAX_EVENTS = 4096;
const MAX_GRAPH_NODES = 64;
const MAX_SNAPSHOT_BYTES = 524_288;
const MAX_STEP_CHUNK = 256;
const MAX_TICK = 256;
const MAX_CONVERSIONS = 16;
const SETUP_KEYS = ["commands", "entities"];
const ENTITY_KEYS = [
  "anchor",
  "archetypeId",
  "eligible",
  "health",
  "id",
  "ordinaryChildren",
  "ownerId",
  "periodic",
  "replacementChildren",
];
const CHILD_KEYS = [
  "archetypeId",
  "eligible",
  "health",
  "ordinaryChildren",
  "periodic",
  "radius",
  "replacementChildren",
  "role",
];
const PERIODIC_KEYS = [
  "cadenceTicks",
  "children",
  "initialDelayTicks",
  "lifetimeTicks",
];
const COMMAND_KEYS = [
  "amount",
  "cause",
  "durationTicks",
  "kind",
  "sourceId",
  "targetId",
  "tick",
];
const CURSE_KEYS = [
  "appliedTick",
  "expiryTick",
  "ownerId",
  "sourceId",
  "targetId",
];
const RUNTIME_ENTITY_KEYS = [
  "alive",
  "anchor",
  "archetypeId",
  "bornTick",
  "eligible",
  "health",
  "id",
  "ordinaryChildren",
  "ownerId",
  "replacementChildren",
  "sourceId",
];
const STATE_KEYS = [
  "batchCount",
  "commandIndex",
  "curses",
  "entities",
  "history",
  "latches",
  "tick",
];
const SNAPSHOT_KEYS = [
  "identity",
  "placementSnapshotBytes",
  "state",
  "version",
];
const IDENTITY_KEYS = ["fixture", "setup"];
const CAUSES = new Set(["combat-damage", "despawn", "expiry"]);

export const DEATH_CONVERSION_IDENTITY = deepFreeze({
  displayName: "Gloam Shepherd",
  id: "gloam-shepherd",
  replacementDisplayName: "Umber Whelp",
  replacementId: "umber-whelp",
});

const QUESTION_VALUES = deepFreeze({
  shippedIdentity: "original-gloam-shepherd-and-umber-whelp-identities",
  benchmarkMapping: "historical-comparison-identity-is-test-only",
  durationTicks: 3,
  application:
    "living-source-to-living-eligible-target-command-applies-immediately",
  refresh: "same-source-reapplication-keeps-the-later-expiry",
  eligibility: "explicit-boolean-on-the-immediate-dead-target",
  lethalCause: "combat-damage-only",
  expiry: "command-first-at-expiry-tick-then-expire-after-death-resolution",
  competingSource:
    "latest-application-tick-wins-then-greater-source-id-breaks-ties",
  sourceCasterDeath: "an-applied-curse-survives-its-caster-death",
  targetDeath: "target-death-removes-its-curse-after-resolution",
  ownership: "replacement-batch-uses-winning-converter-owner",
  attribution: "replacement-batch-source-is-the-immediate-dead-target",
  childIdentity: "umber-whelp-in-the-default-original-identity-fixture",
  childCount: 1,
  childHealth: 35,
  childRadius: 70,
  childRole: "primary",
  sameBoundaryOrdering:
    "commands-in-input-order-then-deaths-by-id-then-expiry",
  simultaneousDeaths: "ascending-dead-entity-id",
  ordinaryDeathSpawnInteraction:
    "ordinary-death-batch-before-conversion-replacement-batch",
  exactlyOnceLatch: "one-conversion-latch-per-immediate-dead-target-id",
  recursion:
    "converted-replacements-can-later-cast-and-be-converted-through-explicit-commands",
  recursionCap: MAX_CONVERSIONS,
  entityCap: MAX_ENTITIES,
  eventCap: MAX_EVENTS,
  graphCap: MAX_GRAPH_NODES,
  commandCap: MAX_COMMANDS,
  tickCap: MAX_TICK,
  snapshotByteCap: MAX_SNAPSHOT_BYTES,
  zeroDamage: "zero-damage-never-causes-death",
  overkill: "damage-clamps-at-zero-and-the-first-lethal-command-owns-cause",
  alreadyDead: "later-damage-and-curse-commands-are-no-ops",
  idPolicy: "shared-placement-materializer-monotonic-id-order",
  anchorPolicy: "replacement-uses-immediate-dead-target-anchor",
  placementPolicy: "shared-placement-materializer-formation",
  commandBoundary: "all-commands-are-visible-before-stable-death-drain",
  snapshotPolicy:
    "canonical-causal-replay-validates-winner-expiry-latches-ownership-history-and-placement",
});

const defaultChild = deepFreeze({
  archetypeId: "umber-whelp",
  eligible: true,
  health: 35,
    ordinaryChildren: [],
    periodic: null,
    radius: 70,
  replacementChildren: [],
  role: "primary",
});

const DEFAULT_SETUP = deepFreeze({
  commands: [
    {
      amount: 0,
      cause: null,
      durationTicks: 3,
      kind: "curse",
      sourceId: 101,
      targetId: 102,
      tick: 1,
    },
    {
      amount: 80,
      cause: "combat-damage",
      durationTicks: 0,
      kind: "damage",
      sourceId: 101,
      targetId: 102,
      tick: 3,
    },
  ],
  entities: [
    {
      anchor: { x: -500, y: 900 },
      archetypeId: "gloam-shepherd",
      eligible: true,
      health: 90,
      id: 101,
      ordinaryChildren: [],
      ownerId: 7,
      periodic: null,
      replacementChildren: [defaultChild],
    },
    {
      anchor: { x: 600, y: 1200 },
      archetypeId: "reed-guard",
      eligible: true,
      health: 80,
      id: 102,
      ordinaryChildren: [],
      ownerId: 8,
      periodic: null,
      replacementChildren: [],
    },
  ],
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

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

function exactRecord(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain string-keyed object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) =>
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, maximum, label, minimum = 0) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some((index) =>
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    )
  ) {
    throw new TypeError(`${label} must contain only dense data properties`);
  }
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value
  );
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function text(value, label) {
  let count = 0;
  if (typeof value === "string" && value.isWellFormed()) {
    for (const _point of value) {
      count += 1;
      if (count > 128) break;
    }
  }
  if (count < 1 || count > 128) {
    throw new TypeError(`${label} must be 1 to 128 Unicode code points`);
  }
  return value;
}

function checkedAnchor(value, label) {
  const anchor = exactRecord(value, ["x", "y"], label);
  return {
    x: integer(anchor.x, -1_000_000, 1_000_000, `${label}.x`),
    y: integer(anchor.y, -1_000_000, 1_000_000, `${label}.y`),
  };
}

function checkedChildren(value, tracker, label) {
  return denseArray(value, 15, label).map((entry, index) =>
    checkedChild(entry, tracker, `${label}[${index}]`)
  );
}

function checkedPeriodic(value, tracker, label) {
  if (value === null) return null;
  const periodic = exactRecord(value, PERIODIC_KEYS, label);
  return {
    cadenceTicks: integer(
      periodic.cadenceTicks, 1, MAX_TICK, `${label}.cadenceTicks`,
    ),
    children: checkedChildren(
      periodic.children, tracker, `${label}.children`,
    ),
    initialDelayTicks: integer(
      periodic.initialDelayTicks, 1, MAX_TICK - 1,
      `${label}.initialDelayTicks`,
    ),
    lifetimeTicks: integer(
      periodic.lifetimeTicks, 1, MAX_TICK - 1, `${label}.lifetimeTicks`,
    ),
  };
}

function checkedChild(value, tracker, label) {
  if (tracker.seen.has(value)) {
    throw new TypeError(`${label} graph must not contain aliases or cycles`);
  }
  tracker.seen.add(value);
  tracker.count += 1;
  if (tracker.count > MAX_GRAPH_NODES) {
    throw new RangeError(`death conversion graph exceeds ${MAX_GRAPH_NODES} nodes`);
  }
  const child = exactRecord(value, CHILD_KEYS, label);
  if (typeof child.eligible !== "boolean") {
    throw new TypeError(`${label}.eligible must be boolean`);
  }
  if (child.role !== "primary" && child.role !== "secondary") {
    throw new TypeError(`${label}.role is invalid`);
  }
  return {
    archetypeId: text(child.archetypeId, `${label}.archetypeId`),
    eligible: child.eligible,
    health: integer(child.health, 1, Number.MAX_SAFE_INTEGER, `${label}.health`),
    ordinaryChildren: checkedChildren(
      child.ordinaryChildren,
      tracker,
      `${label}.ordinaryChildren`,
    ),
    periodic: checkedPeriodic(child.periodic, tracker, `${label}.periodic`),
    radius: integer(child.radius, 0, 1_000_000, `${label}.radius`),
    replacementChildren: checkedChildren(
      child.replacementChildren,
      tracker,
      `${label}.replacementChildren`,
    ),
    role: child.role,
  };
}

function checkedEntity(value, tracker, index) {
  if (tracker.seen.has(value)) {
    throw new TypeError(`death conversion entity ${index} is aliased`);
  }
  tracker.seen.add(value);
  const label = `death conversion entity ${index}`;
  const entity = exactRecord(value, ENTITY_KEYS, label);
  if (typeof entity.eligible !== "boolean") {
    throw new TypeError(`${label}.eligible must be boolean`);
  }
  return {
    anchor: checkedAnchor(entity.anchor, `${label}.anchor`),
    archetypeId: text(entity.archetypeId, `${label}.archetypeId`),
    eligible: entity.eligible,
    health: integer(entity.health, 1, Number.MAX_SAFE_INTEGER, `${label}.health`),
    id: integer(entity.id, 1, Number.MAX_SAFE_INTEGER, `${label}.id`),
    ordinaryChildren: checkedChildren(
      entity.ordinaryChildren,
      tracker,
      `${label}.ordinaryChildren`,
    ),
    ownerId: integer(
      entity.ownerId,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.ownerId`,
    ),
    periodic: checkedPeriodic(entity.periodic, tracker, `${label}.periodic`),
    replacementChildren: checkedChildren(
      entity.replacementChildren,
      tracker,
      `${label}.replacementChildren`,
    ),
  };
}

function checkedCommands(value) {
  const commands = denseArray(value, MAX_COMMANDS, "death conversion commands")
    .map((entry, sequence) => {
      const label = `death conversion command ${sequence}`;
      const command = exactRecord(entry, COMMAND_KEYS, label);
      const common = {
        amount: integer(
          command.amount,
          0,
          Number.MAX_SAFE_INTEGER,
          `${label}.amount`,
        ),
        cause: command.cause,
        durationTicks: integer(
          command.durationTicks,
          0,
          MAX_TICK,
          `${label}.durationTicks`,
        ),
        kind: command.kind,
        sequence,
        sourceId: integer(
          command.sourceId,
          1,
          Number.MAX_SAFE_INTEGER,
          `${label}.sourceId`,
        ),
        targetId: integer(
          command.targetId,
          1,
          Number.MAX_SAFE_INTEGER,
          `${label}.targetId`,
        ),
        tick: integer(command.tick, 0, MAX_TICK - 1, `${label}.tick`),
      };
      if (common.kind === "curse") {
        if (
          common.amount !== 0 ||
          common.cause !== null ||
          common.durationTicks < 1 ||
          common.tick > MAX_TICK - common.durationTicks
        ) {
          throw new TypeError(`${label} curse fields are invalid`);
        }
      } else if (common.kind === "damage") {
        if (common.durationTicks !== 0 || !CAUSES.has(common.cause)) {
          throw new TypeError(`${label} damage fields are invalid`);
        }
      } else {
        throw new TypeError(`${label}.kind is invalid`);
      }
      return common;
    })
    .sort((left, right) =>
      left.tick - right.tick || left.sequence - right.sequence
    );
  const signatures = new Set();
  for (const command of commands) {
    const { sequence: _sequence, ...record } = command;
    const signature = canonicalJson(record);
    if (signatures.has(signature)) {
      throw new TypeError("death conversion commands must not contain duplicates");
    }
    signatures.add(signature);
  }
  return commands.map(({ sequence: _sequence, ...command }) => command);
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "death conversion setup");
  const tracker = { count: 0, seen: new Set() };
  const entities = denseArray(
    setup.entities,
    MAX_ENTITIES,
    "death conversion entities",
    1,
  ).map((entry, index) => checkedEntity(entry, tracker, index))
    .sort((left, right) => left.id - right.id);
  for (let index = 0; index < entities.length; index += 1) {
    if (entities[index].id <= MAX_ENTITIES) {
      throw new TypeError(
        `death conversion setup IDs must exceed child namespace ${MAX_ENTITIES}`,
      );
    }
    if (index > 0 && entities[index - 1].id === entities[index].id) {
      throw new TypeError("death conversion entity IDs must be unique");
    }
  }
  return { commands: checkedCommands(setup.commands), entities };
}

function questionRecord(key, value) {
  return deepFreeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source: SOURCE,
    value: clone(value),
  });
}


export function createDeathConversionQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("death conversion questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createDeathConversionFixture(
  entities = DEFAULT_SETUP.entities,
  commands = DEFAULT_SETUP.commands,
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("death conversion fixture received extra arguments");
  }
  return clone(checkedSetup({ commands, entities }));
}

export class DeathConversionEncounter extends DelegatedDeathConversionEncounter {
  constructor(setup = createDeathConversionFixture()) {
    super(checkedSetup(setup));
  }

  static restore(serialized) {
    return restoreDelegatedEncounter(
      serialized,
      checkedSetup,
      DeathConversionEncounter,
    );
  }
}
