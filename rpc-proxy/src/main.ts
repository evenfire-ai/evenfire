import http from 'http'
import type { Socket } from 'net'
import { createApp } from './app.js'
import { config } from './config.js'
import { handleDesktopUpgrade } from './routes/desktopProxy.js'

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

  server.listen(config.port, () => {
    console.log(`[RPC_PROXY] listening on :${config.port}`)
  })
}

bootstrap().catch(error => {
  console.error('[RPC_PROXY] failed to start:', error)
  process.exit(1)
})
