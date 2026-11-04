function ceilingSquareRoot(value) {
  if (value < 2n) return value;
  let estimate = value;
  let next = (estimate + 1n) / 2n;
  while (next < estimate) {
    estimate = next;
    next = (estimate + value / estimate) / 2n;
  }
  return estimate * estimate === value ? estimate : estimate + 1n;
}

export function ordinaryProjectileTargetInRange(attacker, target, range) {
  const dx = BigInt(attacker.position.x) - BigInt(target.position.x);
  const dy = BigInt(attacker.position.y) - BigInt(target.position.y);
  const radius = BigInt(attacker.radius + range + target.radius);
  return dx * dx + dy * dy <= radius * radius;
}

export function ordinaryProjectileTravelTicks(attacker, target, speed, maxTick) {
  const dx = BigInt(attacker.position.x) - BigInt(target.position.x);
  const dy = BigInt(attacker.position.y) - BigInt(target.position.y);
  const distanceSquared = dx * dx + dy * dy;
  const contact = BigInt(target.radius);
  if (distanceSquared <= contact * contact) return 0;
  const velocity = BigInt(speed);
  const reached = (ticks) => {
    const distance = contact + velocity * ticks;
    return distance * distance >= distanceSquared;
  };
  let low = 0n;
  let high = 1n;
  while (!reached(high)) high *= 2n;
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    if (reached(middle)) high = middle;
    else low = middle;
  }
  if (high > BigInt(maxTick)) throw new RangeError("projectile flight exceeds tick bounds");
  return Number(high);
}

export function ordinaryProjectileImpactTargetStatus(projectile, targetStructure,
  targetHealth, controlledTargetable) {
  const structureTarget = Object.hasOwn(projectile, "structureId");
  const status = structureTarget
    ? targetStructure === null || targetStructure.structureId !== projectile.structureId ||
      targetStructure.side !== projectile.structureSide ||
      targetStructure.kind !== projectile.structureKind ||
      targetStructure.layer !== projectile.structureLayer
      ? "target_missing"
      : !targetStructure.alive || !targetStructure.targetable ? "target_dead" : "contact"
    : targetHealth === null ? "target_missing" : targetHealth.dead ? "target_dead" : "contact";
  const homing = projectile.splashProfile?.homing === true;
  const primaryTargetable = targetStructure?.targetable ?? controlledTargetable;
  return {
    homing,
    primaryTargetable,
    status: homing && status === "contact" && !primaryTargetable ? "target_missing" : status,
  };
}

export function advanceOrdinaryProjectileHoming({ position, targetPosition, targetRadius, speed }) {
  const dx = BigInt(targetPosition.x) - BigInt(position.x);
  const dy = BigInt(targetPosition.y) - BigInt(position.y);
  const distanceSquared = dx * dx + dy * dy;
  const contactDistance = BigInt(targetRadius);
  const stepDistance = BigInt(speed);
  const reach = contactDistance + stepDistance;
  if (distanceSquared <= reach * reach) {
    return { contact: true, position: { ...targetPosition } };
  }
  const distance = ceilingSquareRoot(distanceSquared);
  const stepX = dx * stepDistance / distance;
  const stepY = dy * stepDistance / distance;
  return {
    contact: false,
    position: {
      x: Number(BigInt(position.x) + stepX),
      y: Number(BigInt(position.y) + stepY),
    },
  };
}

export function advanceOrdinaryProjectileQueue({ projectiles, tick, maxTick, resolveTarget }) {
  const due = [];
  const pending = [];
  for (const projectile of projectiles) {
    if (projectile.impactTick !== tick) {
      pending.push(projectile);
      continue;
    }
    if (projectile.splashProfile?.homing !== true) {
      due.push(projectile);
      continue;
    }
    const target = resolveTarget(projectile);
    if (target === null) {
      due.push(projectile);
      continue;
    }
    const movement = advanceOrdinaryProjectileHoming({
      position: projectile.position,
      speed: projectile.speed,
      targetPosition: target.position,
      targetRadius: target.radius,
    });
    const advanced = {
      ...projectile,
      impactTick: movement.contact ? tick : tick + 1,
      position: movement.position,
      targetPosition: { ...target.position },
    };
    if (movement.contact) due.push(advanced);
    else {
      if (tick >= maxTick) {
        throw new RangeError("homing projectile continuation exceeds tick bounds");
      }
      pending.push(advanced);
    }
  }
  due.sort((left, right) => left.id - right.id);
  return { due, pending };
}

export function resolveOrdinaryProjectileHomingTarget(projectile, externalById,
  units, damage, controls) {
  const targetStructure = Object.hasOwn(projectile, "structureId")
    ? externalById.get(projectile.targetId) ?? null : null;
  const targetUnit = targetStructure === null
    ? units.find(({ id }) => id === projectile.targetId) ?? null : null;
  const targetHealth = targetUnit === null ? null : damage.get(projectile.targetId);
  const target = targetStructure ?? targetUnit;
  const available = targetStructure !== null
    ? targetStructure.structureId === projectile.structureId &&
      targetStructure.side === projectile.structureSide &&
      targetStructure.kind === projectile.structureKind &&
      targetStructure.layer === projectile.structureLayer &&
      targetStructure.alive && targetStructure.targetable
    : targetUnit !== null && targetHealth !== null && !targetHealth.dead &&
      (controls.get(projectile.targetId)?.targetable ?? true);
  return available ? target : null;
}

