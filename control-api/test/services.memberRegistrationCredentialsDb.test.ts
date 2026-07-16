import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import {
  getActiveMemberRegistrationCredential,
  insertMemberRegistrationCredential,
} from '../src/services/memberRegistrationCredentialsDb.js'

const OAUTH_KEY_HEX = 'ab'.repeat(32)

const { cfg } = vi.hoisted(() => ({
  cfg: { oauthEncryptionKey: 'ab'.repeat(32) } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const db = vi.hoisted(() => ({ pool: { query: vi.fn() } }))
vi.mock('../src/db.js', () => db)

const KEY = deriveOAuthEncryptionKey(OAUTH_KEY_HEX)

describe('memberRegistrationCredentialsDb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the decrypted active credential', async () => {
    db.pool.query.mockResolvedValueOnce({
      rows: [
        {
          bound_domain: 'profile.acme.com',
          tenant_id: 'ext-abc123',
          kid: 'ext-abc123-deadbeef',
          secret_encrypted: encryptOAuthSecret(KEY, 'hub-secret'),
        },
      ],
      rowCount: 1,
    })
    const row = await getActiveMemberRegistrationCredential('profile.acme.com')
    expect(row).toEqual({
      boundDomain: 'profile.acme.com',
      tenantId: 'ext-abc123',
      kid: 'ext-abc123-deadbeef',
      secret: 'hub-secret',
    })
    const [sql, params] = db.pool.query.mock.calls[0]
    expect(String(sql)).toMatch(/revoked_at IS NULL/)
    expect(params).toEqual(['profile.acme.com'])
  })

  it('returns null when no active row exists', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await getActiveMemberRegistrationCredential('profile.acme.com')).toBeNull()
  })

  it('self-heals an undecryptable row: revokes it (blanking the secret) and returns null', async () => {
    db.pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            bound_domain: 'profile.acme.com',
            tenant_id: 'ext-abc123',
            kid: 'ext-abc123-deadbeef',
            secret_encrypted: 'v1.not.decryptable.garbage',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // the revoke UPDATE
    expect(await getActiveMemberRegistrationCredential('profile.acme.com')).toBeNull()
    const [updateSql, updateParams] = db.pool.query.mock.calls[1]
    expect(String(updateSql)).toMatch(/UPDATE member_registration_credentials/)
    expect(String(updateSql)).toMatch(/revoked_at = NOW\(\)/i)
    expect(String(updateSql)).toMatch(/secret_encrypted = ''/)
    expect(updateParams).toEqual(['profile.acme.com'])
  })

  it('inserts encrypted (never the plaintext secret) with the partial-index conflict target', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 })
    const { inserted } = await insertMemberRegistrationCredential({
      boundDomain: 'profile.acme.com',
      tenantId: 'ext-abc123',
      kid: 'ext-abc123-deadbeef',
      secret: 'hub-secret',
    })
    expect(inserted).toBe(true)
    const [sql, params] = db.pool.query.mock.calls[0]
    expect(String(sql)).toMatch(/ON CONFLICT \(bound_domain\) WHERE revoked_at IS NULL DO NOTHING/)
    expect(params?.[3]).not.toContain('hub-secret')
    expect(String(params?.[3])).toMatch(/^v1\./) // encryption.ts payload format
  })

  it('reports inserted:false when the partial unique index rejects (lost race)', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const { inserted } = await insertMemberRegistrationCredential({
      boundDomain: 'profile.acme.com',
      tenantId: 'ext-xyz',
      kid: 'ext-xyz-1234',
      secret: 's',
    })
    expect(inserted).toBe(false)
  })
})
