import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import type { DbClient, DbTransactionClient } from '../src/db.js'
import { initDb, withTransaction } from '../src/db.js'
import {
  PENDING_TTL_MS,
  type UpsertDynamicClientInput,
  bindDynamicClientToResource,
  claimDeleteDynamicClientForResource,
  classifyExistingDynamicClient,
  deleteDynamicClientOwnedByInstall,
  getDynamicClient,
  insertDynamicClientPending,
  isDynamicClientIdRegistered,
  reclaimOrphanDynamicClient,
  upsertDynamicClient,
} from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'

/**
 * Install-identity store primitives, observed as SURVIVING ROWS and returned
 * handles (T4), not as SQL text. dynamic_clients had no real-PG suite; the
 * in-memory fake re-implements the SQL by hand and so cannot certify
 * `ON CONFLICT DO NOTHING`, the reclaim CAS or `DELETE … RETURNING` (T1). Every
 * seeded row is built by the REAL producers (insertDynamicClientPending / bind /
 * upsertDynamicClient for a legacy row) and read through the REAL getDynamicClient.
 *
 * Gated on a real Postgres like the other integration suites:
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432/<db> npm test -- \
 *     test/oauth.dynamicClientStore.installIdentity.realPostgres.integration.test.ts
 */
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NS = config.mcpServersNamespace

// classifyExistingDynamicClient is pure — cover its exhaustive table with no DB.
describe('classifyExistingDynamicClient — ownership decision table', () => {
  const fresh = 1000
  const expired = PENDING_TTL_MS + 1000

  it('a live CR owns the name regardless of the row state → in-use', () => {
    expect(
      classifyExistingDynamicClient(
        { installId: null, crUid: null, ageMs: fresh },
        { pendingTtlMs: PENDING_TTL_MS, liveCrUid: 'uid-live' }
      )
    ).toBe('in-use')
    expect(
      classifyExistingDynamicClient(
        { installId: 'i1', crUid: 'uid-old', ageMs: expired },
        { pendingTtlMs: PENDING_TTL_MS, liveCrUid: 'uid-live' }
      )
    ).toBe('in-use')
    // A live CR beats even a fresh pending row (the pre-check→INSERT TOCTOU race).
    expect(
      classifyExistingDynamicClient(
        { installId: 'i1', crUid: null, ageMs: fresh },
        { pendingTtlMs: PENDING_TTL_MS, liveCrUid: 'uid-live' }
      )
    ).toBe('in-use')
  })

  it('at exactly the TTL boundary a pending row is reclaimable (in-progress is strictly under)', () => {
    expect(
      classifyExistingDynamicClient(
        { installId: 'i1', crUid: null, ageMs: PENDING_TTL_MS },
        { pendingTtlMs: PENDING_TTL_MS }
      )
    ).toBe('reclaimable')
  })

  it('a fresh pending row with no live CR → in-progress', () => {
    expect(
      classifyExistingDynamicClient(
        { installId: 'i1', crUid: null, ageMs: fresh },
        { pendingTtlMs: PENDING_TTL_MS }
      )
    ).toBe('in-progress')
  })

  it('a bound orphan (cr_uid set, no live CR) → reclaimable', () => {
    expect(
      classifyExistingDynamicClient(
        { installId: 'i1', crUid: 'uid-gone', ageMs: fresh },
        { pendingTtlMs: PENDING_TTL_MS }
      )
    ).toBe('reclaimable')
  })

  it('an expired pending row → reclaimable', () => {
    expect(
      classifyExistingDynamicClient(
        { installId: 'i1', crUid: null, ageMs: expired },
        { pendingTtlMs: PENDING_TTL_MS }
      )
    ).toBe('reclaimable')
  })

  it('a legacy row (both null, no live CR) → reclaimable', () => {
    expect(
      classifyExistingDynamicClient(
        { installId: null, crUid: null, ageMs: fresh },
        { pendingTtlMs: PENDING_TTL_MS }
      )
    ).toBe('reclaimable')
  })
})

