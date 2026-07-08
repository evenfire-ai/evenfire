import { describe, expect, it } from 'vitest'
import { validateGatewayConfig } from '../src/config'

const validHmac = (overrides: Record<string, unknown> = {}) => ({
  webhooks: {
    fireflies: {
      id: 'fireflies',
      methods: ['POST'],
      maxBodyBytes: 1_048_576,
      verification: {
        scheme: 'hmac-sha256-body',
        signatureHeader: 'X-Hub-Signature-256',
        signaturePrefix: 'sha256=',
        signatureEncoding: 'hex',
        secretPath: '/run/secrets/fireflies/signing-secret',
      },
      upstream: {
        host: 'wf-foo-handler.sandbox-recipes.svc.cluster.local',
        port: 8080,
        path: '/webhooks/fireflies',
      },
      ...overrides,
    },
  },
})

describe('validateGatewayConfig (W1.1)', () => {
  it('accepts a Fireflies-shaped hmac-sha256-body entry', () => {
    const config = validateGatewayConfig(validHmac())
    const entry = config.webhooks.fireflies
    expect(entry.id).toBe('fireflies')
    expect(entry.methods).toEqual(['POST'])
    expect(entry.maxBodyBytes).toBe(1_048_576)
    expect(entry.verification.scheme).toBe('hmac-sha256-body')
    if (entry.verification.scheme === 'hmac-sha256-body') {
      // signatureHeader is lower-cased so the verifier can look it up directly.
      expect(entry.verification.signatureHeader).toBe('x-hub-signature-256')
      expect(entry.verification.signaturePrefix).toBe('sha256=')
      expect(entry.verification.signatureEncoding).toBe('hex')
    }
  })

  it('rejects a non-object root', () => {
    expect(() => validateGatewayConfig(null)).toThrow(/missing or non-object/)
    expect(() => validateGatewayConfig({ webhooks: 'oops' })).toThrow(/missing or non-object/)
  })

  it('rejects webhook ids that fail the route regex', () => {
    const bad = {
      webhooks: { 'a..b': { id: 'a..b', methods: ['POST'] } },
    }
    expect(() => validateGatewayConfig(bad)).toThrow(/fails/)
  })

  it('rejects entries whose .id field disagrees with the map key', () => {
    const bad = validHmac({ id: 'wrong-key' })
    expect(() => validateGatewayConfig(bad)).toThrow(/mismatching/)
  })

  it('rejects methods missing POST', () => {
    const bad = validHmac({ methods: ['GET'] })
    expect(() => validateGatewayConfig(bad)).toThrow(/methods must include POST/)
  })

  it('rejects maxBodyBytes outside [1024, 10MiB]', () => {
    expect(() => validateGatewayConfig(validHmac({ maxBodyBytes: 512 }))).toThrow(/out of range/)
    expect(() => validateGatewayConfig(validHmac({ maxBodyBytes: 20_000_000 }))).toThrow(
      /out of range/
    )
  })

  it('rejects unknown verification scheme', () => {
    const bad = validHmac({
      verification: { scheme: 'hmac-md5', secretPath: '/x' },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/unknown scheme/)
  })

  it('rejects missing signatureHeader on hmac schemes', () => {
    const bad = validHmac({
      verification: {
        scheme: 'hmac-sha256-body',
        signatureEncoding: 'hex',
        secretPath: '/s',
      },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/missing signatureHeader/)
  })

  it('rejects missing replay on hmac-sha256-timestamp-body', () => {
    const bad = validHmac({
      verification: {
        scheme: 'hmac-sha256-timestamp-body',
        signatureHeader: 'stripe-signature',
        signatureEncoding: 'hex',
        secretPath: '/s',
      },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/missing replay/)
  })

  it('rejects replay set on a non-timestamp scheme', () => {
    const bad = validHmac({
      replay: { timestampHeader: 'x-ts', toleranceSec: 60 },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/replay set on non-timestamp/)
  })

  it('rejects replay.toleranceSec outside [10, 3600]', () => {
    const bad = validHmac({
      verification: {
        scheme: 'hmac-sha256-timestamp-body',
        signatureHeader: 'stripe-signature',
        signatureEncoding: 'hex',
        secretPath: '/s',
      },
      replay: { timestampHeader: 'stripe-timestamp', toleranceSec: 5 },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/toleranceSec out of/)
  })

  it('rejects upstream.path that does not start with /', () => {
    const bad = validHmac({
      upstream: { host: 'x', port: 8080, path: 'no-slash' },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/path must start with/)
  })
})

describe('validateGatewayConfig setupHandshake (W2.1)', () => {
  it('accepts meta-hub-challenge with secretPath and methods including GET', () => {
    const config = validateGatewayConfig(
      validHmac({
        methods: ['POST', 'GET'],
        setupHandshake: {
          strategy: 'meta-hub-challenge',
          secretPath: '/run/secrets/whatsapp/hub-verify-token',
        },
      }),
    )
    const entry = config.webhooks.fireflies
    expect(entry.setupHandshake?.strategy).toBe('meta-hub-challenge')
    expect(entry.setupHandshake?.secretPath).toBe('/run/secrets/whatsapp/hub-verify-token')
  })

  it('accepts slack-url-verification without secretPath (signed by main scheme)', () => {
    const config = validateGatewayConfig(
      validHmac({
        verification: {
          scheme: 'hmac-sha256-timestamp-body',
          signatureHeader: 'x-slack-signature',
          signatureEncoding: 'hex',
          secretPath: '/s',
        },
        replay: { timestampHeader: 'x-slack-request-timestamp', toleranceSec: 300 },
        setupHandshake: { strategy: 'slack-url-verification' },
      }),
    )
    expect(config.webhooks.fireflies.setupHandshake?.strategy).toBe('slack-url-verification')
    expect(config.webhooks.fireflies.setupHandshake?.secretPath).toBeUndefined()
  })

  it('rejects unknown strategy', () => {
    const bad = validHmac({
      setupHandshake: { strategy: 'magic-handshake', secretPath: '/x' },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/strategy "magic-handshake" is not supported/)
  })

  it('rejects meta-hub-challenge without secretPath', () => {
    const bad = validHmac({
      methods: ['POST', 'GET'],
      setupHandshake: { strategy: 'meta-hub-challenge' },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/meta-hub-challenge requires setupHandshake.secretPath/)
  })

  it('rejects meta-hub-challenge when methods does not include GET', () => {
    const bad = validHmac({
      methods: ['POST'],
      setupHandshake: { strategy: 'meta-hub-challenge', secretPath: '/x' },
    })
    expect(() => validateGatewayConfig(bad)).toThrow(/meta-hub-challenge requires methods to include GET/)
  })

  it('rejects GET in methods when no setupHandshake (defense-in-depth W13)', () => {
    const bad = validHmac({ methods: ['POST', 'GET'] })
    expect(() => validateGatewayConfig(bad)).toThrow(/methods includes GET but no setupHandshake/)
  })

  it('absent setupHandshake on POST-only entry is allowed', () => {
    const config = validateGatewayConfig(validHmac())
    expect(config.webhooks.fireflies.setupHandshake).toBeUndefined()
  })
})
