import type { IncomingHttpHeaders } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildForwardHeaders } from '../src/headers'
import type { WebhookConfigEntry } from '../src/types'

const baseEntry = (): WebhookConfigEntry => ({
  id: 'fireflies',
  methods: ['POST'],
  maxBodyBytes: 1_048_576,
  verification: {
    scheme: 'hmac-sha256-body',
    signatureHeader: 'x-hub-signature-256',
    signaturePrefix: 'sha256=',
    signatureEncoding: 'hex',
    secretPath: '/run/secrets/x',
  },
  upstream: { host: 'h', port: 8080, path: '/x' },
})

describe('buildForwardHeaders (must-fix #1: full ^x-clerum- strip)', () => {
  it('strips client-supplied X-Clerum-* and injects gateway-owned headers', () => {
    const inbound: IncomingHttpHeaders = {
      'content-type': 'application/json',
      'user-agent': 'fireflies-webhooks/1.0',
      'idempotency-key': 'abc-123',
      authorization: 'Bearer attacker-token',
      cookie: 'session=hijack',
      host: 'webhooks.example.com',
      'x-hub-signature-256': 'sha256=abc',
      'x-clerum-user': 'attacker',
      'x-clerum-webhook-verified-at': '1970-01-01T00:00:00Z',
      'X-CLERUM-FOO': 'bar', // mixed case
    }
    const out = buildForwardHeaders(baseEntry(), inbound, 'sandbox-recipes', 'foo')
    expect(out['authorization']).toBeUndefined()
    expect(out['cookie']).toBeUndefined()
    expect(out['host']).toBeUndefined()
    expect(out['x-hub-signature-256']).toBeUndefined()
    // Every X-Clerum-* must be GONE except the three the gateway injects.
    for (const key of Object.keys(out)) {
      if (key.startsWith('x-clerum-')) {
        expect([
          'x-clerum-webhook-id',
          'x-clerum-webhook-recipe',
          'x-clerum-webhook-verified-at',
        ]).toContain(key)
      }
    }
    expect(out['x-clerum-webhook-id']).toBe('fireflies')
    expect(out['x-clerum-webhook-recipe']).toBe('sandbox-recipes/foo')
    // Verified-at injected by us, NOT the attacker's value.
    expect(out['x-clerum-webhook-verified-at']).not.toBe('1970-01-01T00:00:00Z')
    // Provider headers preserved.
    expect(out['content-type']).toBe('application/json')
    expect(out['user-agent']).toBe('fireflies-webhooks/1.0')
    expect(out['idempotency-key']).toBe('abc-123')
  })

  it('strips replay.timestampHeader for timestamped schemes', () => {
    const entry: WebhookConfigEntry = {
      ...baseEntry(),
      verification: {
        scheme: 'hmac-sha256-timestamp-body',
        signatureHeader: 'stripe-signature',
        signatureEncoding: 'hex',
        secretPath: '/x',
      },
      replay: { timestampHeader: 'stripe-timestamp', toleranceSec: 300 },
    }
    const inbound: IncomingHttpHeaders = {
      'stripe-signature': 't=123,v1=abc',
      'stripe-timestamp': '123',
      'content-type': 'application/json',
    }
    const out = buildForwardHeaders(entry, inbound, 'sandbox-recipes', 'foo')
    expect(out['stripe-signature']).toBeUndefined()
    expect(out['stripe-timestamp']).toBeUndefined()
    expect(out['content-type']).toBe('application/json')
  })

  it('drops hop-by-hop headers (Connection, Transfer-Encoding, Content-Length)', () => {
    const inbound: IncomingHttpHeaders = {
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'content-length': '999',
      'content-type': 'application/json',
    }
    const out = buildForwardHeaders(baseEntry(), inbound, 'sandbox-recipes', 'foo')
    expect(out['connection']).toBeUndefined()
    expect(out['transfer-encoding']).toBeUndefined()
    // The forwarder will set Content-Length itself based on the buffered body.
    expect(out['content-length']).toBeUndefined()
    expect(out['content-type']).toBe('application/json')
  })

  it('flattens multi-value headers to a single comma-joined string', () => {
    const inbound: IncomingHttpHeaders = {
      'x-custom': ['a', 'b', 'c'],
      'content-type': 'application/json',
    }
    const out = buildForwardHeaders(baseEntry(), inbound, 'sandbox-recipes', 'foo')
    expect(out['x-custom']).toBe('a, b, c')
  })
})
