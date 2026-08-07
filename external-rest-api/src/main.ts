import { createApp } from './app.js'
import { config } from './config.js'

async function main(): Promise<void> {
  console.log('[ProfileAPI] Starting...')

  const app = createApp()
  const server = app.listen(config.port, () => {
    console.log(`[ProfileAPI] Listening on port ${config.port}`)
  })

  const shutdown = async () => {
    console.log('[ProfileAPI] Shutting down...')
    server.close(async () => {
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(error => {
  console.error('[ProfileAPI] Fatal error:', error)
  process.exit(1)
})
