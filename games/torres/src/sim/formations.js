import {
  MAX_SPATIAL_MILLITILES,
  validatePosition,
} from "./spatial.js";

const ROLES = new Set(["primary", "secondary"]);

/*
 * Slot coordinates are expressed in half-clearance cells. Adjacent coordinates
 * differ by two, so a cell size of ceil((2 * maxRadius + 1) / 2) leaves at
 * least one millitile between even the two largest member circles.
 *
 * Slot order is row-major: back-to-front (negative to positive y), then
 * left-to-right. Every template has its arithmetic center at the anchor.
 */
const TEMPLATE_ROWS = Object.freeze({
  1: Object.freeze([{ length: 1, y: 0 }]),
  2: Object.freeze([{ length: 2, y: 0 }]),
  3: Object.freeze([{ length: 1, y: -2 }, { length: 2, y: 1 }]),
  4: Object.freeze([{ length: 2, y: -1 }, { length: 2, y: 1 }]),
  5: Object.freeze([{ length: 2, y: -3 }, { length: 3, y: 2 }]),
  6: Object.freeze([{ length: 3, y: -1 }, { length: 3, y: 1 }]),
  7: Object.freeze([
    { length: 2, y: -2 },
    { length: 3, y: 0 },
    { length: 2, y: 2 },
  ]),
  8: Object.freeze([
    { length: 3, y: -2 },
    { length: 2, y: 0 },
    { length: 3, y: 2 },
  ]),
  9: Object.freeze([
    { length: 3, y: -2 },
    { length: 3, y: 0 },
    { length: 3, y: 2 },
  ]),
  10: Object.freeze([
    { length: 3, y: -2 },
    { length: 4, y: 0 },
    { length: 3, y: 2 },
  ]),
  11: Object.freeze([
    { length: 4, y: -2 },
    { length: 3, y: 0 },
    { length: 4, y: 2 },
  ]),
  12: Object.freeze([
    { length: 4, y: -2 },
    { length: 4, y: 0 },
    { length: 4, y: 2 },
  ]),
  13: Object.freeze([
    { length: 4, y: -2 },
    { length: 5, y: 0 },
    { length: 4, y: 2 },
  ]),
  14: Object.freeze([
    { length: 5, y: -2 },
    { length: 4, y: 0 },
    { length: 5, y: 2 },
  ]),
  15: Object.freeze([
    { length: 5, y: -2 },
    { length: 5, y: 0 },
    { length: 5, y: 2 },
  ]),
});

function assertPlainDataObject(value, label, expectedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must contain only string-keyed JSON data`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort();
  const wantedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== wantedKeys.length ||
    actualKeys.some((key, index) => key !== wantedKeys[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  for (const key of wantedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return descriptors;
}

function arrayDataDescriptors(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  const ownKeys = Reflect.ownKeys(descriptors);
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= length
    ) {
      throw new TypeError(`${label} must contain only indexed JSON data`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined) {
      throw new TypeError(`${label} must not be a sparse array`);
    }
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(
        `${label}[${index}] must be an enumerable data property`,
      );
    }
  }
  return { descriptors, length };
}

function validateMemberDescriptors(member, index) {
  return assertPlainDataObject(
    member,
    `formation member ${index}`,
    ["id", "radius", "role"],
  );
}

function checkedMember(descriptors, index) {
  const id = descriptors.id.value;
  const role = descriptors.role.value;
  const radius = descriptors.radius.value;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError(
      `formation member ${index}.id must be a positive safe integer`,
    );
  }
  if (!ROLES.has(role)) {
    throw new TypeError(
      `formation member ${index}.role must be "primary" or "secondary"`,
    );
  }
  if (
    !Number.isSafeInteger(radius) ||
    radius < 0 ||
    radius > MAX_SPATIAL_MILLITILES
  ) {
    throw new TypeError(
      `formation member ${index}.radius must be a non-negative safe integer millitile value within spatial bounds`,
    );
  }
  return { id, radius, role };
}

function templateSlots(count) {
  const slots = [];
  for (const row of TEMPLATE_ROWS[count]) {
    for (let column = 0; column < row.length; column += 1) {
      slots.push({
        x: -(row.length - 1) + column * 2,
        y: row.y,
      });
    }
  }
  return slots;
}

function checkedCoordinate(anchorValue, slotValue, cellSize, label) {
  const result =
    BigInt(anchorValue) + BigInt(slotValue) * BigInt(cellSize);
  const bound = BigInt(MAX_SPATIAL_MILLITILES);
  if (result < -bound || result > bound) {
    throw new RangeError(`${label} is outside the supported spatial bounds`);
  }
  return Number(result);
}

/**
 * Lays an ordered member list onto a deterministic symmetric formation.
 *
 * Input and output coordinates are integer millitiles. The returned array and
 * all nested objects are newly allocated. Member order, IDs, and roles are
 * preserved; only their row-major slot assignment depends on input order.
 */
export function layoutFormation(anchor, members) {
  // Validate structure for every input before reading any user data property.
  const anchorDescriptors = assertPlainDataObject(
    anchor,
    "formation anchor",
    ["x", "y"],
  );
  const memberArray = arrayDataDescriptors(members, "formation members");
  if (memberArray.length < 1 || memberArray.length > 15) {
    throw new RangeError("formation members must contain between 1 and 15 members");
  }
  const descriptorSets = [];
  for (let index = 0; index < memberArray.length; index += 1) {
    descriptorSets.push(
      validateMemberDescriptors(memberArray.descriptors[index].value, index),
    );
  }

  const checkedAnchor = validatePosition(
    {
      x: anchorDescriptors.x.value,
      y: anchorDescriptors.y.value,
    },
    "formation anchor",
  );
  const checkedMembers = descriptorSets.map(checkedMember);
  const ids = new Set();
  let maxRadius = 0;
  for (const member of checkedMembers) {
    if (ids.has(member.id)) {
      throw new TypeError("formation members must have unique IDs");
    }
    ids.add(member.id);
    maxRadius = Math.max(maxRadius, member.radius);
  }

  const cellSize = Math.floor(maxRadius) + 1;
  const slots = templateSlots(checkedMembers.length);
  return checkedMembers.map((member, index) => {
    const slot = slots[index];
    const offset = {
      x: slot.x * cellSize,
      y: slot.y * cellSize,
    };
    return {
      id: member.id,
      role: member.role,
      radius: member.radius,
      offset,
      position: {
        x: checkedCoordinate(
          checkedAnchor.x,
          slot.x,
          cellSize,
          `formation member ${index}.position.x`,
        ),
        y: checkedCoordinate(
          checkedAnchor.y,
          slot.y,
          cellSize,
          `formation member ${index}.position.y`,
        ),
      },
    };
  });
}
