/**
 * workspace-files-controller — process entry point.
 */
import { loadConfig } from './config'
import { logger } from './logger'
import { startPr2ReadinessReporter } from './pr2ReadinessReporter'
import { createApp } from './server'

async function main(): Promise<void> {
  const config = loadConfig()
  logger.info(
    {
      port: config.port,
      mountPath: config.mountPath,
      sharedFileSystem: `${config.sharedFileSystemNamespace}/${config.sharedFileSystemName}`,
      maxUploadBytes: config.maxUploadBytes,
      maxListEntries: config.maxListEntries,
      maxPathDepth: config.maxPathDepth,
    },
    'workspace-files-controller starting'
  )

  const app = createApp(config)
  let stopReadinessReporter: () => void = () => undefined
  const server = app.listen(config.port, () => {
    stopReadinessReporter = startPr2ReadinessReporter({
      baseUrl: config.controlApiBaseUrl!,
      serviceToken: config.controlApiServiceToken!,
    })
    logger.info({ port: config.port }, 'wfc listening')
  })

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down')
    stopReadinessReporter()
    server.close(() => {
      logger.info('http server closed')
      process.exit(0)
    })
    setTimeout(() => {
      logger.error('forced exit after shutdown timeout')
      process.exit(1)
    }, 10_000).unref()
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

main().catch(err => {
  logger.error({ err }, 'fatal error')
  process.exit(1)
})
