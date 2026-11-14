import { config } from './config.js'
import { decisionAdmissionRetries } from './decisionAdmissionRetry.js'
import { readerLogger } from './logger.js'
import { createServer } from './server.js'

const log = readerLogger.child({ module: 'main' })

const server = createServer().listen(config.port, () => {
  log.info('listening', { port: config.port })
})

function shutdown(signal: string): void {
  // Pending decision retries are dropped, not sent while the pod drains.
  const cancelled = decisionAdmissionRetries.close()
  log.info('shutting down', { signal, cancelledDecisionRetries: cancelled })
  server.close(() => process.exit(0))
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
