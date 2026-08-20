import { createServer, type IncomingMessage, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { ControlApiClient, ControlApiClientError } from '../src/controlApiClient.js'

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
              catalogOrigin: 'https://chatgpt.com/backend-api/codex/models',
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
