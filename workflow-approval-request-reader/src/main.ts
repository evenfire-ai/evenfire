import { config } from './config.js'
import { readerLogger } from './logger.js'
import { createServer } from './server.js'

const log = readerLogger.child({ module: 'main' })

const server = createServer().listen(config.port, () => {
  log.info('listening', { port: config.port })
})

function shutdown(signal: string): void {
  log.info('shutting down', { signal })
  server.close(() => process.exit(0))
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
