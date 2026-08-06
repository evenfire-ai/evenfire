import { loadConfig } from './config'
import { start } from './server'

async function main(): Promise<void> {
  const config = loadConfig()
  const handle = start(config)
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ svc: 'auth-proxy', msg: `shutdown:${signal}` }))
    await handle.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({ svc: 'auth-proxy', fatal: err instanceof Error ? err.message : String(err) })
  )
  process.exit(1)
})
