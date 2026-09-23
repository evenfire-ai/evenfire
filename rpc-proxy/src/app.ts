import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { config } from './config.js'
import { createDesktopRouter } from './routes/desktopProxy.js'
import { createHealthRouter } from './routes/health.js'
import { createMcpOauthRouter } from './routes/mcpOauth.js'
import { createRpcRouter } from './routes/rpc.js'
import { createRpcHostActivityStreamRouter } from './routes/rpcHostActivityStream.js'
import { createRpcHostProgressStreamRouter } from './routes/rpcHostProgressStream.js'
import { createRpcHostStatusStreamRouter } from './routes/rpcHostStatusStream.js'
import { createSandboxUiSessionRouter } from './routes/sandboxUi.js'
import { isUpstreamTimeoutError } from './services/wakeAndHold.js'

/**
 * body-parser flags a request whose declared/streamed body crossed the parser's
 * `limit` with `type: 'entity.too.large'`. The terminal error handler below
 * would otherwise report it as a 500, which reads like a server fault for what
 * is a client-sized payload; mcp-host answers the same condition with 413.
 */
function isEntityTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.too.large'
  )
}

export function createApp() {
  const app = express()

  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin,
      credentials: true,
    })
  )

  app.use(createHealthRouter())

  const api = express.Router()
  api.use(createRpcRouter())
  api.use(createRpcHostStatusStreamRouter())
  api.use(createRpcHostActivityStreamRouter())
  api.use(createRpcHostProgressStreamRouter())
  api.use(createDesktopRouter())
  api.use(createSandboxUiSessionRouter())
  api.use(createMcpOauthRouter())
  app.use('/api/v1', api)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' })
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isUpstreamTimeoutError(err)) {
      res.status(504).json({ error: 'Gateway Timeout' })
      return
    }

    if (isEntityTooLargeError(err)) {
      res.status(413).json({ error: 'Payload Too Large' })
      return
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
  })

  return app
}
