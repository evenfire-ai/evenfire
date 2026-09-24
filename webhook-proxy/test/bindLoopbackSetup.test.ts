import { afterEach, expect, it } from 'vitest'
import dns from 'node:dns'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// Witness that `scripts/testing/bind-loopback-in-tests.mjs` is registered in
// this package's vitest `setupFiles`. A package that forgets to register it
// keeps the defect and says nothing: every test still passes while its ephemeral
// binds go back to the dual-stack wildcard, where another process holding the
// same port on `127.0.0.1` receives the test's own requests.
//
// The synchronous reads below are the point, not incidental. supertest calls
// `app.listen(0)` and reads `app.address().port` on the next line
// (`supertest/lib/test.js:63-67`), so a setup file that reaches loopback through
// an asynchronous host resolution satisfies a witness that awaits `listening`
// and still breaks every supertest suite. That revision shipped once; these
// assertions are what would have stopped it.
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  )
})

function track(server: Server): Server {
  servers.push(server)
  return server
}

function boundAddress(server: Server): AddressInfo {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`expected a bound TCP address, got ${JSON.stringify(address)}`)
  }
  return address
}

it('binds an ephemeral port on the IPv4 loopback, readably, before listen() returns', () => {
  const numeric = track(createServer())
  numeric.listen(0)
  const numericAddress = boundAddress(numeric)
  expect(numericAddress.address).toBe('127.0.0.1')
  expect(numericAddress.port).toBeGreaterThan(0)

  const options = track(createServer())
  options.listen({ port: 0 })
  const optionsAddress = boundAddress(options)
  expect(optionsAddress.address).toBe('127.0.0.1')
  expect(optionsAddress.port).toBeGreaterThan(0)
})

it('leaves a host the caller asked for alone', async () => {
  const explicit = track(createServer())
  await new Promise<void>(resolve => {
    explicit.listen(0, '0.0.0.0', () => resolve())
  })
  expect(boundAddress(explicit).address).toBe('0.0.0.0')
})

it('leaves node:dns as it found it once listen() has returned', () => {
  const beforeListen = dns.lookup
  track(createServer()).listen(0)
  expect(dns.lookup).toBe(beforeListen)
})
