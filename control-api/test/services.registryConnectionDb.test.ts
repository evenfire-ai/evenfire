// test/services.registryConnectionDb.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  decryptOAuthSecret,
  deriveOAuthEncryptionKey,
  encryptOAuthSecret,
} from '../src/oauth/encryption.js'
import {
  __resetRegistryConnectionCacheForTests,
  deleteConnection,
  getRegistryConnection,
  isRegistryAuthActive,
  markConnected,
  resolveMachineCreds,
  resolveVoucherSigningMaterial,
  upsertPendingConnection,
} from '../src/services/registryConnectionDb.js'
// NOTE: Task 3 imports VoucherUnavailableError from registryConnectionDb (its
// authoritative home). Task 4 re-exports it from registryVoucher.js and flips
// this import to match the production path.
import { VoucherUnavailableError } from '../src/services/registryConnectionDb.js'
import {
  __resetRegistryIdentityCacheGenerationForTests,
  getRegistryIdentityCacheGeneration,
} from '../src/services/registryIdentityCache.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'managed',
    registryVoucherPrivateKey: '',
    registryVoucherKid: '',
    registryClientId: '',
    registryClientSecret: '',
    registryUrl: 'https://registry.evenfire.ai',
    oauthEncryptionKey: '',
  } as Record<string, string | boolean>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const dbQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (t: string, v?: unknown[]) => dbQuery(t, v) },
  withTransaction: async (fn: (db: unknown) => Promise<unknown>) =>
    fn({ query: (t: string, v?: unknown[]) => dbQuery(t, v) }),
}))

const keypair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

interface RawRowShape {
  deployment_id: string
  key_id: string
  public_key_pem: string
  private_key_encrypted: string
  client_id: string | null
  client_secret_encrypted: string | null
  org_name: string | null
  requested_org_name: string
  contact_email: string
  status: 'pending' | 'approved' | 'connected'
  registry_url: string | null
}

// Build a DB row whose private_key_encrypted is valid ciphertext under encKeyHex
// (getRegistryConnection always decrypts it), with overridable columns.
function makeRawRow(encKeyHex: string, overrides: Partial<RawRowShape> = {}): RawRowShape {
  const key = deriveOAuthEncryptionKey(encKeyHex)
  return {
    deployment_id: 'dep-1',
    key_id: 'row-kid',
    public_key_pem: 'PUB',
    private_key_encrypted: encryptOAuthSecret(key, 'PRIV-PLACEHOLDER'),
    client_id: null,
    client_secret_encrypted: null,
    org_name: null,
    requested_org_name: 'acme',
    contact_email: 'a@x.io',
    status: 'pending',
    registry_url: 'https://registry.evenfire.ai',
    ...overrides,
  }
}

afterEach(() => {
  __resetRegistryConnectionCacheForTests()
  __resetRegistryIdentityCacheGenerationForTests()
  dbQuery.mockReset()
  cfg.registryConnectionMode = 'managed'
  cfg.registryVoucherPrivateKey = ''
  cfg.registryVoucherKid = ''
  cfg.registryClientId = ''
  cfg.registryClientSecret = ''
  cfg.registryUrl = 'https://registry.evenfire.ai'
  cfg.oauthEncryptionKey = ''
  cfg.registryAuthEnabled = false
})

describe('resolveVoucherSigningMaterial — managed', () => {
  it('returns the env voucher key + kid', async () => {
    const { privateKey } = keypair()
    cfg.registryVoucherPrivateKey = privateKey
    cfg.registryVoucherKid = 'key-uuid-123'
    const { signingKey, kid } = await resolveVoucherSigningMaterial()
    expect(signingKey).toBe(privateKey)
    expect(kid).toBe('key-uuid-123')
    // managed never touches the DB
    expect(dbQuery).not.toHaveBeenCalled()
  })

  it('throws VoucherUnavailableError when the env kid is missing', async () => {
    cfg.registryVoucherPrivateKey = keypair().privateKey
    cfg.registryVoucherKid = ''
    await expect(resolveVoucherSigningMaterial()).rejects.toBeInstanceOf(VoucherUnavailableError)
  })

  it('throws VoucherUnavailableError when the env key is missing', async () => {
    cfg.registryVoucherPrivateKey = ''
    cfg.registryVoucherKid = 'key-uuid-123'
    await expect(resolveVoucherSigningMaterial()).rejects.toBeInstanceOf(VoucherUnavailableError)
  })
})

