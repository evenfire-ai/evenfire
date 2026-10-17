/**
 * `CLERUM_SERVER_HOST`: the runtime API bind address.
 *
 * Unset keeps the Node.js default (all interfaces), so existing deployments are
 * unchanged. A set value is passed to `listen()` and must be an IP literal or
 * `localhost`; a typo fails at boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseServerHost } from '../config'

describe('parseServerHost (CLERUM_SERVER_HOST)', () => {
  it.each([undefined, '', '   '])('keeps the all-interfaces default for %j', raw => {
    expect(parseServerHost(raw)).toBeUndefined()
  })

  it.each(['127.0.0.1', '0.0.0.0', '::1', '::', 'localhost', ' 10.0.0.5 '])('accepts %j', raw => {
    expect(parseServerHost(raw)).toBe(raw.trim())
  })

  it.each(['127.0.0.1:8080', 'my host', 'example.com', '256.0.0.1'])('rejects %j', raw => {
    expect(() => parseServerHost(raw)).toThrow(/CLERUM_SERVER_HOST=.* must be an IPv4\/IPv6/)
  })
})

describe('RPCServer bind address', () => {
  let stop: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  async function startServer(host?: string) {
    process.env.CLERUM_ENABLE_AUTH = 'false'
    vi.resetModules()
    const { RPCServer } = await import('../server')
    const listen = vi.spyOn(http.Server.prototype, 'listen')
    const rpcServer = new RPCServer(0, host)
    let listenArgs: unknown[] | undefined
    try {
      await rpcServer.start()
      listenArgs = listen.mock.calls[0]
    } finally {
      listen.mockRestore()
    }
    stop = () => rpcServer.stop()
    const address = (
      rpcServer as unknown as { server: { address(): AddressInfo } }
    ).server.address()
    return { listenArgs, address }
  }

  it('passes the configured host to listen()', async () => {
    const { listenArgs, address } = await startServer('127.0.0.1')
    expect(listenArgs?.slice(0, 2)).toEqual([0, '127.0.0.1'])
    expect(address.address).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
  })

  it('passes no host to listen() when unset (Node.js all-interfaces default)', async () => {
    const { listenArgs } = await startServer(undefined)
    // The first listen() argument is the port; no host string follows it.
    expect(listenArgs?.[0]).toBe(0)
    expect(typeof listenArgs?.[1]).not.toBe('string')
  })
})
