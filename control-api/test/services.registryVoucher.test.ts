// control-api/test/services.registryVoucher.test.ts
import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { cfg } = vi.hoisted(() => ({
  cfg: { registryVoucherPrivateKey: '', adminJwtPrivateKey: '', registryClientId: '' } as {
    registryVoucherPrivateKey: string
    adminJwtPrivateKey: string
    registryClientId: string
  },
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

import {
  VoucherUnavailableError,
  mintIdentityVoucher,
  registrySyntheticUsername,
} from '../src/services/registryVoucher.js'

function keypair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}
const admin = { id: 'admin-1', username: 'alice' } as never
const REGISTRY_USERNAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

afterEach(() => {
  cfg.registryVoucherPrivateKey = ''
  cfg.adminJwtPrivateKey = ''
  cfg.registryClientId = ''
  vi.restoreAllMocks()
})

describe('mintIdentityVoucher', () => {
  it('signs an RS256 voucher with a deployment-namespaced identity', () => {
    const { publicKey, privateKey } = keypair()
    cfg.registryVoucherPrivateKey = privateKey
    cfg.registryClientId = 'clerum-dev-control-api'
    const token = mintIdentityVoucher(admin)
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'control-api',
      audience: 'registry-api',
    }) as jwt.JwtPayload
    expect(decoded.sub).toBe('admin-1')
    expect(decoded.username).toBe('clerum-dev-control-api-alice')
    expect(decoded.email).toBe('clerum-dev-control-api-alice@control-api.local')
    expect(typeof decoded.jti).toBe('string')
    expect(decoded.exp! - decoded.iat!).toBe(60)
  })

  it('falls back to adminJwtPrivateKey when registryVoucherPrivateKey is empty string (|| not ??)', () => {
    const { publicKey, privateKey } = keypair()
    cfg.registryVoucherPrivateKey = '' // documented default
    cfg.adminJwtPrivateKey = privateKey
    cfg.registryClientId = 'clerum-dev-control-api'
    const token = mintIdentityVoucher(admin)
    expect(() => jwt.verify(token, publicKey, { algorithms: ['RS256'] })).not.toThrow()
  })

  it('throws VoucherUnavailableError when no signing key is configured', () => {
    expect(() => mintIdentityVoucher(admin)).toThrow(VoucherUnavailableError)
  })
})

describe('registrySyntheticUsername', () => {
  it('namespaces by the registry client id so reserved names are avoided', () => {
    cfg.registryClientId = 'clerum-dev-control-api'
    const u = registrySyntheticUsername({ id: 'x', username: 'admin' } as never)
    expect(u).toBe('clerum-dev-control-api-admin')
    expect(u).not.toBe('admin') // never a registry-reserved bareword (admin/root/api/...)
    expect(u).toMatch(REGISTRY_USERNAME)
  })

  it('maps the same admin username on different deployments to different registry users', () => {
    cfg.registryClientId = 'clerum-dev-control-api'
    const dev = registrySyntheticUsername({ id: 'x', username: 'admin' } as never)
    cfg.registryClientId = 'clerum-prod-control-api'
    const prod = registrySyntheticUsername({ id: 'x', username: 'admin' } as never)
    expect(dev).not.toBe(prod) // no cross-deployment collision on the shared registry
  })

  it('sanitizes non-conforming usernames to the registry pattern', () => {
    cfg.registryClientId = 'clerum-prod-control-api'
    expect(registrySyntheticUsername({ id: 'x', username: 'Root.User' } as never)).toMatch(
      REGISTRY_USERNAME
    )
  })

  it('uses a safe default prefix when the client id is unset', () => {
    cfg.registryClientId = ''
    const u = registrySyntheticUsername({ id: 'abc', username: 'jose' } as never)
    expect(u).toBe('control-api-jose')
    expect(u).toMatch(REGISTRY_USERNAME)
  })
})
