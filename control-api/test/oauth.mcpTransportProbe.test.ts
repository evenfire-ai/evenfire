import { describe, expect, it, vi } from 'vitest'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import { classifyInitializeResponse, probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import { PILOTS, VERCEL_PILOT, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'

/**
 * MCP transport probe (issue 26-09-25, mini-spec D3). Fixtures are the real 2026-09-25
 * POST `initialize` bytes (T1). `classifyInitializeResponse` is exercised per decision-
 * table row (T5); `probeMcpTransport` is driven through the injected pinned transport
 * + `resolveDns`, so the pin and kernel run with zero real network.
 */
const PUBLIC_IP = '93.184.216.34'
const publicDns = () => vi.fn(async () => [PUBLIC_IP])

/** Record every hop the pinned transport receives, then delegate to the fixture base. */
function recordingTransport(base: PinnedTransport): {
  transport: PinnedTransport
  calls: Array<{
    url: string
    method?: string
    headers: Record<string, string>
    body?: string
    readBody?: boolean
  }>
} {
  const calls: Array<{
    url: string
    method?: string
    headers: Record<string, string>
    body?: string
    readBody?: boolean
  }> = []
  const transport: PinnedTransport = async input => {
    calls.push({
      url: input.url,
      method: input.method,
      headers: input.headers,
      body: input.body,
      readBody: input.readBody,
    })
    return base(input)
  }
  return { transport, calls }
}

describe('classifyInitializeResponse — decision table (T5, one per row)', () => {
  it('200 → alive, no challenge', () => {
    expect(classifyInitializeResponse(200, {})).toEqual({ status: 'alive', challenge: false })
  })
  it('202 → alive, no challenge', () => {
    expect(classifyInitializeResponse(202, {})).toEqual({ status: 'alive', challenge: false })
  })
  it('401 with www-authenticate → alive, challenge true', () => {
    expect(classifyInitializeResponse(401, { 'www-authenticate': 'Bearer realm="OAuth"' })).toEqual(
      {
        status: 'alive',
        challenge: true,
      }
    )
  })
  it('401 without www-authenticate → alive, challenge false', () => {
    expect(classifyInitializeResponse(401, {})).toEqual({ status: 'alive', challenge: false })
  })
  it('403 → alive, no challenge', () => {
    expect(classifyInitializeResponse(403, {})).toEqual({ status: 'alive', challenge: false })
  })
  it('404 → dead', () => {
    expect(classifyInitializeResponse(404, {})).toEqual({ status: 'dead' })
  })
  it('405 → dead', () => {
    expect(classifyInitializeResponse(405, {})).toEqual({ status: 'dead' })
  })
  it('302 (3xx) → inconclusive/redirect', () => {
    expect(classifyInitializeResponse(302, {})).toEqual({
      status: 'inconclusive',
      reason: 'redirect',
    })
  })
  it('400 (other 4xx) → inconclusive/unexpected_status', () => {
    expect(classifyInitializeResponse(400, {})).toEqual({
      status: 'inconclusive',
      reason: 'unexpected_status',
    })
  })
  it('500 (5xx) → inconclusive/unexpected_status', () => {
    expect(classifyInitializeResponse(500, {})).toEqual({
      status: 'inconclusive',
      reason: 'unexpected_status',
    })
  })
})

describe('probeMcpTransport — Vercel /mcp is dead, suggests the root (repro)', () => {
  it('POSTs a tokenless initialize, classifies dead, and suggests the canonical root', async () => {
    const { transport, calls } = recordingTransport(makeDiscoveryTransport(VERCEL_PILOT))
    const resolveDns = publicDns()

    const outcome = await probeMcpTransport(VERCEL_PILOT.mcpUrl, { transport, resolveDns })

    // Dead at the typed path, with the canonical-root suggestion derived from the root PRM.
    expect(outcome).toEqual({
      status: 'dead',
      probedUrl: 'https://mcp.vercel.com/mcp',
      httpStatus: 404,
      suggestedBaseUrl: 'https://mcp.vercel.com/',
    })

    // The transport saw exactly: POST /mcp, GET root PRM, POST / (the candidate probe).
    expect(calls.map(c => c.url)).toEqual([
      'https://mcp.vercel.com/mcp',
      'https://mcp.vercel.com/.well-known/oauth-protected-resource',
      'https://mcp.vercel.com/',
    ])

    // The initial probe: POST, correct Accept, header-only, a real `initialize` body.
    const initial = calls[0]
    expect(initial.method).toBe('POST')
    expect(initial.headers.accept).toBe('application/json, text/event-stream')
    expect(initial.headers['content-type']).toBe('application/json')
    expect(initial.readBody).toBe(false)
    const parsedBody = JSON.parse(initial.body ?? '{}')
    expect(parsedBody.method).toBe('initialize')
    expect(parsedBody.params.clientInfo.name).toBe('clerum-control-api-probe')

    // The candidate probe is a POST too.
    expect(calls[2].method).toBe('POST')
  })
})

describe('probeMcpTransport — the four CIMD pilots are alive with a challenge', () => {
  for (const key of ['notion', 'linear', 'sentry', 'canva'] as const) {
    it(`${key}: 401 initialize → alive, challenge true`, async () => {
      const pilot = PILOTS[key]
      const outcome = await probeMcpTransport(pilot.mcpUrl, {
        transport: makeDiscoveryTransport(pilot),
        resolveDns: publicDns(),
      })
      expect(outcome.status).toBe('alive')
      if (outcome.status !== 'alive') return
      expect(outcome.challenge).toBe(true)
      expect(outcome.httpStatus).toBe(401)
    })
  }
})

describe('probeMcpTransport — IP pin', () => {
  it('resolves DNS and pins the socket to the validated IP', async () => {
    const resolveDns = vi.fn(async () => [PUBLIC_IP])
    const connectedIps: string[] = []
    const base = makeDiscoveryTransport(PILOTS.notion)
    const transport: PinnedTransport = async input => {
      await new Promise<void>(resolve => {
        input.lookup(
          new URL(input.url).hostname,
          { all: true } as never,
          ((_err: Error | null, addrs: string | Array<{ address: string }>) => {
            const list = Array.isArray(addrs) ? addrs : [{ address: addrs as string }]
            list.forEach(a => connectedIps.push(a.address))
            resolve()
          }) as never
        )
      })
      return base(input)
    }

    const outcome = await probeMcpTransport(PILOTS.notion.mcpUrl, { transport, resolveDns })
    expect(outcome.status).toBe('alive')
    expect(resolveDns).toHaveBeenCalled()
    expect(connectedIps.length).toBeGreaterThan(0)
    connectedIps.forEach(ip => expect(ip).toBe(PUBLIC_IP))
  })
})

describe('probeMcpTransport — SSRF kernel', () => {
  it('a host resolving to a metadata IP is rejected before the transport is called', async () => {
    const transport = vi.fn<PinnedTransport>(async () => ({
      status: 200,
      headers: {},
      bodyText: '',
    }))
    const outcome = await probeMcpTransport('https://mcp.notion.com/mcp', {
      transport,
      resolveDns: async () => ['169.254.169.254'],
    })
    expect(outcome.status).toBe('inconclusive')
    if (outcome.status !== 'inconclusive') return
    expect(outcome.reason).toBe('kernel_rejected')
    // Fail-closed: nothing was fetched.
    expect(transport).not.toHaveBeenCalled()
  })
})
