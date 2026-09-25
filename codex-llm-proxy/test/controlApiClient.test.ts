import { createServer, type IncomingMessage, type Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  CONTROL_API_REQUEST_TIMEOUT_MS,
  ControlApiClient,
  ControlApiClientError,
} from '../src/controlApiClient.js'
import { CODEX_CATALOG_ORIGIN, CODEX_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'

const LOOPBACK_V4 = ['127', '0', '0', '1'].join('.')

function listen(handler: (req: IncomingMessage, body: unknown, res: Server) => void): Promise<{
  url: string
  close: () => Promise<void>
  requests: Array<{ url: string; headers: IncomingMessage['headers']; body: unknown }>
}> {
  const requests: Array<{ url: string; headers: IncomingMessage['headers']; body: unknown }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : {}
      requests.push({ url: String(req.url), headers: req.headers, body })
      handler(req, body, res as unknown as Server)
      if (!res.writableEnded) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            accessToken: 'tok-live',
            transport: {
              protocolVersion: 'codex-subscription-transport.v1',
              completionsOrigin: 'https://chatgpt.com/backend-api/codex/responses',
              catalogOrigin: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
              operation: 'completion_stream',
              servedModel: 'gpt-5.1',
              maxStreamDurationMs: 1800000,
            },
            expiryClass: 'short_lived',
            attemptReceipt: 'a'.repeat(64),
          })
        )
      }
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://${LOOPBACK_V4}:${port}`,
        requests,
        close: () =>
          new Promise(done => {
            server.close(() => done())
          }),
      })
    })
  })
}

