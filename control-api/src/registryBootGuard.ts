import { config } from './config.js'
import { getRegistryConnection } from './services/registryConnectionDb.js'

/**
 * Self-hosted fail-fast (spec §8 / §14.3): a registry-enabled self-hosted
 * control-api must have a claimed registry_connection row (its identity), else
 * it would silently boot unable to emit vouchers. Cannot live in config.ts
 * (synchronous, no DB access). Fail-closed at M3 — no break-glass bypass.
 *
 * C-M5: this lives in a standalone module importing ONLY config +
 * registryConnectionDb so its test doesn't pull in main.ts's server/cron graph.
 */
export async function assertRegistryConnectionReady(): Promise<void> {
  if (!config.registryAuthEnabled) return
  if (config.registryConnectionMode !== 'self-hosted') return
  const row = await getRegistryConnection()
  if (!row) {
    throw new Error(
      '[ControlAPI] self-hosted registry mode requires a registry_connection row — run the connect flow before enabling registry auth'
    )
  }
}
