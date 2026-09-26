import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import {
  deleteDynamicClient,
  getDynamicClient,
  upsertDynamicClient,
} from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { makeInMemoryDynamicClientsDb } from './fixtures/remoteOAuthDiscovery.js'

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

function fakeDb(
  rows: unknown[] = [],
  rowCount?: number
): { db: DbClient; calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = []
  const db = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values })
      return { rows, rowCount: rowCount ?? rows.length } as never
    },
  } as unknown as DbClient
  return { db, calls }
}

const CONF_KEY = {
  ownerKind: 'mcpserver' as const,
  serverNamespace: 'mcp-server',
  serverName: 'vercel-remote',
}

describe('dynamicClientStore — upsert SQL + encryption at rest', () => {
  it('upsert INSERTs … ON CONFLICT DO UPDATE keyed by (owner_kind, server_namespace, server_name)', async () => {
    const { db, calls } = fakeDb([], 1)
    await upsertDynamicClient(db, KEY, {
      ...CONF_KEY,
      issuer: 'https://as.example.com',
      clientId: 'cid-1',
      clientMode: 'confidential',
      clientSecret: 'shhh',
      registrationAccessToken: 'reg-bearer',
      registrationClientUri: 'https://as.example.com/register/cid-1',
      clientIdIssuedAtSec: 1_758_326_400,
      clientSecretExpiresAtSec: 0,
    })
    expect(calls[0].text).toContain('INSERT INTO dynamic_clients')
    expect(calls[0].text).toContain('ON CONFLICT (owner_kind, server_namespace, server_name)')
    expect(calls[0].text).toContain('DO UPDATE SET')
    expect(calls[0].values.slice(0, 6)).toEqual([
      'mcpserver',
      'mcp-server',
      'vercel-remote',
      'https://as.example.com',
      'cid-1',
      'confidential',
    ])
    // The secret + registration token are stored as v1 envelopes, NEVER plaintext.
    const [secretEnc, regEnc] = [calls[0].values[6], calls[0].values[7]] as [string, string]
    expect(secretEnc).not.toBe('shhh')
    expect(secretEnc.startsWith('v1.')).toBe(true)
    expect(regEnc).not.toBe('reg-bearer')
    expect(regEnc.startsWith('v1.')).toBe(true)
    // client_secret_expires_at seconds 0 ⇒ NULL (non-expiring).
    expect(calls[0].values[10]).toBeNull()
    // client_id_issued_at seconds → Date.
    expect(calls[0].values[9]).toBeInstanceOf(Date)
  })

  it('a public client stores NULL for the secret + registration token', async () => {
    const { db, calls } = fakeDb([], 1)
    await upsertDynamicClient(db, KEY, {
      ...CONF_KEY,
      issuer: 'https://as.example.com',
      clientId: 'cid-public',
      clientMode: 'public',
    })
    expect(calls[0].values[5]).toBe('public')
    expect(calls[0].values[6]).toBeNull()
    expect(calls[0].values[7]).toBeNull()
  })

  it('delete is a hard DELETE keyed by owner coordinates, returning rowCount (idempotent)', async () => {
    const { db, calls } = fakeDb([], 0)
    const removed = await deleteDynamicClient(db, CONF_KEY)
    expect(removed).toBe(0)
    expect(calls[0].text).toContain('DELETE FROM dynamic_clients')
    expect(calls[0].values).toEqual(['mcpserver', 'mcp-server', 'vercel-remote'])
  })

  it('defaults ownerKind to mcpserver when omitted', async () => {
    const { db, calls } = fakeDb([], 1)
    await deleteDynamicClient(db, { serverNamespace: 'mcp-server', serverName: 'x' })
    expect(calls[0].values[0]).toBe('mcpserver')
  })
})

describe('dynamicClientStore — round-trip (T1: envelope from the real producer)', () => {
  it('upsert → get returns the decrypted secret + registration token, expiry mapped', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    await upsertDynamicClient(db, KEY, {
      ...CONF_KEY,
      issuer: 'https://as.example.com',
      clientId: 'cid-rt',
      clientMode: 'confidential',
      clientSecret: 'round-trip-secret',
      registrationAccessToken: 'round-trip-bearer',
      registrationClientUri: 'https://as.example.com/register/cid-rt',
      clientIdIssuedAtSec: 1_758_326_400,
      clientSecretExpiresAtSec: 1_758_412_800,
    })
    const row = await getDynamicClient(db, KEY, CONF_KEY)
    expect(row).not.toBeNull()
    expect(row?.clientId).toBe('cid-rt')
    expect(row?.clientMode).toBe('confidential')
    expect(row?.clientSecret).toBe('round-trip-secret')
    expect(row?.registrationAccessToken).toBe('round-trip-bearer')
    expect(row?.registrationClientUri).toBe('https://as.example.com/register/cid-rt')
    expect(row?.clientSecretExpiresAt).toBeInstanceOf(Date)
  })

  it('a public client round-trips with undefined secret/registration token', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    await upsertDynamicClient(db, KEY, {
      ...CONF_KEY,
      issuer: 'https://as.example.com',
      clientId: 'cid-pub',
      clientMode: 'public',
    })
    const row = await getDynamicClient(db, KEY, CONF_KEY)
    expect(row?.clientSecret).toBeUndefined()
    expect(row?.registrationAccessToken).toBeUndefined()
    expect(row?.clientSecretExpiresAt).toBeUndefined()
  })

  it('get returns null when no row exists', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    expect(await getDynamicClient(db, KEY, CONF_KEY)).toBeNull()
  })

  // T2 — property: for any secret/token strings, the store never persists plaintext
  // and always round-trips; re-upserting the same input is idempotent on read.
  it('round-trips arbitrary secret material without ever storing plaintext (T2)', () => {
    fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        async (clientSecret, registrationAccessToken) => {
          const { db, rows } = makeInMemoryDynamicClientsDb()
          const input = {
            ...CONF_KEY,
            issuer: 'https://as.example.com',
            clientId: 'cid-prop',
            clientMode: 'confidential' as const,
            clientSecret,
            registrationAccessToken,
          }
          await upsertDynamicClient(db, KEY, input)
          // idempotent: a second identical upsert overwrites in place, still one row.
          await upsertDynamicClient(db, KEY, input)
          expect(rows.size).toBe(1)
          const stored = [...rows.values()][0]
          expect(stored.client_secret_encrypted).not.toBe(clientSecret)
          expect(stored.registration_access_token_encrypted).not.toBe(registrationAccessToken)
          const row = await getDynamicClient(db, KEY, CONF_KEY)
          expect(row?.clientSecret).toBe(clientSecret)
          expect(row?.registrationAccessToken).toBe(registrationAccessToken)
        }
      )
    )
  })
})
