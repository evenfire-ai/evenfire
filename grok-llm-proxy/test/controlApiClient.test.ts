import { describe, expect, it } from 'vitest'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import { ControlApiClient, ControlApiClientError } from '../src/controlApiClient.js'
import { GROK_CATALOG_ORIGIN, GROK_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'

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
              protocolVersion: 'grok-subscription-transport.v1',
              completionsOrigin: 'https://cli-chat-proxy.grok.com/v1/responses',
              catalogOrigin: 'https://cli-chat-proxy.grok.com/v1/models',
              operation: 'completion_stream',
              servedModel: 'gpt-5.1',
              maxStreamDurationMs: 300000,
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
        raw.end(
          JSON.stringify({ providerAttemptId: 'att-1', outcome: 'success', duplicate: false })
        )
      }
    })
    try {
      const client = new ControlApiClient({
        baseUrl: `${server.url}/api/v1`,
        serviceName: 'grok-llm-proxy',
        serviceToken: 'dev-grok-llm-proxy-token',
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
      expect(server.requests[0]?.headers['x-service-token']).toBe('grok-llm-proxy')
      expect(String(server.requests[0]?.headers.authorization)).toContain(
        'dev-grok-llm-proxy-token'
      )
      expect(server.requests[0]?.url).toBe('/api/v1/internal/llm/grok/provider-attempts/redeem')
      expect(
        server.requests.some(item => item.url === '/api/v1/internal/llm/provider-attempts/redeem')
      ).toBe(false)

      const finalized = await client.finalize({
        attemptReceipt: 'a'.repeat(64),
        receipt: {
          schemaVersion: 'grok-attempt-receipt.v1',
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
      ;(res as unknown as { statusCode: number; setHeader: Function; end: Function }).statusCode =
        409
      ;(res as unknown as { setHeader: Function }).setHeader('content-type', 'application/json')
      ;(res as unknown as { end: Function }).end(JSON.stringify({ error: 'ticket_replayed' }))
    })
    try {
      const client = new ControlApiClient({
        baseUrl: `${server.url}/api/v1`,
        serviceName: 'grok-llm-proxy',
        serviceToken: 'dev-grok-llm-proxy-token',
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
      serviceName: 'grok-llm-proxy',
      serviceToken: 'dev-grok-llm-proxy-token',
    })
  }

  const receipt = {
    schemaVersion: 'grok-attempt-receipt.v1' as const,
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
        protocolVersion: 'grok-subscription-transport.v1',
        completionsOrigin: GROK_COMPLETIONS_ORIGIN,
        catalogOrigin: GROK_CATALOG_ORIGIN,
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

  it('keeps a positive maxStreamDurationMs and defaults an absent one to 300000', async () => {
    const positive = await jsonServer(redeemBody(120_000))
    const absent = await jsonServer(redeemBody(undefined))
    try {
      const input = {
        executionTicket: 'ticket-1',
        requestHash: 'b'.repeat(64),
        operation: 'completion_stream' as const,
      }
      expect((await client(positive.url).redeem(input)).transport.maxStreamDurationMs).toBe(120_000)
      expect((await client(absent.url).redeem(input)).transport.maxStreamDurationMs).toBe(300_000)
    } finally {
      await positive.close()
      await absent.close()
    }
  })
})
