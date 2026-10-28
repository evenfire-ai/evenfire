// Control API admits one password verification every 7.5 seconds across the
// server (passwordAdmissionState.ts paceMs). The pace is measured between
// client clicks, so it keeps 2.5 s for renderer, IPC and network delay before
// the server permit: an 8 s gap returned 429 rate_limited in J8. Start with a
// full interval to account for an earlier preflight or a recent lane.
const PASSWORD_PACE_MS = 10_000
let lastPasswordAttemptAt = Date.now()

export async function awaitPasswordPace(): Promise<void> {
  const waitMs = lastPasswordAttemptAt + PASSWORD_PACE_MS - Date.now()
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
  lastPasswordAttemptAt = Date.now()
}

export function deferPasswordPace(retryAfterSeconds: number): void {
  lastPasswordAttemptAt = Date.now() + retryAfterSeconds * 1000 - PASSWORD_PACE_MS
}
