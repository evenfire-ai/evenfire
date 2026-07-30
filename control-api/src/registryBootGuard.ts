import { config } from './config.js'
import { rootLogger } from './observability/logger.js'
import { getRegistryConnection } from './services/registryConnectionDb.js'
import type { RegistryConnectionRow } from './services/registryConnectionDb.js'

/**
 * Boot-time observability for the self-hosted registry identity.
 *
 * This used to be a fail-fast guard that threw when registry auth was enabled
 * without a connection row. With auth now DERIVED from credential presence,
 * that state is unrepresentable — and throwing would have been a boot-order
 * deadlock: control-api could not start without a connection, and a connection
 * could not be made without a running control-api.
 *
 * It still logs, because "no row" has two very different causes: a fresh
 * install that has not connected yet (normal), and a deployment whose row
 * disappeared (bad restore, accidental delete). INFO rather than WARN so it
 * does not cry wolf on every first boot.
 *
 * The read itself is guarded separately: this now runs for every self-hosted
 * deployment on every boot (not just when auth was enabled), so a rotated
 * CLERUM_OAUTH_ENCRYPTION_KEY, a Postgres volume restored alongside a
 * different key Secret, or a transient pool blip can make getRegistryConnection
 * reject. That rejection must never escape — it would otherwise turn a
 * deployment that used to boot fine into a crashloop. WARN (not INFO) here,
 * because an unreadable row is a real operational problem, unlike a merely
 * absent one.
 *
 * Standalone module importing only config + logger + registryConnectionDb, so
 * its test does not pull in main.ts's server/cron graph.
 */
export async function logRegistryConnectionState(): Promise<void> {
  if (config.registryConnectionMode !== 'self-hosted') return
  let row: RegistryConnectionRow | null = null
  try {
    row = await getRegistryConnection()
  } catch (err) {
    rootLogger.warn(
      { event: 'registry_connection_state_unreadable', err: (err as Error).message },
      'could not read the registry connection row at boot'
    )
    return
  }
  const connected = row?.clientId != null
  rootLogger.info(
    { event: 'registry_connection_state', connected },
    connected
      ? 'self-hosted registry connection present'
      : 'self-hosted registry not yet connected — auth inactive until the connect flow completes'
  )
}
