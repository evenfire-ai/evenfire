// Deferred loader for the registry test helpers. Everything here reaches
// src/db.ts, which binds the core pool to CONTROL_API_PG_CONNECTION_STRING on
// first evaluation, so it must run after gfsWatchRegistryEnv has set it. This
// module imports only types statically.
export async function loadHelpers() {
  const harness = await import('./gfsWatchRegistryHarness.js')
  const clock = await import('./gfsWatchClock.js')
  return {
    createRegistryHarness: harness.createRegistryHarness,
    nextEv: harness.nextEv,
    quoteIdent: harness.quoteIdent,
    restInvariantViolations: harness.restInvariantViolations,
    sleep: harness.sleep,
    flushMicrotasks: clock.flushMicrotasks,
  }
}

export type Loaded = Awaited<ReturnType<typeof loadHelpers>>
