// Control API admits one password verification every 7.5 seconds across the
// server. Start with a full interval to account for an earlier preflight or
// another recently completed lane.
const PASSWORD_PACE_MS = 8_000
let lastPasswordAttemptAt = Date.now()

export async function awaitPasswordPace(): Promise<void> {
  const waitMs = lastPasswordAttemptAt + PASSWORD_PACE_MS - Date.now()
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
  lastPasswordAttemptAt = Date.now()
}

export function deferPasswordPace(retryAfterSeconds: number): void {
  lastPasswordAttemptAt = Date.now() + retryAfterSeconds * 1000 - PASSWORD_PACE_MS
}
