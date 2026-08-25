import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import {
  CodexSubscriptionFingerprintConflictError,
  CodexSubscriptionInvalidConnectionKeyError,
  CodexSubscriptionStaleRevisionError,
  assertCodexConnectionKey,
  generateCodexConnectionKey,
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
  normalizeCodexConnectionKey,
  readHostCodexConnectionRef,
  rotateCodexSubscriptionCredentials,
  updateCodexSubscriptionConnectionMetadata,
} from '../src/services/codexSubscriptionConnection.js'

const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))

function queryMock() {
  return vi.fn()
}

describe('codex subscription connection repository', () => {
  const query = queryMock()

  beforeEach(() => {
    query.mockReset()
  })

  it('returns safe metadata without ciphertext or token fields', async () => {
    const ciphertext = encryptOAuthSecret(KEY, 'refresh-secret')
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          connection_key: 'deployment-default',
          display_name: 'Default deployment',
          created_by: null,
          status: 'connected',
          refresh_token_encrypted: ciphertext,
          access_token_encrypted: encryptOAuthSecret(KEY, 'access-secret'),
          access_token_expires_at: new Date('2026-08-20T12:00:00.000Z'),
          credential_revision: '3',
          catalog_revision: '1',
          account_fingerprint: 'fp_abc',
          catalog_status: 'ready',
          catalog_synced_at: new Date('2026-08-20T11:00:00.000Z'),
          last_refresh_at: new Date('2026-08-20T11:30:00.000Z'),
          last_auth_at: new Date('2026-08-20T10:00:00.000Z'),
          refresh_lock_token: 'lock',
          refresh_lock_expires_at: new Date('2026-08-20T12:00:00.000Z'),
          revoked_at: null,
          created_at: new Date('2026-08-20T09:00:00.000Z'),
          updated_at: new Date('2026-08-20T11:30:00.000Z'),
        },
      ],
      rowCount: 1,
    })

    const metadata = await getSafeCodexSubscriptionConnection({ query })
    expect(metadata).toMatchObject({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 3,
      catalogRevision: 1,
      accountFingerprint: 'fp_abc',
      catalogStatus: 'ready',
    })
    const serialized = JSON.stringify(metadata)
    expect(serialized).not.toContain(ciphertext)
    expect(serialized).not.toContain('refresh-secret')
    expect(serialized).not.toContain('access-secret')
    expect(serialized).not.toMatch(/cookie/i)
    expect(metadata).not.toHaveProperty('refreshTokenEncrypted')
    expect(metadata).not.toHaveProperty('accessTokenEncrypted')
    expect(metadata).not.toHaveProperty('refreshToken')
    expect(metadata).not.toHaveProperty('accessToken')
  })

  it('inserts encrypted credentials and never binds plaintext tokens', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          connection_key: 'deployment-default',
          display_name: 'Default deployment',
          created_by: null,
          status: 'connected',
          credential_revision: '1',
          catalog_revision: '0',
          account_fingerprint: 'fp_new',
          catalog_status: 'never_synced',
          catalog_synced_at: null,
          last_refresh_at: null,
          last_auth_at: expect.anything(),
          refresh_lock_token: null,
          refresh_lock_expires_at: null,
          revoked_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    })

    const metadata = await insertInitialCodexSubscriptionConnection({ query }, KEY, {
      refreshToken: 'plain-refresh',
      accessToken: 'plain-access',
      accountFingerprint: 'fp_new',
    })
    expect(metadata.connectionKey).toBe('deployment-default')
    expect(metadata.credentialRevision).toBe(1)
    const [, params] = query.mock.calls[0] as [string, unknown[]]
    expect(params).not.toContain('plain-refresh')
    expect(params).not.toContain('plain-access')
    expect(String(params[3])).toMatch(/^v1\./)
    expect(String(params[4])).toMatch(/^v1\./)
  })

  it('maps a unique active fingerprint violation to fingerprint_in_use', async () => {
    query.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), {
        code: '23505',
        constraint: 'codex_subscription_connections_active_fingerprint',
      })
    )
    await expect(
      insertInitialCodexSubscriptionConnection(
        { query },
        KEY,
        {
          refreshToken: 'plain-refresh',
          accountFingerprint: 'fp_dup',
        },
        'team-plus'
      )
    ).rejects.toBeInstanceOf(CodexSubscriptionFingerprintConflictError)
  })

  it('does not remap an unrelated unique violation to fingerprint_in_use', async () => {
    const err = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'codex_subscription_connections_pkey',
    })
    query.mockRejectedValueOnce(err)
    await expect(
      insertInitialCodexSubscriptionConnection(
        { query },
        KEY,
        {
          refreshToken: 'plain-refresh',
          accountFingerprint: 'fp_other',
        },
        'team-plus'
      )
    ).rejects.toBe(err)
  })

  it('rejects a stale credential_revision writer', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(
      rotateCodexSubscriptionCredentials({ query }, KEY, 1, {
        refreshToken: 'next-refresh',
        accountFingerprint: 'fp_new',
      })
    ).rejects.toBeInstanceOf(CodexSubscriptionStaleRevisionError)
    const [sql] = query.mock.calls[0] as [string]
    expect(sql).toMatch(/credential_revision = \$/)
    expect(sql).toMatch(/revoked_at IS NULL/)
    expect(sql).not.toMatch(/revoked_at = NULL/)
  })

  it('refuses metadata writes on a revoked grant', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(
      updateCodexSubscriptionConnectionMetadata({ query }, KEY, { displayName: 'Tomb' })
    ).resolves.toBeNull()
    const [sql] = query.mock.calls[0] as [string]
    expect(sql).toMatch(/revoked_at IS NULL/)
  })

  it('rejects the reserved unassigned key and keeps it on Host reads', () => {
    expect(() => assertCodexConnectionKey('unassigned')).toThrow(
      CodexSubscriptionInvalidConnectionKeyError
    )
    expect(readHostCodexConnectionRef('unassigned')).toBe('unassigned')
    expect(readHostCodexConnectionRef('')).toBe('unassigned')
    expect(readHostCodexConnectionRef(undefined)).toBe('unassigned')
    expect(readHostCodexConnectionRef('codex-aaa')).toBe('codex-aaa')
    expect(readHostCodexConnectionRef('deployment-default')).toBe('deployment-default')
    expect(normalizeCodexConnectionKey('unassigned')).toBe('unassigned')
    expect(normalizeCodexConnectionKey('')).toBe('deployment-default')
  })

  it('generates distinct identity keys that are not derived from the display name', () => {
    const keys = new Set(Array.from({ length: 8 }, () => generateCodexConnectionKey()))
    expect(keys.size).toBe(8)
    for (const key of keys) {
      expect(key).toMatch(/^codex-[a-f0-9]{16}$/)
    }
  })
})