describeRealPostgres('dynamicClientStore install identity (real Postgres)', () => {
  const database = `control_api_dcinstallid_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  // A transaction runner bound to the disposable pool, injected into the reclaim
  // primitive so its FOR UPDATE + CAS run against THIS database, not the module pool.
  let runInTransaction: <T>(work: (tx: DbTransactionClient) => Promise<T>) => Promise<T>

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
    runInTransaction = work => withTransaction(work, dbPool)
  })

  afterAll(async () => {
    await dbPool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      await adminPool.end()
    }
  })

  const baseCreds = (serverName: string, overrides: Partial<UpsertDynamicClientInput> = {}) =>
    ({
      serverNamespace: NS,
      serverName,
      issuer: 'https://as.example.com',
      clientId: `cid-${serverName}`,
      clientMode: 'confidential' as const,
      clientSecret: `secret-${serverName}`,
      registrationAccessToken: `rat-${serverName}`,
      registrationClientUri: `https://as.example.com/reg/${serverName}`,
      ...overrides,
    }) satisfies UpsertDynamicClientInput

  it('insertDynamicClientPending claims an empty name and NEVER clobbers an existing row', async () => {
    const name = `srv-insert-${randomUUID().slice(0, 8)}`
    const install1 = randomUUID()

    const first = await insertDynamicClientPending(db, KEY, {
      ...baseCreds(name, { clientId: 'cid-original', clientSecret: 'secret-original' }),
      installId: install1,
    })
    expect(first.inserted).toBe(true)

    const before = await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: name })
    expect(before?.installId).toBe(install1)
    expect(before?.crUid).toBeUndefined()
    expect(before?.clientId).toBe('cid-original')
    expect(before?.clientSecret).toBe('secret-original')
    expect(before?.registrationAccessToken).toBe(`rat-${name}`)

    // A second install of the same name with DIFFERENT creds: conflict, no write.
    const install2 = randomUUID()
    const second = await insertDynamicClientPending(db, KEY, {
      ...baseCreds(name, { clientId: 'cid-attacker', clientSecret: 'secret-attacker' }),
      registrationAccessToken: 'rat-attacker',
      registrationClientUri: 'https://as.example.com/reg/attacker',
      installId: install2,
    })
    expect(second.inserted).toBe(false)

    const after = await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: name })
    // Byte-identical to `before`: the existing row is untouched.
    expect(after?.installId).toBe(install1)
    expect(after?.clientId).toBe('cid-original')
    expect(after?.clientSecret).toBe('secret-original')
    expect(after?.registrationAccessToken).toBe(`rat-${name}`)
    expect(after?.registrationClientUri).toBe(`https://as.example.com/reg/${name}`)
  })

  it('isDynamicClientIdRegistered finds a client_id in pending, bound and legacy rows of the namespace only', async () => {
    const tag = randomUUID().slice(0, 8)
    const pending = `srv-idp-${tag}`
    const bound = `srv-idb-${tag}`
    const legacy = `srv-idl-${tag}`
    await insertDynamicClientPending(db, KEY, {
      ...baseCreds(pending, { clientId: `cid-p-${tag}` }),
      installId: randomUUID(),
    })
    const boundInstall = randomUUID()
    await insertDynamicClientPending(db, KEY, {
      ...baseCreds(bound, { clientId: `cid-b-${tag}` }),
      installId: boundInstall,
    })
    await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: bound },
      boundInstall,
      `uid-${tag}`
    )
    await upsertDynamicClient(db, KEY, baseCreds(legacy, { clientId: `cid-l-${tag}` }))

    for (const clientId of [`cid-p-${tag}`, `cid-b-${tag}`, `cid-l-${tag}`]) {
      expect(await isDynamicClientIdRegistered(db, { serverNamespace: NS, clientId })).toBe(true)
    }
    expect(
      await isDynamicClientIdRegistered(db, { serverNamespace: NS, clientId: `cid-none-${tag}` })
    ).toBe(false)
    expect(
      await isDynamicClientIdRegistered(db, {
        serverNamespace: `${NS}-other`,
        clientId: `cid-b-${tag}`,
      })
    ).toBe(false)
  })

  const keyOf = (serverName: string) => ({ serverNamespace: NS, serverName })

  /**
   * Age a real row past the pending TTL. Only `updated_at` moves (the DB clock the
   * store measures age against); every other column stays as the producer wrote it.
   */
  async function expirePending(serverName: string): Promise<void> {
    await db.query(
      `UPDATE dynamic_clients
          SET updated_at = NOW() - ($1::bigint * INTERVAL '1 millisecond')
        WHERE server_namespace = $2 AND server_name = $3`,
      [PENDING_TTL_MS + 60_000, NS, serverName]
    )
  }

  /** Every persisted column; `ageMs` is a read-time measurement, not row state. */
  const rowState = (row: Awaited<ReturnType<typeof getDynamicClient>>) => {
    if (!row) return row
    const { ageMs: _ageMs, ...state } = row
    return state
  }

  it('the row age is measured by the database: fresh pending → in-progress, aged → reclaimable', async () => {
    const name = `srv-age-${randomUUID().slice(0, 8)}`
    await insertDynamicClientPending(db, KEY, { ...baseCreds(name), installId: randomUUID() })

    const fresh = await getDynamicClient(db, KEY, keyOf(name))
    expect(fresh?.id).toMatch(/^\d+$/)
    expect(fresh?.ageMs).toBeGreaterThanOrEqual(0)
    expect(fresh?.ageMs).toBeLessThan(PENDING_TTL_MS)
    expect(
      classifyExistingDynamicClient(
        { installId: fresh?.installId ?? null, crUid: null, ageMs: fresh?.ageMs ?? 0 },
        { pendingTtlMs: PENDING_TTL_MS }
      )
    ).toBe('in-progress')

    await expirePending(name)
    const aged = await getDynamicClient(db, KEY, keyOf(name))
    expect(aged?.ageMs).toBeGreaterThanOrEqual(PENDING_TTL_MS)
    expect(
      classifyExistingDynamicClient(
        { installId: aged?.installId ?? null, crUid: null, ageMs: aged?.ageMs ?? 0 },
        { pendingTtlMs: PENDING_TTL_MS }
      )
    ).toBe('reclaimable')
  })

  it('reclaimOrphanDynamicClient takes over the observed orphan and returns the old handle', async () => {
    const name = `srv-reclaim-${randomUUID().slice(0, 8)}`
    const install1 = randomUUID()

    // Seed a BOUND ORPHAN via the real producers: pending insert, then bind to a
    // uid whose CR no longer exists.
    await insertDynamicClientPending(db, KEY, {
      ...baseCreds(name, { clientId: 'cid-old', clientSecret: 'secret-old' }),
      registrationAccessToken: 'rat-old',
      registrationClientUri: 'https://as.example.com/reg/old',
      installId: install1,
    })
    expect((await bindDynamicClientToResource(db, keyOf(name), install1, randomUUID())).bound).toBe(
      true
    )
    const observed = await getDynamicClient(db, KEY, keyOf(name))
    if (!observed) throw new Error('seeded row missing')

    const install2 = randomUUID()
    const reclaim = await reclaimOrphanDynamicClient(
      KEY,
      {
        key: keyOf(name),
        newCredentials: baseCreds(name, { clientId: 'cid-new', clientSecret: 'secret-new' }),
        newInstallId: install2,
        observed,
      },
      runInTransaction
    )
    expect(reclaim.reclaimed).toBe(true)
    // The old client's RFC 7592 handle comes back decrypted for revocation.
    expect(reclaim.oldHandle).toEqual({
      registrationClientUri: 'https://as.example.com/reg/old',
      registrationAccessToken: 'rat-old',
    })

    const owned = await getDynamicClient(db, KEY, keyOf(name))
    expect(owned?.id).toBe(observed.id)
    expect(owned?.installId).toBe(install2)
    expect(owned?.crUid).toBeUndefined()
    expect(owned?.clientId).toBe('cid-new')
    expect(owned?.clientSecret).toBe('secret-new')
    expect(owned?.registrationClientUri).toBe(`https://as.example.com/reg/${name}`)
  })

  // A pending row observed past its TTL (a crashed-looking saga) whose owner then
  // BINDS it to its freshly created CR before the reclaim lands. Only `cr_uid`
  // changes on bind, so the reclaim must refuse on the cr_uid guard — otherwise a
  // live install's credentials are overwritten and its client revoked at the AS.
  it('a row bound by its owner after it was observed is never reclaimed', async () => {
    const name = `srv-bindrace-${randomUUID().slice(0, 8)}`
    const ownerInstall = randomUUID()
    await insertDynamicClientPending(db, KEY, {
      ...baseCreds(name, { clientId: 'cid-owner', clientSecret: 'secret-owner' }),
      installId: ownerInstall,
    })
    await expirePending(name)

    const observed = await getDynamicClient(db, KEY, keyOf(name))
    if (!observed) throw new Error('seeded row missing')
    // No live CR yet at this point → the caller classifies it reclaimable.
    expect(
      classifyExistingDynamicClient(
        {
          installId: observed.installId ?? null,
          crUid: observed.crUid ?? null,
          ageMs: observed.ageMs,
        },
        { pendingTtlMs: PENDING_TTL_MS }
      )
    ).toBe('reclaimable')

    // The owner's CR now exists and it binds its row.
    const ownerUid = randomUUID()
    expect((await bindDynamicClientToResource(db, keyOf(name), ownerInstall, ownerUid)).bound).toBe(
      true
    )
    const bound = await getDynamicClient(db, KEY, keyOf(name))

    const reclaim = await reclaimOrphanDynamicClient(
      KEY,
      {
        key: keyOf(name),
        newCredentials: baseCreds(name, { clientId: 'cid-thief', clientSecret: 'secret-thief' }),
        newInstallId: randomUUID(),
        observed,
      },
      runInTransaction
    )
    expect(reclaim.reclaimed).toBe(false)
    expect(reclaim.oldHandle).toBeUndefined()
    const after = await getDynamicClient(db, KEY, keyOf(name))
    expect(after?.crUid).toBe(ownerUid)
    expect(after?.clientSecret).toBe('secret-owner')
    expect(rowState(after)).toEqual(rowState(bound))
  })

  // Two sagas observe the same reclaimable row; B′ reclaims first. B′'s reclaim
  // leaves cr_uid NULL (as observed) and keeps the id, so only install_id tells B
  // that the row is no longer the one it classified.
  it('the second of two reclaims of the same observed row loses on install_id', async () => {
    const name = `srv-tworeclaims-${randomUUID().slice(0, 8)}`
    await insertDynamicClientPending(db, KEY, {
      ...baseCreds(name, { clientId: 'cid-crashed' }),
      installId: randomUUID(),
    })
    await expirePending(name)
    const observed = await getDynamicClient(db, KEY, keyOf(name))
    if (!observed) throw new Error('seeded row missing')

    const winnerInstall = randomUUID()
    const first = await reclaimOrphanDynamicClient(
      KEY,
      {
        key: keyOf(name),
        newCredentials: baseCreds(name, { clientId: 'cid-winner', clientSecret: 'secret-winner' }),
        newInstallId: winnerInstall,
        observed,
      },
      runInTransaction
    )
    expect(first.reclaimed).toBe(true)
    const won = await getDynamicClient(db, KEY, keyOf(name))

    const second = await reclaimOrphanDynamicClient(
      KEY,
      {
        key: keyOf(name),
        newCredentials: baseCreds(name, { clientId: 'cid-loser', clientSecret: 'secret-loser' }),
        newInstallId: randomUUID(),
        observed,
      },
      runInTransaction
    )
    expect(second.reclaimed).toBe(false)
    const after = await getDynamicClient(db, KEY, keyOf(name))
    expect(after?.installId).toBe(winnerInstall)
    expect(after?.clientId).toBe('cid-winner')
    expect(rowState(after)).toEqual(rowState(won))
  })

  it('reclaimOrphanDynamicClient loses when the observed row was deleted', async () => {
    const name = `srv-reclaimgone-${randomUUID().slice(0, 8)}`
    const install1 = randomUUID()
    await insertDynamicClientPending(db, KEY, { ...baseCreds(name), installId: install1 })
    const observed = await getDynamicClient(db, KEY, keyOf(name))
    if (!observed) throw new Error('seeded row missing')
    await deleteDynamicClientOwnedByInstall(db, keyOf(name), install1)

    const reclaim = await reclaimOrphanDynamicClient(
      KEY,
      {
        key: keyOf(name),
        newCredentials: baseCreds(name, { clientId: 'cid-late' }),
        newInstallId: randomUUID(),
        observed,
      },
      runInTransaction
    )
    expect(reclaim.reclaimed).toBe(false)
    expect(await getDynamicClient(db, KEY, keyOf(name))).toBeNull()
  })

  it('bindDynamicClientToResource binds our pending row and refuses a non-matching install', async () => {
    const bindName = `srv-bind-${randomUUID().slice(0, 8)}`
    const install = randomUUID()
    const uid = randomUUID()
    await insertDynamicClientPending(db, KEY, { ...baseCreds(bindName), installId: install })

    const ok = await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: bindName },
      install,
      uid
    )
    expect(ok.bound).toBe(true)
    const bound = await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: bindName })
    expect(bound?.crUid).toBe(uid)

    // A fresh pending row bound with the WRONG install_id must not bind.
    const mismatchName = `srv-bind-mismatch-${randomUUID().slice(0, 8)}`
    await insertDynamicClientPending(db, KEY, {
      ...baseCreds(mismatchName),
      installId: randomUUID(),
    })
    const bad = await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: mismatchName },
      randomUUID(),
      randomUUID()
    )
    expect(bad.bound).toBe(false)
    const stillPending = await getDynamicClient(db, KEY, {
      serverNamespace: NS,
      serverName: mismatchName,
    })
    expect(stillPending?.crUid).toBeUndefined()
  })

  it('deleteDynamicClientOwnedByInstall removes only the matching install, leaving other rows', async () => {
    const mine = `srv-del-mine-${randomUUID().slice(0, 8)}`
    const other = `srv-del-other-${randomUUID().slice(0, 8)}`
    const myInstall = randomUUID()
    const otherInstall = randomUUID()
    await insertDynamicClientPending(db, KEY, { ...baseCreds(mine), installId: myInstall })
    await insertDynamicClientPending(db, KEY, { ...baseCreds(other), installId: otherInstall })

    // Wrong install → nothing removed, row survives.
    expect(
      await deleteDynamicClientOwnedByInstall(
        db,
        { serverNamespace: NS, serverName: mine },
        randomUUID()
      )
    ).toBe(0)
    expect(
      await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: mine })
    ).not.toBeNull()

    // Right install → removed.
    expect(
      await deleteDynamicClientOwnedByInstall(
        db,
        { serverNamespace: NS, serverName: mine },
        myInstall
      )
    ).toBe(1)
    expect(await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: mine })).toBeNull()

    // The row owned by a DIFFERENT install is untouched.
    const survivor = await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: other })
    expect(survivor?.installId).toBe(otherInstall)
  })

  it('claimDeleteDynamicClientForResource deletes the U-bound and legacy rows, spares other-uid and pending', async () => {
    const uid = randomUUID()

    // Row bound to U (real producers) — deleted, handle returned.
    const boundName = `srv-claim-bound-${randomUUID().slice(0, 8)}`
    const boundInstall = randomUUID()
    await insertDynamicClientPending(db, KEY, {
      ...baseCreds(boundName, { clientId: 'cid-bound' }),
      registrationAccessToken: 'rat-bound',
      registrationClientUri: 'https://as.example.com/reg/bound',
      installId: boundInstall,
    })
    await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: boundName },
      boundInstall,
      uid
    )

    // Legacy row (install_id NULL, cr_uid NULL) via the real legacy producer
    // upsertDynamicClient — the only writer that emits a pre-install-identity row.
    const legacyName = `srv-claim-legacy-${randomUUID().slice(0, 8)}`
    await upsertDynamicClient(db, KEY, {
      ...baseCreds(legacyName, { clientId: 'cid-legacy' }),
      registrationAccessToken: 'rat-legacy',
      registrationClientUri: 'https://as.example.com/reg/legacy',
    })

    // Row bound to a DIFFERENT uid — spared.
    const otherName = `srv-claim-other-${randomUUID().slice(0, 8)}`
    const otherInstall = randomUUID()
    await insertDynamicClientPending(db, KEY, { ...baseCreds(otherName), installId: otherInstall })
    await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: otherName },
      otherInstall,
      randomUUID()
    )

    // Pending row (reinstall in flight) — spared.
    const pendingName = `srv-claim-pending-${randomUUID().slice(0, 8)}`
    await insertDynamicClientPending(db, KEY, {
      ...baseCreds(pendingName),
      installId: randomUUID(),
    })

    const boundClaim = await claimDeleteDynamicClientForResource(
      db,
      KEY,
      { serverNamespace: NS, serverName: boundName },
      uid
    )
    expect(boundClaim.deleted).toBe(true)
    expect(boundClaim.handle).toEqual({
      registrationClientUri: 'https://as.example.com/reg/bound',
      registrationAccessToken: 'rat-bound',
    })
    expect(
      await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: boundName })
    ).toBeNull()

    const legacyClaim = await claimDeleteDynamicClientForResource(
      db,
      KEY,
      { serverNamespace: NS, serverName: legacyName },
      uid
    )
    expect(legacyClaim.deleted).toBe(true)
    expect(legacyClaim.handle).toEqual({
      registrationClientUri: 'https://as.example.com/reg/legacy',
      registrationAccessToken: 'rat-legacy',
    })
    expect(
      await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: legacyName })
    ).toBeNull()

    // A claim of U against the OTHER-uid row deletes nothing.
    const otherClaim = await claimDeleteDynamicClientForResource(
      db,
      KEY,
      { serverNamespace: NS, serverName: otherName },
      uid
    )
    expect(otherClaim.deleted).toBe(false)
    expect(
      await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: otherName })
    ).not.toBeNull()

    // A claim of U against the PENDING row deletes nothing.
    const pendingClaim = await claimDeleteDynamicClientForResource(
      db,
      KEY,
      { serverNamespace: NS, serverName: pendingName },
      uid
    )
    expect(pendingClaim.deleted).toBe(false)
    expect(
      await getDynamicClient(db, KEY, { serverNamespace: NS, serverName: pendingName })
    ).not.toBeNull()
  })

  it('migration 0121 is idempotent — re-running the guarded DDL over an already-migrated DB does not error', async () => {
    // Force applyPendingMigrations to re-run applyOAuthInstallIdentity against a DB
    // that ALREADY has the columns and CHECK constraints. This exercises the real
    // guards (ADD COLUMN IF NOT EXISTS + pg_constraint DO-blocks) end to end — a
    // mocked pg that never executes DDL cannot. A dropped guard would raise a
    // duplicate-object error here instead of resolving.
    await db.query(`DELETE FROM schema_migrations WHERE version = '0121_oauth_install_identity'`)
    await expect(initDb({ connect: () => dbPool.connect() })).resolves.not.toThrow()

    // Still exactly one copy of each object — no duplicate column or constraint.
    const cols = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'dynamic_clients' AND column_name IN ('install_id', 'cr_uid')`
    )
    expect((cols.rows[0] as { n: number }).n).toBe(2)
    const checks = await db.query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname IN ('dynamic_clients_cr_uid_len', 'dynamic_clients_bound_needs_install', 'oauth_grants_cr_uid_len')`
    )
    expect((checks.rows[0] as { n: number }).n).toBe(3)
  })
})
