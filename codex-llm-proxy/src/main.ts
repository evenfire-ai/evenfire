import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { startProxy } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const servers = startProxy(config)
  const shutdown = async (signal: string) => {
    logger.info({ event: 'codex_proxy_shutdown', signal }, 'shutting down')
    await servers.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  process.stderr.write(
    `${JSON.stringify({
      svc: 'codex-llm-proxy',
      event: 'codex_proxy_fatal',
      err: err instanceof Error ? err.message : String(err),
    })}\n`
  )
  process.exit(1)
})
