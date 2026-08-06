import { pool } from '../db.js'

const DEFAULT_BATCH_SIZE = 1_000
let intervalHandle: ReturnType<typeof setInterval> | null = null
let running = false

export async function cleanupIdentityProviderOAuthArtifacts(
  batchSize = DEFAULT_BATCH_SIZE
): Promise<{ states: number; loginCodes: number }> {
  const boundedBatchSize = Number.isFinite(batchSize)
    ? Math.max(1, Math.min(10_000, Math.floor(batchSize)))
    : DEFAULT_BATCH_SIZE
  const [states, loginCodes] = await Promise.all([
    pool.query(
      `WITH expired AS (
         SELECT state_hash
           FROM identity_provider_oauth_states
          WHERE expires_at < NOW()
             OR consumed_at < NOW() - INTERVAL '15 minutes'
          ORDER BY expires_at ASC
          LIMIT $1
       )
       DELETE FROM identity_provider_oauth_states target
        USING expired
        WHERE target.state_hash = expired.state_hash`,
      [boundedBatchSize]
    ),
    pool.query(
      `WITH expired AS (
         SELECT code_hash
           FROM identity_provider_login_codes
          WHERE expires_at < NOW()
             OR consumed_at < NOW() - INTERVAL '15 minutes'
          ORDER BY expires_at ASC
          LIMIT $1
       )
       DELETE FROM identity_provider_login_codes target
        USING expired
        WHERE target.code_hash = expired.code_hash`,
      [boundedBatchSize]
    ),
  ])
  return { states: states.rowCount ?? 0, loginCodes: loginCodes.rowCount ?? 0 }
}

export function startIdentityProviderOAuthCleanup(intervalMs: number): void {
  if (intervalHandle) return
  const safeIntervalMs = Number.isFinite(intervalMs) ? Math.max(30_000, intervalMs) : 5 * 60_000
  const run = async () => {
    if (running) return
    running = true
    try {
      await cleanupIdentityProviderOAuthArtifacts()
    } catch (error) {
      console.warn('[ControlAPI] Identity provider OAuth cleanup failed:', error)
    } finally {
      running = false
    }
  }
  void run()
  intervalHandle = setInterval(run, safeIntervalMs)
  intervalHandle.unref()
}

export function stopIdentityProviderOAuthCleanup(): void {
  if (intervalHandle) clearInterval(intervalHandle)
  intervalHandle = null
  running = false
}
