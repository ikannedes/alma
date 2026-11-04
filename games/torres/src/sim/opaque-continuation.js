export function assertOpaqueContinuationHandle(handle) {
  if (Object.getPrototypeOf(handle) !== null || !Object.isFrozen(handle) ||
      Reflect.ownKeys(handle).length !== 0 || JSON.stringify(handle) !== "{}" ||
      ["fork", "replay", "restore", "serialize"].some((name) => name in handle)) {
    throw new Error("internal compact continuation handle is observable");
  }
}

// Bootstrap the shape invariant once as well as for each issued handle. The
// value is module lexical and deliberately has no identity-bearing fields.
assertOpaqueContinuationHandle(Object.freeze(Object.create(null)));

export function opaqueContinuation(copy, register) {
  const runtimes = new WeakMap();
  const issue = (value) => {
    // Validate and clone before allocating the capability. An invalid receiver
    // therefore leaves the capability map and owning transaction untouched.
    const runtime = copy(value);
    const handle = Object.freeze(Object.create(null));
    assertOpaqueContinuationHandle(handle);
    runtimes.set(handle, runtime);
    return handle;
  };
  const resolve = (handle) => {
    // WeakMap identity admission never invokes traps on forged, proxied, or
    // revoked candidate handles. Only a handle issued by this lexical scope
    // reaches an underlying runtime.
    if (!runtimes.has(handle)) {
      throw new TypeError("internal compact continuation handle is invalid");
    }
    return runtimes.get(handle);
  };
  register(issue, resolve);
}
