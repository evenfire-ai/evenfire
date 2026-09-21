import { afterEach, expect, it } from 'vitest'
import { type Server, createServer } from 'node:http'

// Witness that `scripts/testing/bind-loopback-in-tests.mjs` is registered in
// this package's vitest `setupFiles`.
//
// That setup file makes a host-less `listen(0)` bind the IPv4 loopback instead
// of the dual-stack wildcard, which is what stops a test server from being
// handed an ephemeral port another process already holds on 127.0.0.1. A
// package that forgets to register it keeps the defect and says nothing: every
// test still passes, and the collision resurfaces later as a parse error, a
// bogus status code or a socket hang up that reads as flakiness.
//
// So this file is the signal. It fails the moment the registration is dropped,
// renamed or moved.
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  )
})

function boundAddress(server: Server): string {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`expected a bound TCP address, got ${JSON.stringify(address)}`)
  }
  return address.address
}

function track(server: Server): Server {
  servers.push(server)
  return server
}

it('binds an ephemeral port on the IPv4 loopback when the caller gives no host', async () => {
  const numeric = track(createServer())
  await new Promise<void>(resolve => {
    numeric.listen(0, () => resolve())
  })
  expect(boundAddress(numeric)).toBe('127.0.0.1')

  // The options form reaches the same kernel default and needs the same fix.
  const options = track(createServer())
  await new Promise<void>(resolve => {
    options.listen({ port: 0 }, () => resolve())
  })
  expect(boundAddress(options)).toBe('127.0.0.1')
})

it('leaves a host the caller asked for alone', async () => {
  // The setup file rewrites only the case where the caller expressed no
  // preference. A test that wants the wildcard still gets it.
  const explicit = track(createServer())
  await new Promise<void>(resolve => {
    explicit.listen(0, '0.0.0.0', () => resolve())
  })
  expect(boundAddress(explicit)).toBe('0.0.0.0')
})