describe('resolveVoucherSigningMaterial — self-hosted', () => {
  it('decrypts the private key from the DB row and uses row.key_id as kid', async () => {
    const { privateKey } = keypair()
    const encKey = randomBytes(32).toString('hex')
    cfg.registryConnectionMode = 'self-hosted'
    cfg.oauthEncryptionKey = encKey
    const enc = encryptOAuthSecret(deriveOAuthEncryptionKey(encKey), privateKey)
    dbQuery.mockResolvedValueOnce({
      rows: [makeRawRow(encKey, { key_id: 'row-kid-9', private_key_encrypted: enc })],
      rowCount: 1,
    })
    const { signingKey, kid } = await resolveVoucherSigningMaterial()
    expect(signingKey).toBe(privateKey)
    expect(kid).toBe('row-kid-9')
  })

  it('throws VoucherUnavailableError when there is no row', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(resolveVoucherSigningMaterial()).rejects.toBeInstanceOf(VoucherUnavailableError)
  })
})

describe('getRegistryConnection', () => {
  it('returns null when no row exists', async () => {
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await getRegistryConnection()).toBeNull()
  })

  it('decrypts private key + client secret and maps snake_case → camelCase', async () => {
    const encKey = randomBytes(32).toString('hex')
    cfg.oauthEncryptionKey = encKey
    const key = deriveOAuthEncryptionKey(encKey)
    const { privateKey } = keypair()
    dbQuery.mockResolvedValueOnce({
      rows: [
        makeRawRow(encKey, {
          key_id: 'kid-x',
          private_key_encrypted: encryptOAuthSecret(key, privateKey),
          client_id: 'cid-7',
          client_secret_encrypted: encryptOAuthSecret(key, 'the-secret'),
          org_name: 'acme',
          status: 'connected',
        }),
      ],
      rowCount: 1,
    })
    const row = await getRegistryConnection()
    expect(row).not.toBeNull()
    expect(row!.keyId).toBe('kid-x')
    expect(row!.privateKeyPem).toBe(privateKey)
    expect(row!.clientId).toBe('cid-7')
    expect(row!.clientSecret).toBe('the-secret')
    expect(row!.orgName).toBe('acme')
    expect(row!.status).toBe('connected')
  })
})

// ─── C-I3: execution coverage for the security-critical write + resolver paths ──

describe('upsertPendingConnection — writes ciphertext, never plaintext (C-I3a)', () => {
  it('encrypts the private key PEM; the stored param round-trips via decryptOAuthSecret', async () => {
    const { privateKey } = keypair()
    const encKeyHex = randomBytes(32).toString('hex')
    cfg.oauthEncryptionKey = encKeyHex
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    await upsertPendingConnection({
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      publicKeyPem: 'PUB-PEM',
      privateKeyPem: privateKey,
      requestedOrgName: 'acme',
      contactEmail: 'a@x.io',
      registryUrl: 'https://registry.evenfire.ai',
    })

    // A DELETE precedes the INSERT (singleton replace).
    expect(
      dbQuery.mock.calls.some(([sql]) => /DELETE FROM registry_connection/.test(String(sql)))
    ).toBe(true)

    const insert = dbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO registry_connection')
    )
    expect(insert).toBeDefined()
    const params = insert![1] as string[]
    // params order: [deploymentId, keyId, publicKeyPem, encPriv, requestedOrgName, contactEmail, registryUrl]
    const storedPriv = params[3]
    expect(storedPriv).not.toBe(privateKey)
    expect(storedPriv).not.toContain('PRIVATE KEY')
    expect(storedPriv.startsWith('v1.')).toBe(true)
    expect(decryptOAuthSecret(deriveOAuthEncryptionKey(encKeyHex), storedPriv)).toBe(privateKey)
    // The public key is NOT encrypted (it is public material).
    expect(params[2]).toBe('PUB-PEM')
    expect(getRegistryIdentityCacheGeneration()).toBe(1)
  })
})

