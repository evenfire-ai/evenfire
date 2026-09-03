import { Server as TlsServer } from 'node:tls'
import request from 'supertest'

type SupertestImplicitServer = {
  address: () => { port: number } | string | null
  close: (callback?: (err?: Error & { code?: string }) => void) => unknown
  closeAllConnections?: () => void
  listening?: boolean
  listen: (port: number, host: string) => SupertestImplicitServer
  once?: (event: 'listening', callback: () => void) => unknown
  __evenfireCloseAllBeforeClose?: true
}

type SupertestRequest = typeof request & {
  Test?: {
    prototype: {
      end: (callback?: unknown) => unknown
      serverAddress: (app: SupertestImplicitServer, path: string) => string
      __evenfireImplicitServerClosePatched?: true
    }
  }
}

type SupertestContext = {
  _server?: SupertestImplicitServer
  url: string
  __evenfireImplicitServerPath?: string
  __evenfireImplicitServerProtocol?: 'http' | 'https'
}

const supertestRequest = request as SupertestRequest
const supertestPrototype = supertestRequest.Test?.prototype

if (supertestPrototype && !supertestPrototype.__evenfireImplicitServerClosePatched) {
  const originalEnd = supertestPrototype.end
  const originalServerAddress = supertestPrototype.serverAddress

  supertestPrototype.serverAddress = function evenfireDeferredLoopbackServerAddress(
    this: SupertestContext,
    app: SupertestImplicitServer,
    path: string
  ) {
    const address = app.address()

    if (!address) {
      this._server = app
      this.__evenfireImplicitServerPath = path
      this.__evenfireImplicitServerProtocol = app instanceof TlsServer ? 'https' : 'http'
      return `${this.__evenfireImplicitServerProtocol}://127.0.0.1:0${path}`
    }

    return originalServerAddress.call(this, app, path)
  }

  supertestPrototype.end = function evenfireEndWithClosedImplicitConnections(
    this: SupertestContext,
    callback?: unknown
  ) {
    const server = this._server

    if (server) {
      if (
        typeof server.closeAllConnections === 'function' &&
        !server.__evenfireCloseAllBeforeClose
      ) {
        const originalClose = server.close.bind(server)
        server.close = closeCallback => {
          server.closeAllConnections?.()
          return originalClose(closeCallback)
        }
        server.__evenfireCloseAllBeforeClose = true
      }

      if (!server.listening && this.__evenfireImplicitServerPath) {
        server.once?.('listening', () => {
          const address = server.address()
          if (!address || typeof address === 'string') {
            throw new Error('Supertest implicit server did not expose a TCP port')
          }
          this.url = `${this.__evenfireImplicitServerProtocol ?? 'http'}://127.0.0.1:${
            address.port
          }${this.__evenfireImplicitServerPath}`
          originalEnd.call(this, callback)
        })
        server.listen(0, '127.0.0.1')
        return this
      }

      if (!server.listening && typeof server.once === 'function') {
        server.once('listening', () => {
          originalEnd.call(this, callback)
        })
        return this
      }
    }

    return originalEnd.call(this, callback)
  }

  supertestPrototype.__evenfireImplicitServerClosePatched = true
}

/**
 * Real-Postgres suites are intentionally opt-in for the ordinary unit matrix.
 * A gate that explicitly requests them must never turn a missing DSN into a
 * green run with skipped files.
 */
if (
  process.env.CONTROL_API_REAL_PG_REQUIRED === '1' &&
  !process.env.CONTROL_API_REAL_PG_ADMIN_URL
) {
  throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required when CONTROL_API_REAL_PG_REQUIRED=1')
}
