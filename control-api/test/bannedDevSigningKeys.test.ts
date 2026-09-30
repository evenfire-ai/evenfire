import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { createPublicKey } from 'node:crypto'
import {
  BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS as DEFAULT_BANNED_FINGERPRINTS,
  assertNoBannedJwtKeys as assertGuard,
  isBannedPublicKeyPem,
  publicKeyPemFingerprint as publicKeyFingerprint,
  validateRsaPrivateKeyPem as validateSigningPem,
} from '../src/bannedDevSigningKeys.js'
import { BANNED_DEV_JWT_PUBLIC_KEYS as HISTORICAL_PUBLIC_KEYS } from './fixtures/bannedDevJwtPublicKeys.js'

function rsaPublicKey(modulusLength = 2048): string {
  return generateKeyPairSync('rsa', {
    modulusLength,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey
}

function makeFresh(): { signing: string; public: string } {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return { signing: pair.privateKey, public: pair.publicKey }
}

function makeOffender() {
  const fresh = makeFresh()
  return { signing: fresh.signing, fingerprints: new Set([publicKeyFingerprint(fresh.public)]) }
}

describe('bannedDevSigningKeys', () => {
  it('does not ban freshly generated keys of operator-typical sizes', () => {
    for (const bits of [2048, 3072, 4096] as const) {
      expect(isBannedPublicKeyPem(rsaPublicKey(bits))).toBe(false)
    }
  })

  it('pins each historical public fixture to the default ban list', () => {
    for (const [slot, publicPem] of Object.entries(HISTORICAL_PUBLIC_KEYS)) {
      const fingerprint = publicKeyFingerprint(publicPem)
      expect(DEFAULT_BANNED_FINGERPRINTS.has(fingerprint), slot).toBe(true)
      expect(isBannedPublicKeyPem(publicPem)).toBe(true)
    }
    expect(DEFAULT_BANNED_FINGERPRINTS.size).toBe(3)
  })

  it('validates fresh RSA-2048 signing material', () => {
    expect(() => validateSigningPem(makeFresh().signing, 'TEST_ENV')).not.toThrow()
  })

  it('rejects public PEMs, weak moduli, and non-RSA algorithms', () => {
    expect(() => validateSigningPem(rsaPublicKey(1024), 'TEST_ENV')).toThrow(/TEST_ENV/)
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    expect(() => validateSigningPem(ec.publicKey, 'TEST_ENV')).toThrow(
      /must contain exactly one PEM private key/
    )
    expect(() => validateSigningPem(ec.privateKey, 'TEST_ENV')).toThrow(/must be an RSA key/)
  })

  it('rejects a banned fingerprint in every signing slot', () => {
    for (const slot of ['rpc', 'session', 'admin', 'voucher'] as const) {
      const offender = makeOffender()
      const freshRpc = makeFresh()
      const freshSession = makeFresh()
      const freshAdmin = makeFresh()
      const freshVerifier = makeFresh()
      const input = {
        rpcPrivateKey: slot === 'rpc' ? offender.signing : freshRpc.signing,
        sessionPrivateKey: slot === 'session' ? offender.signing : freshSession.signing,
        adminPrivateKey: slot === 'admin' ? offender.signing : freshAdmin.signing,
        voucherPrivateKey: slot === 'voucher' ? offender.signing : undefined,
        rpcPublicKey: freshVerifier.public,
        rpcPublicKeyEnvSet: false,
      }
      expect(() => assertGuard(input, offender.fingerprints), slot).toThrow(
        /historically committed dev JWT key/
      )
    }
  })

  it('rejects a banned verifier public key and mismatched overrides', () => {
    const fresh = makeFresh()
    const offender = makeOffender()
    expect(() =>
      assertGuard(
        {
          rpcPrivateKey: fresh.signing,
          sessionPrivateKey: makeFresh().signing,
          adminPrivateKey: makeFresh().signing,
          rpcPublicKey: HISTORICAL_PUBLIC_KEYS.rpc,
          rpcPublicKeyEnvSet: true,
        },
        new Set([publicKeyFingerprint(HISTORICAL_PUBLIC_KEYS.rpc)])
      )
    ).toThrow(/effective RPC JWT verifier public key/)

    expect(() =>
      assertGuard(
        {
          rpcPrivateKey: fresh.signing,
          sessionPrivateKey: makeFresh().signing,
          adminPrivateKey: makeFresh().signing,
          rpcPublicKey: makeFresh().public,
          rpcPublicKeyEnvSet: true,
        },
        new Set(['0'.repeat(64)])
      )
    ).toThrow(/must correspond to/)
  })

  it('accepts fresh keys with a matching explicit verifier override', () => {
    const fresh = makeFresh()
    expect(() =>
      assertGuard(
        {
          rpcPrivateKey: fresh.signing,
          sessionPrivateKey: makeFresh().signing,
          adminPrivateKey: makeFresh().signing,
          rpcPublicKey: fresh.public.trim(),
          rpcPublicKeyEnvSet: true,
        },
        new Set(['0'.repeat(64)])
      )
    ).not.toThrow()
  })

  it('rejects concatenated key bundles instead of fingerprinting a decoy half', () => {
    const target = makeFresh()
    const decoy = makeFresh()
    const fingerprints = new Set([publicKeyFingerprint(target.public)])
    for (const combined of [
      `${decoy.public}\n${target.signing}`,
      `${target.signing}\n${decoy.public}`,
    ]) {
      expect(() => validateSigningPem(combined, 'TEST_ENV')).toThrow(
        /must contain exactly one PEM private key/
      )
      expect(() =>
        assertGuard(
          {
            rpcPrivateKey: combined,
            sessionPrivateKey: makeFresh().signing,
            adminPrivateKey: makeFresh().signing,
            rpcPublicKey: makeFresh().public,
            rpcPublicKeyEnvSet: false,
          },
          fingerprints
        )
      ).toThrow(/historically committed dev JWT key/)
    }
  })

  it('accepts equivalent verifier encodings and rejects different keys by identity', () => {
    const fresh = makeFresh()
    const fingerprints = new Set(['0'.repeat(64)])
    const pkcs1 = createPublicKey(fresh.public).export({ type: 'pkcs1', format: 'pem' }).toString()
    const crlf = fresh.public.trim().replace(/\n/g, '\r\n')
    for (const equivalent of [pkcs1, crlf]) {
      expect(() =>
        assertGuard(
          {
            rpcPrivateKey: fresh.signing,
            sessionPrivateKey: makeFresh().signing,
            adminPrivateKey: makeFresh().signing,
            rpcPublicKey: equivalent,
            rpcPublicKeyEnvSet: true,
          },
          fingerprints
        )
      ).not.toThrow()
    }
  })
})
