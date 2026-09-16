import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import {
  GrokSubscriptionFingerprintConflictError,
  GrokSubscriptionInvalidConnectionKeyError,
  GrokSubscriptionStaleRevisionError,
  assertGrokConnectionKey,
  generateGrokConnectionKey,
  getSafeGrokSubscriptionConnection,
  insertInitialGrokSubscriptionConnection,
  persistGrokRefreshCiphertextFirst,
  readHostGrokConnectionRef,
} from '../src/services/grokSubscriptionConnection.js'

const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))

function queryMock() {
  return vi.fn()
}

describe('grok subscription connection repository', () => {
  const query = queryMock()

  beforeEach(() => {
    query.mockReset()
  })

  it('generates grok-<16 hex> keys and rejects reserved names', () => {
    expect(generateGrokConnectionKey()).toMatch(/^grok-[0-9a-f]{16}$/)
    expect(assertGrokConnectionKey('team-grok')).toBe('team-grok')
    expect(() => assertGrokConnectionKey('unassigned')).toThrow(
      GrokSubscriptionInvalidConnectionKeyError
    )
    expect(() => assertGrokConnectionKey('deployment-default')).toThrow(
      GrokSubscriptionInvalidConnectionKeyError
    )
    expect(() => assertGrokConnectionKey('')).toThrow(GrokSubscriptionInvalidConnectionKeyError)
  })

  it('maps empty Host connectionRef to unassigned, never deployment-default', () => {
    expect(readHostGrokConnectionRef(undefined)).toBe('unassigned')
    expect(readHostGrokConnectionRef('')).toBe('unassigned')
    expect(readHostGrokConnectionRef('  ')).toBe('unassigned')
    expect(readHostGrokConnectionRef('team-grok')).toBe('team-grok')
  })

  it('returns safe metadata without ciphertext or token fields', async () => {
    const ciphertext = encryptOAuthSecret(KEY, 'refresh-secret')
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          connection_key: 'team-grok',
          display_name: 'Team Grok',
          created_by: null,
          status: 'connected',
          refresh_token_encrypted: ciphertext,
          access_token_encrypted: encryptOAuthSecret(KEY, 'access-secret'),
          access_token_expires_at: new Date('2026-09-16T12:00:00.000Z'),
          credential_revision: '3',
          catalog_revision: '1',
          account_fingerprint: 'fp_abc',
          catalog_status: 'ready',
          catalog_synced_at: new Date('2026-09-16T11:00:00.000Z'),
          last_refresh_at: new Date('2026-09-16T11:30:00.000Z'),
          last_auth_at: new Date('2026-09-16T10:00:00.000Z'),
          refresh_lock_token: 'lock',
          refresh_lock_expires_at: new Date('2026-09-16T12:00:00.000Z'),
          revoked_at: null,
          created_at: new Date('2026-09-16T09:00:00.000Z'),
          updated_at: new Date('2026-09-16T11:30:00.000Z'),
        },
      ],
      rowCount: 1,
    })

    const metadata = await getSafeGrokSubscriptionConnection({ query }, 'team-grok')
    expect(metadata).toMatchObject({
      connectionKey: 'team-grok',
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
    expect(metadata).not.toHaveProperty('refreshToken')
    expect(metadata).not.toHaveProperty('accessToken')
    expect(String(query.mock.calls[0]?.[0])).not.toContain('chatgpt')
  })

  it('inserts encrypted credentials without ChatGPT columns', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          connection_key: 'team-grok',
          display_name: 'team-grok',
          created_by: null,
          status: 'connected',
          credential_revision: '1',
          catalog_revision: '0',
          account_fingerprint: 'fp_new',
          catalog_status: 'never_synced',
          catalog_synced_at: null,
          last_refresh_at: null,
          last_auth_at: new Date(),
          refresh_lock_token: null,
          refresh_lock_expires_at: null,
          revoked_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    })

    const metadata = await insertInitialGrokSubscriptionConnection(
      { query },
      KEY,
      {
        refreshToken: 'plain-refresh',
        accessToken: 'plain-access',
        accountFingerprint: 'fp_new',
      },
      'team-grok'
    )
    expect(metadata.connectionKey).toBe('team-grok')
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).not.toContain('chatgpt')
    const [, params] = query.mock.calls[0] as [string, unknown[]]
    expect(params).not.toContain('plain-refresh')
    expect(params).not.toContain('plain-access')
    expect(String(params[3])).toMatch(/^v1\./)
  })

  it('maps a unique active fingerprint violation to fingerprint_in_use', async () => {
    query.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), {
        code: '23505',
        constraint: 'grok_subscription_connections_active_fingerprint',
      })
    )
    await expect(
      insertInitialGrokSubscriptionConnection(
        { query },
        KEY,
        { refreshToken: 'plain-refresh', accountFingerprint: 'fp_dup' },
        'team-grok'
      )
    ).rejects.toBeInstanceOf(GrokSubscriptionFingerprintConflictError)
  })

  it('fences persist-first refresh on lock token, revision, and live lease', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(
      persistGrokRefreshCiphertextFirst({ query }, KEY, {
        connectionKey: 'team-grok',
        expectedRevision: 4,
        lockToken: 'lease-1',
        refreshToken: 'rotated-refresh',
      })
    ).rejects.toBeInstanceOf(GrokSubscriptionStaleRevisionError)
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('refresh_lock_token = $4')
    expect(sql).toContain('credential_revision = $3')
    expect(sql).toContain('refresh_lock_expires_at > now()')
    expect(sql).not.toContain('credential_revision + 1')
    const [, params] = query.mock.calls[0] as [string, unknown[]]
    expect(params).not.toContain('rotated-refresh')
  })
})
