// @vitest-environment node
/**
 * Records what Control UI's control-api proxy (../route.ts) answers when
 * control-api does not: 504 when the upstream request outlives
 * CONTROL_API_PROXY_TIMEOUT_MS, 502 when it fails. Control UI tests replay these
 * bodies, for example through the fake control-api's `respondWith`.
 *
 * The upstream is a real local HTTP server and the route uses the runtime's own
 * fetch, so each message is the runtime's, not one a test wrote. The test runs
 * in the Node environment, the route's own runtime (`runtime = 'nodejs'`).
 *
 * With UPDATE_WIRE_GOLDENS=1 the test writes test/fixtures/wire/proxy-504.wire.json and
 * proxy-502.wire.json; otherwise it asserts they are unchanged.
 */
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const WIRE_DIR = resolve(__dirname, '../../../../test/fixtures/wire')

// The upstream holds every request on this path and resets the connection of
// every other one.
const SILENT_PATH = '/api/v1/admin/hosts/silent'
const FAILING_PATH = '/api/v1/admin/hosts/failing'
const PROXY_TIMEOUT_MS = '100'

type Route = typeof import('../route')

let upstream: Server
let route: Route
const savedEnv = {
  url: process.env.CONTROL_API_INTERNAL_URL,
  timeout: process.env.CONTROL_API_PROXY_TIMEOUT_MS,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** A Host save as Control UI sends it, through the proxy. */
function hostPut(path: string): Parameters<Route['PUT']> {
  const request = new NextRequest(`http://control-ui.test/control-api${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec: { contextRef: 'ctx-a' } }),
  })
  return [request, { params: { path: path.split('/').filter(Boolean) } }]
}

function pinWire(file: string, value: unknown): void {
  const path = resolve(WIRE_DIR, file)
  if (UPDATE) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  expect(value, file).toEqual(JSON.parse(readFileSync(path, 'utf8')))
}

describe('control-api proxy answers when control-api does not', () => {
  beforeAll(async () => {
    upstream = createServer(request => {
      if (request.url !== SILENT_PATH) request.socket.destroy()
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const { address, port } = upstream.address() as AddressInfo
    // Read once, when the route module loads.
    process.env.CONTROL_API_INTERNAL_URL = `http://${address}:${port}`
    route = await import('../route')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreEnv('CONTROL_API_PROXY_TIMEOUT_MS', savedEnv.timeout)
  })

  afterAll(async () => {
    upstream.closeAllConnections()
    upstream.close()
    await once(upstream, 'close')
    restoreEnv('CONTROL_API_INTERNAL_URL', savedEnv.url)
  })

  it('answers 504 when the upstream request outlives the proxy timeout', async () => {
    // Read per request. Only this case arms the short timeout, so it can never
    // beat the connection reset of the 502 case.
    process.env.CONTROL_API_PROXY_TIMEOUT_MS = PROXY_TIMEOUT_MS
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await route.PUT(...hostPut(SILENT_PATH))

    const wire = { status: response.status, body: (await response.json()) as unknown }
    expect(wire.status).toBe(504)
    expect(logged).toHaveBeenCalledWith(
      '[control-api proxy] request failed',
      expect.objectContaining({ method: 'PUT', status: 504, name: 'TimeoutError' })
    )
    pinWire('proxy-504.wire.json', wire)
  })

  it('answers 502 when the upstream request fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await route.PUT(...hostPut(FAILING_PATH))

    const wire = { status: response.status, body: (await response.json()) as unknown }
    expect(wire.status).toBe(502)
    expect(logged).toHaveBeenCalledWith(
      '[control-api proxy] request failed',
      expect.objectContaining({ method: 'PUT', status: 502 })
    )
    pinWire('proxy-502.wire.json', wire)
  })
})