describe('markConnected — writes ciphertext for the client secret (C-I3a)', () => {
  it('encrypts the client secret; the stored param round-trips, plaintext never persisted', async () => {
    const encKeyHex = randomBytes(32).toString('hex')
    cfg.oauthEncryptionKey = encKeyHex
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    await markConnected({
      deploymentId: 'dep-9',
      clientId: 'cid-9',
      clientSecret: 'super-secret-xyz',
      orgName: 'acme',
    })

    const upd = dbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE registry_connection')
    )
    expect(upd).toBeDefined()
    const params = upd![1] as string[]
    // params order: [clientId, encSecret, orgName]
    expect(params[0]).toBe('cid-9')
    const storedSecret = params[1]
    expect(storedSecret).not.toBe('super-secret-xyz')
    expect(storedSecret.startsWith('v1.')).toBe(true)
    expect(decryptOAuthSecret(deriveOAuthEncryptionKey(encKeyHex), storedSecret)).toBe(
      'super-secret-xyz'
    )
    expect(params[2]).toBe('acme')
    // status flips to connected in the SET clause
    expect(String(upd![0])).toMatch(/status\s*=\s*'connected'/)
  })
})

describe('deleteConnection', () => {
  it('deletes the singleton row and evicts the cache', async () => {
    dbQuery.mockResolvedValue({ rows: [], rowCount: 1 })
    const before = getRegistryIdentityCacheGeneration()
    await deleteConnection()
    expect(
      dbQuery.mock.calls.some(([sql]) => /DELETE FROM registry_connection/.test(String(sql)))
    ).toBe(true)
    expect(getRegistryIdentityCacheGeneration()).toBe(before + 1)
  })
})

describe('resolveMachineCreds (C-I3b)', () => {
  it('managed → returns env client creds, never touches the DB', async () => {
    cfg.registryConnectionMode = 'managed'
    cfg.registryClientId = 'env-cid'
    cfg.registryClientSecret = 'env-secret'
    const creds = await resolveMachineCreds()
    expect(creds).toEqual({
      clientId: 'env-cid',
      clientSecret: 'env-secret',
    })
    expect(dbQuery).not.toHaveBeenCalled()
  })

  it('managed + unconfigured → null', async () => {
    cfg.registryConnectionMode = 'managed'
    cfg.registryClientId = ''
    cfg.registryClientSecret = ''
    expect(await resolveMachineCreds()).toBeNull()
  })

  // resolveMachineCreds no longer returns a `url` (single source of truth =
  // config.registryUrl / registryClient API_BASE), so the former "row.registry_url
  // as url" assertion is dropped. The self-hosted branch still positively returns
  // the DB row's DECRYPTED client creds — that shape is what remains under test.
  it('self-hosted → returns the decrypted DB client creds', async () => {
    const encKeyHex = randomBytes(32).toString('hex')
    cfg.registryConnectionMode = 'self-hosted'
    cfg.oauthEncryptionKey = encKeyHex
    const encSecret = encryptOAuthSecret(deriveOAuthEncryptionKey(encKeyHex), 'db-secret-abc')
    dbQuery.mockResolvedValueOnce({
      rows: [
        makeRawRow(encKeyHex, {
          client_id: 'db-cid',
          client_secret_encrypted: encSecret,
          status: 'connected',
        }),
      ],
      rowCount: 1,
    })
    const creds = await resolveMachineCreds()
    expect(creds).toEqual({
      clientId: 'db-cid',
      clientSecret: 'db-secret-abc',
    })
  })

  it('self-hosted + no row → null', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await resolveMachineCreds()).toBeNull()
  })

  it('self-hosted + row present but client creds not yet claimed → null', async () => {
    const encKeyHex = randomBytes(32).toString('hex')
    cfg.registryConnectionMode = 'self-hosted'
    cfg.oauthEncryptionKey = encKeyHex
    dbQuery.mockResolvedValueOnce({
      rows: [
        makeRawRow(encKeyHex, {
          client_id: null,
          client_secret_encrypted: null,
          status: 'pending',
        }),
      ],
      rowCount: 1,
    })
    expect(await resolveMachineCreds()).toBeNull()
  })
})

