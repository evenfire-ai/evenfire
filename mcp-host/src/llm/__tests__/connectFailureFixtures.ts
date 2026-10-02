/**
 * G1-7 (#720): fetch failures in the shape undici produces. A refused
 * connection comes from a real closed port; the codes a local socket cannot
 * produce (DNS, unreachable network, connect timeout) are built in the same
 * shape as the one the closed-port witness captures: a `TypeError` whose
 * `cause` carries the system or undici error code.
 */
import { type ServerResponse, createServer } from 'node:http'

const LOOPBACK_V4 = '127.0.0.1'

/** The origin of a port that was bound and then released, so nothing listens. */
export async function closedPortUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, LOOPBACK_V4, () => resolve()))
  const addr = server.address()
  if (typeof addr !== 'object' || addr === null) throw new Error('closedPortUrl: no bound address')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return `http://${LOOPBACK_V4}:${addr.port}`
}

export function fetchFailure(code: string): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  })
}

/**
 * A server that accepts a request and never answers. `received` resolves once
 * a request arrived, which proves the caller got past the connect phase.
 */
export async function silentServer(): Promise<{
  url: string
  received: Promise<void>
  close: () => Promise<void>
}> {
  const pending: ServerResponse[] = []
  let markReceived: () => void = () => undefined
  const received = new Promise<void>(resolve => {
    markReceived = resolve
  })
  const server = createServer((_req, res) => {
    pending.push(res)
    markReceived()
  })
  await new Promise<void>(resolve => server.listen(0, LOOPBACK_V4, () => resolve()))
  const addr = server.address()
  if (typeof addr !== 'object' || addr === null) throw new Error('silentServer: no bound address')
  return {
    url: `http://${LOOPBACK_V4}:${addr.port}`,
    received,
    close: async () => {
      for (const res of pending) res.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
