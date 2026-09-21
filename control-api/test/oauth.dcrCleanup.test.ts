import { describe, expect, it } from 'vitest'
import { bestEffortRfc7592Delete, cleanupDynamicClientForServer } from '../src/oauth/dcrCleanup.js'
import { getDynamicClient, upsertDynamicClient } from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { makeDcrTransport, makeInMemoryDynamicClientsDb } from './fixtures/remoteOAuthDiscovery.js'

/**
 * C4/K (DEC-18) — uninstall teardown of a remote server's DCR client. The row is
 * written by the REAL store (`upsertDynamicClient`, T1 — encrypted envelope never
 * hand-built) and the RFC 7592 DELETE goes through the injected pinned transport.
 * Idempotent: a non-DCR server is a clean no-op.
 */

const ENC = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)
const PUBLIC_IP = async () => ['93.184.216.34']
const KEY = {
  ownerKind: 'mcpserver' as const,
  serverNamespace: 'mcp-server',
  serverName: 'notion-remote',
}

describe('cleanupDynamicClientForServer (uninstall)', () => {
  it('revokes the local row AND attempts the best-effort RFC 7592 delete', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    await upsertDynamicClient(db, ENC, {
      ...KEY,
      issuer: 'https://mcp.notion.com',
      clientId: 'dcr-client-123',
      clientMode: 'confidential',
      clientSecret: 'shh',
      registrationAccessToken: 'reg-bearer-xyz',
      registrationClientUri: 'https://mcp.notion.com/register/dcr-client-123',
    })

    const { transport, calls } = makeDcrTransport({ responseJson: '' })
    const result = await cleanupDynamicClientForServer(
      db,
      ENC,
      { transport, resolveDns: PUBLIC_IP },
      KEY
    )

    expect(result).toEqual({ localRowsDeleted: 1, attemptedRemoteDelete: true })
    // Local row gone.
    expect(await getDynamicClient(db, ENC, KEY)).toBeNull()
    // RFC 7592 DELETE hit the registration_client_uri with the bearer.
    const del = calls.find(c => c.method === 'DELETE')
    expect(del?.url).toBe('https://mcp.notion.com/register/dcr-client-123')
    expect(del?.headers.authorization).toBe('Bearer reg-bearer-xyz')
  })

  it('is idempotent — a server with no DCR client is a clean no-op (0 rows, no remote delete)', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    const { transport, calls } = makeDcrTransport({ responseJson: '' })
    const result = await cleanupDynamicClientForServer(
      db,
      ENC,
      { transport, resolveDns: PUBLIC_IP },
      KEY
    )
    expect(result).toEqual({ localRowsDeleted: 0, attemptedRemoteDelete: false })
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  })

  it('a DCR row without a management handle still deletes locally (no remote delete)', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    await upsertDynamicClient(db, ENC, {
      ...KEY,
      issuer: 'https://mcp.notion.com',
      clientId: 'dcr-client-nohandle',
      clientMode: 'public',
    })
    const { transport, calls } = makeDcrTransport({ responseJson: '' })
    const result = await cleanupDynamicClientForServer(
      db,
      ENC,
      { transport, resolveDns: PUBLIC_IP },
      KEY
    )
    expect(result).toEqual({ localRowsDeleted: 1, attemptedRemoteDelete: false })
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  })

  it('bestEffortRfc7592Delete swallows transport failures (courtesy cleanup)', async () => {
    const transport = async () => {
      throw new Error('AS unreachable')
    }
    await expect(
      bestEffortRfc7592Delete(
        { transport, resolveDns: PUBLIC_IP },
        'https://mcp.notion.com/register/x',
        'tok'
      )
    ).resolves.toBeUndefined()
  })
})
