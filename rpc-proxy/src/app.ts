import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { config } from './config.js'
import { stripInboundTrustedEdgeHeaders } from './middleware/auth.js'
import { createDesktopRouter } from './routes/desktopProxy.js'
import { createHealthRouter } from './routes/health.js'
import { createMcpOauthRouter } from './routes/mcpOauth.js'
import { createRpcRouter } from './routes/rpc.js'
import { createRpcHostActivityStreamRouter } from './routes/rpcHostActivityStream.js'
import { createRpcHostProgressStreamRouter } from './routes/rpcHostProgressStream.js'
import { createRpcHostStatusStreamRouter } from './routes/rpcHostStatusStream.js'
import { createSandboxUiSessionRouter } from './routes/sandboxUi.js'
import { isUpstreamTimeoutError } from './services/wakeAndHold.js'

export function createApp() {
  const app = express()

  app.use(stripInboundTrustedEdgeHeaders)

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

    res.status(500).json({
      error: 'Internal Server Error',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
  })

  return app
}
