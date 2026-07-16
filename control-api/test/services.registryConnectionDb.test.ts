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
  markConnected,
  resolveMachineCreds,
  resolveVoucherSigningMaterial,
  upsertPendingConnection,
} from '../src/services/registryConnectionDb.js'
// NOTE: Task 3 imports VoucherUnavailableError from registryConnectionDb (its
// authoritative home). Task 4 re-exports it from registryVoucher.js and flips
// this import to match the production path.
import { VoucherUnavailableError } from '../src/services/registryConnectionDb.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'managed',
    registryVoucherPrivateKey: '',
    registryVoucherKid: '',
    registryClientId: '',
    registryClientSecret: '',
    registryUrl: 'https://example.com',
    oauthEncryptionKey: '',
  } as Record<string, string>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const dbQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (t: string, v?: unknown[]) => dbQuery(t, v) },
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
    registry_url: 'https://example.com',
    ...overrides,
  }
}

afterEach(() => {
  __resetRegistryConnectionCacheForTests()
  dbQuery.mockReset()
  cfg.registryConnectionMode = 'managed'
  cfg.registryVoucherPrivateKey = ''
  cfg.registryVoucherKid = ''
  cfg.registryClientId = ''
  cfg.registryClientSecret = ''
  cfg.registryUrl = 'https://example.com'
  cfg.oauthEncryptionKey = ''
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
      registryUrl: 'https://example.com',
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
  })
})

describe('markConnected — writes ciphertext for the client secret (C-I3a)', () => {
  it('encrypts the client secret; the stored param round-trips, plaintext never persisted', async () => {
    const encKeyHex = randomBytes(32).toString('hex')
    cfg.oauthEncryptionKey = encKeyHex
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    await markConnected({ clientId: 'cid-9', clientSecret: 'super-secret-xyz', orgName: 'acme' })

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
    await deleteConnection()
    expect(
      dbQuery.mock.calls.some(([sql]) => /DELETE FROM registry_connection/.test(String(sql)))
    ).toBe(true)
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
