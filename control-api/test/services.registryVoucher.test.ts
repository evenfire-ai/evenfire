// control-api/test/services.registryVoucher.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import { __resetRegistryConnectionCacheForTests } from '../src/services/registryConnectionDb.js'
import { VoucherUnavailableError, mintIdentityVoucher } from '../src/services/registryVoucher.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'managed',
    registryVoucherPrivateKey: '',
    registryVoucherKid: '',
    adminJwtPrivateKey: '',
    registryClientId: '',
    oauthEncryptionKey: '',
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))
// self-hosted branch queries the DB — not exercised in the managed tests below.
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}))

function keypair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}
const admin = { id: 'admin-1', username: 'alice' } as never

afterEach(() => {
  __resetRegistryConnectionCacheForTests()
  cfg.registryConnectionMode = 'managed'
  cfg.registryVoucherPrivateKey = ''
  cfg.registryVoucherKid = ''
  cfg.adminJwtPrivateKey = ''
  cfg.registryClientId = ''
  vi.restoreAllMocks()
})

describe('mintIdentityVoucher — voucher v2 (managed)', () => {
  it('emits a kid header and a payload of EXACTLY {iss,aud,sub,jti,exp}', async () => {
    const { publicKey, privateKey } = keypair()
    cfg.registryVoucherPrivateKey = privateKey
    cfg.registryVoucherKid = 'key-uuid-42'
    const token = await mintIdentityVoucher(admin)

    const header = jwt.decode(token, { complete: true })!.header
    expect(header.alg).toBe('RS256')
    expect(header.kid).toBe('key-uuid-42')

    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'control-api',
      audience: 'registry-api',
    }) as jwt.JwtPayload
    expect(payload.sub).toBe('admin-1')
    expect(typeof payload.jti).toBe('string')
    expect(typeof payload.exp).toBe('number')
    // v2 drops these three:
    expect(payload.email).toBeUndefined()
    expect(payload.username).toBeUndefined()
    expect(payload.iat).toBeUndefined()
    // exactly the five keys
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iss', 'jti', 'sub'])
    // TTL asserted against now (iat is gone)
    expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60)
    expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeGreaterThan(0)
  })

  it('does NOT fall back to adminJwtPrivateKey — throws when the dedicated key is unset', async () => {
    cfg.registryVoucherPrivateKey = ''
    cfg.registryVoucherKid = 'key-uuid-42'
    cfg.adminJwtPrivateKey = keypair().privateKey // present, but must be ignored
    await expect(mintIdentityVoucher(admin)).rejects.toBeInstanceOf(VoucherUnavailableError)
  })

  it('throws when the kid is unset', async () => {
    cfg.registryVoucherPrivateKey = keypair().privateKey
    cfg.registryVoucherKid = ''
    await expect(mintIdentityVoucher(admin)).rejects.toBeInstanceOf(VoucherUnavailableError)
  })
})