describe('upsertPendingConnection — status parameter reaches the SQL', () => {
  it('defaults to pending', async () => {
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    await upsertPendingConnection({
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      publicKeyPem: 'PUB',
      privateKeyPem: keypair().privateKey,
      requestedOrgName: 'acme',
      contactEmail: 'a@x.io',
      registryUrl: 'https://r.example',
    })
    const insert = dbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO registry_connection')
    )
    // status is a BOUND PARAMETER ($7), not a SQL literal
    expect(String(insert![0])).not.toMatch(/'pending'/)
    expect((insert![1] as string[])[6]).toBe('pending')
  })

  it("writes 'approved' when asked", async () => {
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    await upsertPendingConnection({
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      publicKeyPem: 'PUB',
      privateKeyPem: keypair().privateKey,
      requestedOrgName: 'acme',
      contactEmail: 'a@x.io',
      registryUrl: 'https://r.example',
      status: 'approved',
    })
    const insert = dbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO registry_connection')
    )
    expect((insert![1] as string[])[6]).toBe('approved')
  })
})

describe('markConnected — scoped write', () => {
  it('scopes the UPDATE to the deployment and returns true on a match', async () => {
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    dbQuery.mockResolvedValue({ rows: [], rowCount: 1 })
    const ok = await markConnected({
      deploymentId: 'dep-9',
      clientId: 'cid-9',
      clientSecret: 'super-secret-xyz',
      orgName: 'acme',
    })
    expect(ok).toBe(true)
    expect(getRegistryIdentityCacheGeneration()).toBe(1)
    const upd = dbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE registry_connection')
    )
    // ONE contiguous assertion: mutating the AND to OR (a row belonging to a
    // DIFFERENT deployment with status 'pending' would then also match) must
    // fail this test. Two independent regexes each match an OR-joined clause
    // just as well as an AND-joined one, so they cannot catch that mutation.
    expect(String(upd![0])).toMatch(
      /WHERE\s+deployment_id\s*=\s*\$4\s+AND\s+status\s*<>\s*'connected'/
    )
    expect((upd![1] as string[])[3]).toBe('dep-9')
  })

  it('returns false when no row matched (row deleted or superseded mid-claim)', async () => {
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    const ok = await markConnected({
      deploymentId: 'dep-9',
      clientId: 'cid-9',
      clientSecret: 'super-secret-xyz',
      orgName: 'acme',
    })
    expect(ok).toBe(false)
    expect(getRegistryIdentityCacheGeneration()).toBe(0)
  })
})

