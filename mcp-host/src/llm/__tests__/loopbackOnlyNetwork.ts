import { vi } from 'vitest'
import net from 'node:net'

/**
 * Test-only guard: any TCP connection to a host other than the loopback
 * interface throws before a packet leaves. Provider SDKs fall back to their
 * real endpoints when a transport seam does not intercept, so the tests that
 * drive real SDKs install this in `beforeEach` and restore it in `afterEach`.
 * Unix-socket and port-only connections (no host) stay allowed.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'])

function hostOf(args: unknown[]): string | undefined {
  const [first, second] = args
  if (Array.isArray(first)) return hostOf(first)
  if (first !== null && typeof first === 'object') {
    const options = first as { host?: unknown; path?: unknown }
    if (typeof options.path === 'string') return undefined
    return typeof options.host === 'string' ? options.host : undefined
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return typeof second === 'string' ? second : undefined
  }
  return undefined
}

export function installLoopbackOnlyNetwork(): void {
  const original = net.Socket.prototype.connect
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const host = hostOf(args)
    if (host !== undefined && !LOOPBACK.has(host)) {
      throw new Error(`loopback-only test network: refused a connection to ${host}`)
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args)
  })
}
