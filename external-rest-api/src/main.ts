import { createApp } from './app.js'
import { config } from './config.js'
import { startPr2ReadinessReporter } from './pr2ReadinessReporter.js'

async function main(): Promise<void> {
  console.log('[ProfileAPI] Starting...')

  const app = createApp()
  let stopReadinessReporter: () => void = () => undefined
  const server = app.listen(config.port, () => {
    stopReadinessReporter = startPr2ReadinessReporter()
    console.log(`[ProfileAPI] Listening on port ${config.port}`)
  })

  const shutdown = async () => {
    console.log('[ProfileAPI] Shutting down...')
    stopReadinessReporter()
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