describe('getRegistryConnection — cache TTL', () => {
  it('serves a cached ROW inside the window, re-queries after it', { retry: 0 }, async () => {
    vi.useFakeTimers()
    try {
      cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
      dbQuery.mockResolvedValue({ rows: [makeRawRow(cfg.oauthEncryptionKey)], rowCount: 1 })
      await getRegistryConnection()
      const afterFirst = dbQuery.mock.calls.length
      await getRegistryConnection()
      expect(dbQuery.mock.calls.length).toBe(afterFirst) // cache hit
      // Pin the TTL CONSTANT itself, not just its existence: 14_999ms elapsed
      // is still inside the 15_000ms window. Without this checkpoint, shrinking
      // CONNECTION_CACHE_TTL_MS to any smaller positive value would still pass
      // this test — the only two checks otherwise present (elapsed 0, elapsed
      // 15_001) cannot distinguish "TTL is 15_000" from "TTL is 1".
      vi.advanceTimersByTime(14_999)
      await getRegistryConnection()
      expect(dbQuery.mock.calls.length).toBe(afterFirst) // still cached
      vi.advanceTimersByTime(2) // total elapsed now 15_001
      await getRegistryConnection()
      expect(dbQuery.mock.calls.length).toBe(afterFirst + 1) // re-queried
    } finally {
      vi.useRealTimers()
    }
  })

  // The easiest way to implement the TTL wrong: stamp cachedAt only on the
  // row-found branch. Then `cached` is null (so `!== undefined` passes) but
  // cachedAt stays 0, and EVERY call re-queries — the most common self-hosted
  // state, hit on every mintToken and every admin-route auth check.
  it('serves a cached NULL inside the window without re-querying', { retry: 0 }, async () => {
    vi.useFakeTimers()
    try {
      dbQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      await getRegistryConnection()
      const afterFirst = dbQuery.mock.calls.length
      await getRegistryConnection()
      await getRegistryConnection()
      expect(dbQuery.mock.calls.length).toBe(afterFirst)
      // The TTL must apply to a cached NULL exactly as it does to a cached row.
      // The three reads above all happen at elapsed 0, so a mutation that
      // special-cases `if (cached === null) return cached` ahead of the
      // `Date.now() - cachedAt < TTL` check would cache "never connected"
      // forever and this test would not catch it. Advancing past the TTL and
      // requiring a re-query does.
      vi.advanceTimersByTime(15_001)
      await getRegistryConnection()
      expect(dbQuery.mock.calls.length).toBe(afterFirst + 1) // re-queried
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('isRegistryAuthActive', () => {
  it('managed: returns the env value verbatim (true)', async () => {
    cfg.registryConnectionMode = 'managed'
    cfg.registryAuthEnabled = true
    expect(await isRegistryAuthActive()).toBe(true)
  })

  it('managed: returns the env value verbatim (false)', async () => {
    cfg.registryConnectionMode = 'managed'
    cfg.registryAuthEnabled = false
    expect(await isRegistryAuthActive()).toBe(false)
  })

  it('self-hosted: false with no connection row', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await isRegistryAuthActive()).toBe(false)
  })

  // Kills a `row !== null` implementation. The DB status CHECK is
  // ('pending','approved','connected') — there is NO 'connecting' status. An
  // auto-approved-but-unclaimed row is status='approved' with a null client_id.
  it('self-hosted: false for an approved row with no client_id', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    dbQuery.mockResolvedValue({
      rows: [
        makeRawRow(cfg.oauthEncryptionKey, {
          status: 'approved',
          client_id: null,
          client_secret_encrypted: null,
        }),
      ],
      rowCount: 1,
    })
    expect(await isRegistryAuthActive()).toBe(false)
  })

  it('self-hosted: true for a claimed row', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    const encSecret = encryptOAuthSecret(
      deriveOAuthEncryptionKey(cfg.oauthEncryptionKey),
      'db-secret-abc'
    )
    dbQuery.mockResolvedValue({
      rows: [
        makeRawRow(cfg.oauthEncryptionKey, {
          status: 'connected',
          client_id: 'db-cid',
          client_secret_encrypted: encSecret,
        }),
      ],
      rowCount: 1,
    })
    expect(await isRegistryAuthActive()).toBe(true)
  })

  // Discriminator pin: status and credential-presence deliberately disagree.
  // isRegistryAuthActive derives auth from resolveMachineCreds (credential
  // presence via clientId/clientSecret), never from row.status. Every fixture
  // above happens to have status and credential-presence pointing the same
  // way, so mutating the self-hosted branch to
  // `(await getRegistryConnection())?.status === 'connected'` would still pass
  // all of them. A 'pending' row that already holds real machine credentials
  // must still report auth ACTIVE — that combination is exactly what a
  // status-based implementation gets wrong.
  it('self-hosted: true for a pending-status row that already holds real credentials', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
    const encSecret = encryptOAuthSecret(
      deriveOAuthEncryptionKey(cfg.oauthEncryptionKey),
      'db-secret-abc'
    )
    dbQuery.mockResolvedValue({
      rows: [
        makeRawRow(cfg.oauthEncryptionKey, {
          status: 'pending',
          client_id: 'db-cid',
          client_secret_encrypted: encSecret,
        }),
      ],
      rowCount: 1,
    })
    expect(await isRegistryAuthActive()).toBe(true)
  })
})
