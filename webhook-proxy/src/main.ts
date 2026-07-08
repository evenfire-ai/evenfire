import { loadConfig } from './config'
import { RegistryClient } from './registry'
import { start } from './server'

async function main(): Promise<void> {
  const config = loadConfig()
  const registry = new RegistryClient(config)
  const handle = start(config, registry)
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ svc: 'webhook-proxy', msg: `shutdown:${signal}` }))
    await handle.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ svc: 'webhook-proxy', fatal: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
