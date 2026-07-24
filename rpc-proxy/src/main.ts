import http from 'http'
import type { Socket } from 'net'
import { createApp } from './app.js'
import { config } from './config.js'
import { handleDesktopUpgrade } from './routes/desktopProxy.js'
import { hostWakeCoordinator } from './services/wakeAndHold.js'

/**
 * Bounded deadline for graceful shutdown. After the wake-and-hold coordinator
 * drains, only ordinary in-flight requests remain; if `server.close()` has not
 * completed by then we force exit rather than hang the pod termination.
 */
const SHUTDOWN_DEADLINE_MS = 10_000

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && !config.desktopApiToken) {
    console.warn(
      '[RPC_PROXY] WARNING: RPC_PROXY_DESKTOP_API_TOKEN is empty in production mode — ' +
        'rpc-proxy→HCC desktop API calls have no service-token auth. Set this to match CONTEXT_MAPPER_DESKTOP_API_TOKEN.'
    )
  }

  const app = createApp()
  const server = http.createServer(app)

  server.once('error', error => {
    console.error('[RPC_PROXY] server failed during startup:', error)
    process.exit(1)
  })

  // Handle WebSocket upgrade for desktop VNC proxy
  server.on('upgrade', (req, socket, head) => {
    const handled = handleDesktopUpgrade(req as any, socket as Socket, head)
    if (!handled) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    }
  })

  // First graceful-stop path for rpc-proxy (Issue #791 §12.2): on SIGTERM/
  // SIGINT stop accepting new connections, deterministically settle every
  // parked wake-and-hold waiter, then close the server under a bounded
  // deadline. Fail loud on close error or deadline expiry.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[RPC_PROXY] ${signal} received — draining wake holds and shutting down`)
    // Settle held requests first so `server.close()` is not blocked waiting on
    // them, then stop accepting new connections.
    hostWakeCoordinator.drain('shutdown')
    const deadline = setTimeout(() => {
      console.error(
        `[RPC_PROXY] graceful shutdown deadline (${SHUTDOWN_DEADLINE_MS}ms) exceeded — forcing exit`
      )
      process.exit(1)
    }, SHUTDOWN_DEADLINE_MS)
    deadline.unref?.()
    server.close(error => {
      clearTimeout(deadline)
      if (error) {
        console.error('[RPC_PROXY] error during server.close:', error)
        process.exit(1)
      }
      console.log('[RPC_PROXY] shutdown complete')
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  server.listen(config.port, () => {
    console.log(`[RPC_PROXY] listening on :${config.port}`)
  })
}

bootstrap().catch(error => {
  console.error('[RPC_PROXY] failed to start:', error)
  process.exit(1)
})