describe('ControlApiClient', () => {
  it('redeems and finalizes with the dedicated service identity and no token cache', async () => {
    const seenTokens: string[] = []
    const server = await listen((req, body, res) => {
      if (String(req.url).endsWith('/redeem')) {
        seenTokens.push(String((body as { executionTicket: string }).executionTicket))
      }
      if (String(req.url).endsWith('/finalize')) {
        // control-api echoes the persisted terminal outcome on finalize.
        const raw = res as unknown as {
          statusCode: number
          setHeader: (name: string, value: string) => void
          end: (chunk: string) => void
        }
        raw.statusCode = 200
        raw.setHeader('content-type', 'application/json')
        raw.end(JSON.stringify({ providerAttemptId: 'att-1', outcome: 'success', duplicate: false }))
      }
    })
    try {
      const client = new ControlApiClient({
        baseUrl: `${server.url}/api/v1`,
        serviceName: 'codex-llm-proxy',
        serviceToken: 'dev-codex-llm-proxy-token',
      })
      const first = await client.redeem({
        executionTicket: 'ticket-1',
        requestHash: 'b'.repeat(64),
        model: 'gpt-5.1',
        operation: 'completion_stream',
      })
      const second = await client.redeem({
        executionTicket: 'ticket-2',
        requestHash: 'c'.repeat(64),
        model: 'gpt-5.1',
        operation: 'completion_stream',
      })
      expect(first.accessToken).toBe('tok-live')
      expect(second.accessToken).toBe('tok-live')
      expect(seenTokens).toEqual(['ticket-1', 'ticket-2'])
      expect(server.requests[0]?.headers['x-service-token']).toBe('codex-llm-proxy')
      expect(String(server.requests[0]?.headers.authorization)).toContain('dev-codex-llm-proxy-token')

      const finalized = await client.finalize({
        attemptReceipt: 'a'.repeat(64),
        receipt: {
          schemaVersion: 'codex-attempt-receipt.v1',
          providerAttemptId: 'att-1',
          requestHash: 'b'.repeat(64),
          outcome: 'success',
        },
      })
      expect(finalized).toMatchObject({ outcome: 'success' })
      expect(server.requests.some(item => item.url?.includes('/finalize'))).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('maps redeem failures to bounded codes and never retries an ambiguous attempt', async () => {
    const server = await listen((req, _body, res) => {
      ;(res as unknown as { statusCode: number; setHeader: Function; end: Function }).statusCode = 409
      ;(res as unknown as { setHeader: Function }).setHeader('content-type', 'application/json')
      ;(res as unknown as { end: Function }).end(JSON.stringify({ error: 'ticket_replayed' }))
    })
    try {
      const client = new ControlApiClient({
        baseUrl: `${server.url}/api/v1`,
        serviceName: 'codex-llm-proxy',
        serviceToken: 'dev-codex-llm-proxy-token',
      })
      await expect(
        client.redeem({
          executionTicket: 'replay',
          requestHash: 'd'.repeat(64),
          operation: 'completion_stream',
        })
      ).rejects.toMatchObject({ code: 'ticket_replayed' } satisfies Partial<ControlApiClientError>)
    } finally {
      await server.close()
    }
  })
})

describe('ControlApiClient response hardening', () => {
  function jsonServer(body: unknown) {
    return listen((_req, _body, res) => {
      const raw = res as unknown as {
        statusCode: number
        setHeader: (name: string, value: string) => void
        end: (chunk: string) => void
      }
      raw.statusCode = 200
      raw.setHeader('content-type', 'application/json')
      raw.end(JSON.stringify(body))
    })
  }

  function client(url: string): ControlApiClient {
    return new ControlApiClient({
      baseUrl: `${url}/api/v1`,
      serviceName: 'codex-llm-proxy',
      serviceToken: 'dev-codex-llm-proxy-token',
    })
  }

  const receipt = {
    schemaVersion: 'codex-attempt-receipt.v1' as const,
    providerAttemptId: 'att-1',
    requestHash: 'b'.repeat(64),
    outcome: 'success' as const,
  }

  it.each([['bogus'], [42], [null]])(
    'maps an unrecognized finalize outcome %j to unknown, never success',
    async outcome => {
      const server = await jsonServer({ providerAttemptId: 'att-1', outcome, duplicate: false })
      try {
        const finalized = await client(server.url).finalize({
          attemptReceipt: 'a'.repeat(64),
          receipt,
        })
        expect(finalized.outcome).toBe('unknown')
      } finally {
        await server.close()
      }
    }
  )

  it.each(['success', 'canceled', 'error', 'unknown'] as const)(
    'passes through the recognized finalize outcome %s',
    async outcome => {
      const server = await jsonServer({ providerAttemptId: 'att-1', outcome, duplicate: true })
      try {
        const finalized = await client(server.url).finalize({
          attemptReceipt: 'a'.repeat(64),
          receipt,
        })
        expect(finalized).toEqual({ providerAttemptId: 'att-1', outcome, duplicate: true })
      } finally {
        await server.close()
      }
    }
  )

  function redeemBody(maxStreamDurationMs: unknown): Record<string, unknown> {
    return {
      accessToken: 'tok-live',
      transport: {
        protocolVersion: 'codex-subscription-transport.v1',
        completionsOrigin: CODEX_COMPLETIONS_ORIGIN,
        catalogOrigin: CODEX_CATALOG_ORIGIN,
        operation: 'completion_stream',
        servedModel: 'gpt-5.1',
        ...(maxStreamDurationMs === undefined ? {} : { maxStreamDurationMs }),
      },
      expiryClass: 'short_lived',
      attemptReceipt: 'a'.repeat(64),
    }
  }

  it.each([[0], [-1], [-300_000], [null], ['300000']])(
    'rejects a redeem transport maxStreamDurationMs of %j as provider_unavailable',
    async value => {
      const server = await jsonServer(redeemBody(value))
      try {
        await expect(
          client(server.url).redeem({
            executionTicket: 'ticket-1',
            requestHash: 'b'.repeat(64),
            operation: 'completion_stream',
          })
        ).rejects.toMatchObject({ code: 'provider_unavailable' })
      } finally {
        await server.close()
      }
    }
  )

  // control-api has sent maxStreamDurationMs on every redeem since the route
  // existed, so an absent value is a contract violation, not an old server.
  it('keeps a positive maxStreamDurationMs and rejects an absent one', async () => {
    const positive = await jsonServer(redeemBody(120_000))
    const absent = await jsonServer(redeemBody(undefined))
    try {
      const input = {
        executionTicket: 'ticket-1',
        requestHash: 'b'.repeat(64),
        operation: 'completion_stream' as const,
      }
      expect((await client(positive.url).redeem(input)).transport.maxStreamDurationMs).toBe(
        120_000
      )
      await expect(client(absent.url).redeem(input)).rejects.toMatchObject({
        code: 'provider_unavailable',
        message: 'redeem maxStreamDurationMs is invalid',
      })
    } finally {
      await positive.close()
      await absent.close()
    }
  })
})

// G1-4 (#720): a redeem that never reached a live control-plane process is
// control_plane_unavailable; a failure that may have reached one is not.
describe('ControlApiClient control-plane reachability', () => {
  async function closedPortUrl(): Promise<string> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    await new Promise<void>(resolve => server.close(() => resolve()))
    return `http://${LOOPBACK_V4}:${port}`
  }

  function clientAt(baseUrl: string, fetchFn?: typeof fetch): ControlApiClient {
    return new ControlApiClient({
      baseUrl: `${baseUrl}/api/v1`,
      serviceName: 'codex-llm-proxy',
      serviceToken: 'dev-codex-llm-proxy-token',
      ...(fetchFn ? { fetchFn } : {}),
    })
  }

  const redeemInput = {
    executionTicket: 'ticket',
    requestHash: 'e'.repeat(64),
    operation: 'completion_stream' as const,
  }

  // The shape undici gives a fetch that failed before any response: a
  // TypeError whose cause carries the system or undici error code.
  function fetchFailure(code: string): TypeError {
    return Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(code), { code }),
    })
  }

  it('G1-4a maps a refused connection to control_plane_unavailable', async () => {
    const url = await closedPortUrl()
    // Witness: the platform fetch fails this way against the closed port, so
    // the mocked shapes below match what undici really produces.
    const raw = await fetch(`${url}/api/v1/probe`).catch((caught: unknown) => caught)
    expect(raw).toBeInstanceOf(TypeError)
    expect((raw as { cause?: { code?: unknown } }).cause?.code).toBe('ECONNREFUSED')
    await expect(clientAt(url).redeem(redeemInput)).rejects.toMatchObject({
      name: 'ControlApiClientError',
      code: 'control_plane_unavailable',
      causeCode: 'ECONNREFUSED',
    })
  })

  it('G1-4f maps a refused finalize connection the same way', async () => {
    // finalizeQuietly logs this error; its causeCode is what reaches
    // codex_proxy_finalize_failed.
    const url = await closedPortUrl()
    await expect(
      clientAt(url).finalize({
        attemptReceipt: 'a'.repeat(64),
        receipt: {
          schemaVersion: 'codex-attempt-receipt.v1',
          providerAttemptId: 'att-1',
          requestHash: 'b'.repeat(64),
          outcome: 'success',
        },
      })
    ).rejects.toMatchObject({
      name: 'ControlApiClientError',
      code: 'control_plane_unavailable',
      causeCode: 'ECONNREFUSED',
    })
  })

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])(
    'G1-4b maps a %s fetch failure to control_plane_unavailable',
    async code => {
      const fetchFn = vi.fn(async () => {
        throw fetchFailure(code)
      })
      await expect(
        clientAt('http://control-api.invalid', fetchFn as unknown as typeof fetch).redeem(
          redeemInput
        )
      ).rejects.toMatchObject({ code: 'control_plane_unavailable', causeCode: code })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    }
  )

  it('G1-4c rethrows a reset connection unchanged', async () => {
    const failure = fetchFailure('ECONNRESET')
    const fetchFn = vi.fn(async () => {
      throw failure
    })
    await expect(
      clientAt('http://control-api.invalid', fetchFn as unknown as typeof fetch).redeem(redeemInput)
    ).rejects.toBe(failure)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a connect-phase code', fetchFailure('UND_ERR_CONNECT_TIMEOUT')],
    ['the timeout reason', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
  ])('G1-4d rethrows %s unchanged once the request timeout fired', async (_label, failure) => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(
        AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      )
    try {
      const fetchFn = vi.fn(async () => {
        throw failure
      })
      await expect(
        clientAt('http://control-api.invalid', fetchFn as unknown as typeof fetch).redeem(
          redeemInput
        )
      ).rejects.toBe(failure)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(timeout).toHaveBeenCalledWith(CONTROL_API_REQUEST_TIMEOUT_MS)
    } finally {
      timeout.mockRestore()
    }
  })

  it('G1-4e keeps a non-JSON 502 as provider_unavailable', async () => {
    const server = await listen((_req, _body, res) => {
      const raw = res as unknown as {
        statusCode: number
        setHeader: (name: string, value: string) => void
        end: (chunk: string) => void
      }
      raw.statusCode = 502
      raw.setHeader('content-type', 'text/html')
      raw.end('<html>502 Bad Gateway</html>')
    })
    try {
      await expect(clientAt(server.url).redeem(redeemInput)).rejects.toMatchObject({
        code: 'provider_unavailable',
      })
      // Witness: the request reached the server.
      expect(server.requests).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})
