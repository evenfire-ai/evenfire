import * as http from 'node:http'

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void | Promise<void>

export type CoordinatorRoute = {
  method: string
  path: string
  handler: RouteHandler
}

type MetricsRegistry = {
  contentType: string
  metrics(): Promise<string>
}

export type CoordinatorHealthServerOptions = {
  port?: number
  getPhase: () => string
  metricsRegistry: MetricsRegistry
}

export function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function writeText(
  res: http.ServerResponse,
  statusCode: number,
  body: string,
  contentType = 'text/plain'
): void {
  res.writeHead(statusCode, { 'Content-Type': contentType })
  res.end(body)
}

function findRoute(
  routes: readonly CoordinatorRoute[],
  req: http.IncomingMessage
): RouteHandler | undefined {
  const url = new URL(req.url || '/', 'http://localhost')
  const method = req.method || 'GET'
  return routes.find(route => route.method === method && route.path === url.pathname)?.handler
}

export function createCoordinatorHttpServer(routes: readonly CoordinatorRoute[]): http.Server {
  return http.createServer(async (req, res) => {
    const handler = findRoute(routes, req)
    if (!handler) {
      writeText(res, 404, '')
      return
    }
    try {
      await handler(req, res)
    } catch (err) {
      console.error('[Coordinator] Health server request failed:', err)
      writeJson(res, 500, { status: 'error' })
    }
  })
}

export function startCoordinatorHealthServer({
  port = 8090,
  getPhase,
  metricsRegistry,
}: CoordinatorHealthServerOptions): http.Server {
  const routes: CoordinatorRoute[] = [
    {
      method: 'GET',
      path: '/health',
      handler: (_req, res) => {
        writeJson(res, 200, { status: 'ok', phase: getPhase() })
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      handler: async (_req, res) => {
        const metrics = await metricsRegistry.metrics()
        writeText(res, 200, metrics, metricsRegistry.contentType)
      },
    },
  ]

  const server = createCoordinatorHttpServer(routes)
  server.listen(port, () => {
    console.log(`[Coordinator] Health server listening on :${port}`)
  })
  return server
}
