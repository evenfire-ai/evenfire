import { config } from './config.js'
import { rootLogger } from './observability/logger.js'
import { getRegistryConnection } from './services/registryConnectionDb.js'

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
 * Standalone module importing only config + logger + registryConnectionDb, so
 * its test does not pull in main.ts's server/cron graph.
 */
export async function logRegistryConnectionState(): Promise<void> {
  if (config.registryConnectionMode !== 'self-hosted') return
  if (config.registryUrl === '') return
  const row = await getRegistryConnection()
  const connected = row?.clientId != null
  rootLogger.info(
    { event: 'registry_connection_state', connected },
    connected
      ? 'self-hosted registry connection present'
      : 'self-hosted registry not yet connected — auth inactive until the connect flow completes'
  )
}
