import { afterEach, describe, expect, it, vi } from 'vitest'
import { GfsError } from '../api/errors'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbAuditSink, PermissionClient } from '../authz/permissionClient'
import { GfsSubjectResolutionDeniedError } from '../authz/subjectResolver'
import { createGfsUploadFinalizer } from './uploadFinalizer'
import type { UploadPartRow, UploadPrincipal, UploadSessionRow } from './uploadSession'

const UPLOAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PARENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RESOURCE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const FINALIZER_SUBJECT = 'host:1st:mcp-host/gfs-finalizer-test'
const BODY = Buffer.from('published upload')
const SHA256 = createHash('sha256').update(BODY).digest('hex')

function session(overrides: Partial<UploadSessionRow> = {}): UploadSessionRow {
  return {
    uploadId: UPLOAD_ID,
    idempotencyKey: 'finalizer-test',
    drive: 'main',
    ownerSubject: FINALIZER_SUBJECT,
    primarySubject: FINALIZER_SUBJECT,
    operation: 'create',
    requestFingerprint: 'fingerprint',
    parentRid: PARENT_ID,
    resourceRid: null,
    resourceName: 'payload.bin',
    ifMatch: null,
    expectedBytes: BODY.length,
    partBytes: BODY.length,
    partCount: 1,
    wholeSha256: SHA256,
    committedBytes: BODY.length,
    contiguousBytes: BODY.length,
    committedPartCount: 1,
    activePartCount: 0,
    sessionEpoch: 0,
    state: 'finalizing',
    resultResourceId: null,
    resultVersion: null,
    resultSha256: null,
    failureCode: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }
}

function replaceSession(): UploadSessionRow {
  return session({
    operation: 'replace',
    parentRid: null,
    resourceRid: RESOURCE_ID,
    resourceName: null,
    ifMatch: 0,
  })
}

function part(root: string): UploadPartRow {
  return {
    uploadId: UPLOAD_ID,
    partNumber: 0,
    offsetBytes: 0,
    lengthBytes: BODY.length,
    sha256: SHA256,
    state: 'committed',
    stagingPath: join(root, '.uploads', UPLOAD_ID, 'parts', '0.part'),
    leaseEpoch: 0,
  }
}

const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ADMIN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const LINK_LINEAGE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const TEAM_1 = '11111111-1111-4111-8111-111111111111'
const TEAM_2 = '22222222-2222-4222-8222-222222222222'

const USER_PRINCIPAL: UploadPrincipal = {
  drive: 'main',
  ownerSubject: USER_ID,
  primarySubject: USER_ID,
  principalType: 'user',
  authGeneration: 3,
}
const ADMIN_PRINCIPAL: UploadPrincipal = {
  drive: 'main',
  ownerSubject: ADMIN_ID,
  primarySubject: ADMIN_ID,
  principalType: 'control-admin',
  authGeneration: 5,
}
const LINKED_PRINCIPAL: UploadPrincipal = {
  drive: 'main',
  ownerSubject: ADMIN_ID,
  primarySubject: ADMIN_ID,
  authGeneration: 5,
  brokeredAuthority: {
    desktopUserId: USER_ID,
    controlAdminId: ADMIN_ID,
    authoritySource: 'linked-admin',
    linkLineageId: LINK_LINEAGE,
    linkGeneration: 7,
    desktopUserGeneration: 3,
  },
}

/** Subject-table rows one side (pool or transaction client) answers with. */
interface SubjectRows {
  /** `null` answers no users row. */
  user?: { lifecycle_state: string; lifecycle_version: number } | null
  teams?: string[]
  /** `null` answers no control_admin_users row. */
  admin?: { status: string; session_version: number } | null
  /** `null` answers no active operator link. */
  link?: { lineage_id: string; generation: number } | null
}

const DEFAULT_ROWS: Required<SubjectRows> = {
  user: { lifecycle_state: 'active', lifecycle_version: 3 },
  teams: [],
  admin: { status: 'active', session_version: 5 },
  link: { lineage_id: LINK_LINEAGE, generation: 7 },
}

function answer(sql: string, rows: SubjectRows): { rows: Record<string, unknown>[] } | undefined {
  const merged = { ...DEFAULT_ROWS, ...rows }
  if (sql.includes('FROM users')) {
    return { rows: merged.user ? [{ id: USER_ID, ...merged.user }] : [] }
  }
  if (sql.includes('FROM team_members')) {
    return { rows: merged.teams.map(team_id => ({ team_id })) }
  }
  if (sql.includes('FROM control_admin_users')) {
    return { rows: merged.admin ? [{ id: ADMIN_ID, ...merged.admin }] : [] }
  }
  if (sql.includes('FROM gfs_desktop_operator_links')) {
    return { rows: merged.link ? [merged.link] : [] }
  }
  return undefined
}

interface HarnessOptions {
  /** Runs between beforePublication and the publication transaction. */
  betweenHooks?: () => void
  /** A writer check that rejects inside the transaction before onPublished. */
  writerRejection?: Error
  /** The writer opens the transaction without calling beforePublication. */
  skipBeforePublication?: boolean
  /** Aborted after the stream is drained and before the hook runs. */
  abortBeforeHook?: AbortController
  /** Subject rows read on the pool before BEGIN. */
  pool?: SubjectRows
  /** Subject rows read on the transaction client. */
  client?: SubjectRows
  /** Runs when the transaction client receives a query, before it answers. */
  onClientQuery?: (sql: string) => void
  /** Result of the pre-BEGIN decision. */
  allowed?: boolean
  /** Result of every in-transaction re-decision. */
  withinAllowed?: boolean
}

function finalizerHarness(
  root: string,
  permissionEpoch: () => { generation: number; bypassed: boolean },
  options: HarnessOptions = {}
) {
  // Mirrors GfsWriteService: beforePublication runs with no client held, then
  // the publication transaction opens and onPublished runs on its client.
  const state = { inTransaction: false }
  const events: string[] = []
  const clientSql: string[] = []
  const where = () => (state.inTransaction ? 'in-tx' : 'no-tx')
  const permissions = {
    permissionEpoch,
    authorize: vi.fn(async () => {
      events.push(`authorize:${where()}`)
      return { allowed: options.allowed ?? true }
    }),
    authorizeWithin: vi.fn(async (_db: unknown, _ctx: unknown, requests: readonly unknown[]) => {
      events.push(`authorizeWithin:${where()}`)
      return requests.map(() => ({ allowed: options.withinAllowed ?? true }))
    }),
  } as unknown as PermissionClient & {
    authorize: ReturnType<typeof vi.fn>
    authorizeWithin: ReturnType<typeof vi.fn>
  }
  const client = {
    query: vi.fn(async (sql: string) => {
      events.push(`client:${where()}`)
      clientSql.push(sql)
      options.onClientQuery?.(sql)
      return answer(sql, options.client ?? {}) ?? { rows: [{ upload_id: UPLOAD_ID }] }
    }),
  }
  const resource = {
    resourceId: UPLOAD_ID,
    rid: UPLOAD_ID.replaceAll('-', ''),
    drive: 'main',
    parentResourceId: PARENT_ID,
    name: 'payload.bin',
    kind: 'file',
    bytes: BODY.length,
    version: 0,
    blobKey: 'generation/payload',
    contentSha256: SHA256,
    deletedAt: null,
    path: '/payload.bin',
    updatedAt: new Date().toISOString(),
  }
  const mirror = (published: typeof resource) =>
    vi.fn(async (input: any) => {
      const chunks: Buffer[] = []
      for await (const chunk of input.content.stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(BODY)
      options.abortBeforeHook?.abort(new Error('client went away'))
      if (!options.skipBeforePublication) {
        events.push('beforePublication')
        await input.beforePublication?.(input.signal)
      }
      options.betweenHooks?.()
      state.inTransaction = true
      events.push('transaction:begin')
      try {
        if (options.writerRejection) throw options.writerRejection
        await input.onPublished(client, published, input.signal)
      } finally {
        state.inTransaction = false
      }
      return published
    })
  const writeService = {
    create: mirror(resource),
    replace: mirror({ ...resource, resourceId: RESOURCE_ID, version: 1 }),
  }
  const pool = {
    query: vi.fn(async (sql: string) => {
      events.push(`pool:${where()}`)
      return answer(sql, options.pool ?? {}) ?? { rows: [] }
    }),
  }
  const finalizer = createGfsUploadFinalizer({
    pool: pool as never,
    storageMountPath: root,
    permissions,
    writeService: writeService as never,
    audit: {} as DbAuditSink,
  })
  const inTx = () => events.slice(events.indexOf('transaction:begin'))
  const receiptRan = () => clientSql.some(sql => sql.includes("SET state = 'completed'"))
  const clientRead = (table: string) => clientSql.some(sql => sql.includes(`FROM ${table}`))
  return {
    finalizer,
    permissions,
    client,
    clientSql,
    writeService,
    pool,
    events,
    inTx,
    receiptRan,
    clientRead,
  }
}

type Harness = ReturnType<typeof finalizerHarness>

/** D3 witness: the transaction never reached the pool or the pool-bound decision. */
function expectNothingOnThePoolInTx(harness: Harness): void {
  expect(harness.events).not.toContain('pool:in-tx')
  expect(harness.events).not.toContain('authorize:in-tx')
}

const STABLE = () => ({ generation: 1, bypassed: false })

afterEach(() => {
  vi.restoreAllMocks()
})

async function withStagedPart<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try {
    await mkdir(join(root, '.uploads', UPLOAD_ID, 'parts'), { recursive: true })
    await writeFile(join(root, '.uploads', UPLOAD_ID, 'parts', '0.part'), BODY)
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('production GFS upload finalizer seam', () => {
  it('streams committed parts and marks the session completed in the publication transaction', async () => {
    await withStagedPart('gfs-upload-finalizer-', async root => {
      const harness = finalizerHarness(root, STABLE)

      await expect(harness.finalizer(session(), [part(root)])).resolves.toEqual({
        resourceId: UPLOAD_ID,
        version: 0,
        sha256: SHA256,
      })
      expect(harness.client.query).toHaveBeenCalledWith(
        expect.stringContaining("SET state = 'completed'"),
        expect.arrayContaining([UPLOAD_ID, UPLOAD_ID, 0, SHA256, 0])
      )
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('rejects an explicit authorization denial before publication', async () => {
    await withStagedPart('gfs-upload-finalizer-denied-', async root => {
      const harness = finalizerHarness(root, STABLE, { allowed: false })

      await expect(harness.finalizer(session(), [part(root)])).rejects.toMatchObject({
        code: 'forbidden',
        message: 'upload authorization was revoked before publication',
      })
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('transaction:begin')
      expect(harness.permissions.authorizeWithin).not.toHaveBeenCalled()
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })

  it('re-authorizes before the publication transaction, checks out no pool client inside it and re-reads the subject on the transaction client', async () => {
    await withStagedPart('gfs-upload-finalizer-no-nested-', async root => {
      const harness = finalizerHarness(root, STABLE)

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).resolves.toEqual({ resourceId: UPLOAD_ID, version: 0, sha256: SHA256 })

      // Liveness: the subject reads and the decision really ran on the pool.
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.permissions.authorize).toHaveBeenCalledWith(
        expect.objectContaining({ subjects: [`user:${USER_ID}`] }),
        PARENT_ID,
        'write'
      )
      expect(harness.pool.query.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(harness.events.filter(event => event === 'pool:no-tx').length).toBe(
        harness.pool.query.mock.calls.length
      )
      // Inside the transaction the subject is re-read (users, team_members) and
      // the receipt is updated, all on the transaction's own client.
      expect(harness.inTx()).toEqual([
        'transaction:begin',
        'client:in-tx',
        'client:in-tx',
        'client:in-tx',
      ])
      expect(harness.clientSql[0]).toContain('FROM users')
      expect(harness.clientSql[1]).toContain('FROM team_members')
      expect(harness.clientSql[2]).toContain("SET state = 'completed'")
      expect(harness.permissions.authorizeWithin).not.toHaveBeenCalled()
      expectNothingOnThePoolInTx(harness)
    })
  })

  it("keeps the writer's own rejection ahead of a stored denial", async () => {
    await withStagedPart('gfs-upload-finalizer-writer-first-', async root => {
      const writerRejection = new GfsError('not_found', `parent not found: ${PARENT_ID}`)
      const harness = finalizerHarness(root, STABLE, { writerRejection, allowed: false })

      await expect(harness.finalizer(session(), [part(root)])).rejects.toBe(writerRejection)
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('transaction:begin')
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })

  it('rethrows a re-authorization error unchanged inside the publication transaction', async () => {
    await withStagedPart('gfs-upload-finalizer-store-error-', async root => {
      const storeError = new GfsError('not_mounted', 'permission store unavailable: test')
      const harness = finalizerHarness(root, STABLE)
      harness.permissions.authorize.mockRejectedValue(storeError)

      await expect(harness.finalizer(session(), [part(root)])).rejects.toBe(storeError)
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('transaction:begin')
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })
})

describe('upload finalizer: subject re-check on the transaction client', () => {
  it('T-M1a: rejects a user retired during the lock wait with the subject denial', async () => {
    await withStagedPart('gfs-upload-finalizer-m1a-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        client: { user: { lifecycle_state: 'retired', lifecycle_version: 3 } },
      })

      const result = harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      await expect(result).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
      await expect(result).rejects.toThrow('user is retired or token generation is stale')
      expect(harness.events.filter(event => event === 'authorize:no-tx')).toHaveLength(1)
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-M1c: publishes when a team was only gained during the wait, with no re-decision', async () => {
    await withStagedPart('gfs-upload-finalizer-m1c-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        pool: { teams: [TEAM_1] },
        client: { teams: [TEAM_1, TEAM_2] },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).resolves.toMatchObject({ resourceId: UPLOAD_ID })
      expect(harness.clientRead('team_members')).toBe(true)
      expect(harness.receiptRan()).toBe(true)
      expect(harness.permissions.authorizeWithin).not.toHaveBeenCalled()
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-M1d: rejects a user whose generation moved during the wait', async () => {
    await withStagedPart('gfs-upload-finalizer-m1d-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        client: { user: { lifecycle_state: 'active', lifecycle_version: 4 } },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-M1e: rejects a control admin deactivated during the wait', async () => {
    await withStagedPart('gfs-upload-finalizer-m1e-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        client: { admin: { status: 'disabled', session_version: 5 } },
      })

      const result = harness.finalizer(session(), [part(root)], undefined, undefined, ADMIN_PRINCIPAL)
      await expect(result).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
      await expect(result).rejects.toThrow('control admin is not active')
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.clientRead('control_admin_users')).toBe(true)
      expect(harness.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-M1f: rejects a linked admin whose operator link was revoked during the wait', async () => {
    await withStagedPart('gfs-upload-finalizer-m1f-', async root => {
      const harness = finalizerHarness(root, STABLE, { client: { link: null } })

      const result = harness.finalizer(session(), [part(root)], undefined, undefined, LINKED_PRINCIPAL)
      await expect(result).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
      await expect(result).rejects.toThrow('linked Desktop operator generation is not active')
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.clientRead('gfs_desktop_operator_links')).toBe(true)
      expect(harness.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-M1g: a host session makes no subject query inside the transaction', async () => {
    await withStagedPart('gfs-upload-finalizer-m1g-', async root => {
      const harness = finalizerHarness(root, STABLE)

      await expect(harness.finalizer(session(), [part(root)])).resolves.toMatchObject({
        resourceId: UPLOAD_ID,
      })
      expect(harness.inTx()).toEqual(['transaction:begin', 'client:in-tx'])
      expect(harness.receiptRan()).toBe(true)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-M1h: replace rejects a user retired during the row-lock wait', async () => {
    await withStagedPart('gfs-upload-finalizer-m1h-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        client: { user: { lifecycle_state: 'retired', lifecycle_version: 3 } },
      })

      await expect(
        harness.finalizer(replaceSession(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
      expect(harness.permissions.authorize).toHaveBeenCalledWith(
        expect.anything(),
        RESOURCE_ID,
        'write'
      )
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-Q2a: publishes when a lost team leaves overlapping authority, re-deciding on the client', async () => {
    await withStagedPart('gfs-upload-finalizer-q2a-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        pool: { teams: [TEAM_1] },
        client: { teams: [] },
        withinAllowed: true,
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).resolves.toMatchObject({ resourceId: UPLOAD_ID })
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledTimes(1)
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledWith(
        harness.client,
        expect.objectContaining({ subjects: [`user:${USER_ID}`] }),
        [{ resourceId: PARENT_ID, op: 'write' }]
      )
      expect(harness.events).toContain('authorizeWithin:in-tx')
      expect(harness.receiptRan()).toBe(true)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-Q2b: rejects when a lost team leaves no authority', async () => {
    await withStagedPart('gfs-upload-finalizer-q2b-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        pool: { teams: [TEAM_1] },
        client: { teams: [] },
        withinAllowed: false,
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toMatchObject({
        code: 'forbidden',
        message: 'upload authorization was revoked before publication',
      })
      expect(harness.events).toContain('authorizeWithin:in-tx')
      expect(harness.clientRead('team_members')).toBe(true)
      expect(harness.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-Q2e: replace re-decides a lost team on the client: allow publishes, deny rejects', async () => {
    await withStagedPart('gfs-upload-finalizer-q2e-', async root => {
      const allow = finalizerHarness(root, STABLE, {
        pool: { teams: [TEAM_1] },
        client: { teams: [] },
        withinAllowed: true,
      })
      await expect(
        allow.finalizer(replaceSession(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).resolves.toMatchObject({ resourceId: RESOURCE_ID, version: 1 })
      expect(allow.permissions.authorizeWithin).toHaveBeenCalledWith(
        allow.client,
        expect.objectContaining({ subjects: [`user:${USER_ID}`] }),
        [{ resourceId: RESOURCE_ID, op: 'write' }]
      )
      expectNothingOnThePoolInTx(allow)

      const deny = finalizerHarness(root, STABLE, {
        pool: { teams: [TEAM_1] },
        client: { teams: [] },
        withinAllowed: false,
      })
      await expect(
        deny.finalizer(replaceSession(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(deny.events).toContain('authorizeWithin:in-tx')
      expect(deny.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(deny)
    })
  })
})

describe('upload finalizer: check order inside the transaction', () => {
  it('T-ord2: a subject denied in the transaction wins over a stored authorize error', async () => {
    await withStagedPart('gfs-upload-finalizer-ord2-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        client: { user: { lifecycle_state: 'retired', lifecycle_version: 3 } },
      })
      harness.permissions.authorize.mockRejectedValue(
        new GfsError('not_mounted', 'permission store unavailable: test')
      )

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.clientRead('users')).toBe(true)
    })
  })

  it('T-ord3: a subject denied in the transaction wins over a stored denial', async () => {
    await withStagedPart('gfs-upload-finalizer-ord3-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        allowed: false,
        client: { user: { lifecycle_state: 'retired', lifecycle_version: 3 } },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.clientRead('users')).toBe(true)
    })
  })

  it("T-ord4: the writer's rejection wins and no subject is read in the transaction", async () => {
    await withStagedPart('gfs-upload-finalizer-ord4-', async root => {
      const writerRejection = new GfsError('already_exists', 'a resource named payload.bin already exists here')
      const harness = finalizerHarness(root, STABLE, {
        writerRejection,
        client: { user: { lifecycle_state: 'retired', lifecycle_version: 3 } },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toBe(writerRejection)
      expect(harness.events).toContain('transaction:begin')
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })
})

describe('upload finalizer: replace operations', () => {
  it('T-M2a: a replace re-authorizes the resource and publishes on the transaction client', async () => {
    await withStagedPart('gfs-upload-finalizer-m2a-', async root => {
      const harness = finalizerHarness(root, STABLE)

      await expect(
        harness.finalizer(replaceSession(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).resolves.toEqual({ resourceId: RESOURCE_ID, version: 1, sha256: SHA256 })
      expect(harness.writeService.create).not.toHaveBeenCalled()
      expect(harness.writeService.replace).toHaveBeenCalledTimes(1)
      expect(harness.writeService.replace).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: RESOURCE_ID,
          ifMatch: 0,
          beforePublication: expect.any(Function),
          onPublished: expect.any(Function),
        })
      )
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.permissions.authorize).toHaveBeenCalledWith(
        expect.objectContaining({ subjects: [`user:${USER_ID}`] }),
        RESOURCE_ID,
        'write'
      )
      expect(harness.events).toContain('authorize:no-tx')
      expect(harness.client.query).toHaveBeenCalledWith(
        expect.stringContaining("SET state = 'completed'"),
        expect.arrayContaining([UPLOAD_ID, RESOURCE_ID, 1, SHA256, 0])
      )
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.clientRead('team_members')).toBe(true)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-M2b: a denied replace is rejected and never marks completion', async () => {
    await withStagedPart('gfs-upload-finalizer-m2b-', async root => {
      const harness = finalizerHarness(root, STABLE, { allowed: false })

      await expect(
        harness.finalizer(replaceSession(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toMatchObject({
        code: 'forbidden',
        message: 'upload authorization was revoked before publication',
      })
      expect(harness.events).toContain('transaction:begin')
      expect(harness.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-M2c: a replace re-decides the resource on the client when the epoch moved between hooks', async () => {
    await withStagedPart('gfs-upload-finalizer-m2c-', async root => {
      let generation = 1
      const harness = finalizerHarness(root, () => ({ generation, bypassed: false }), {
        betweenHooks: () => {
          generation = 2
        },
      })

      await expect(
        harness.finalizer(replaceSession(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).resolves.toMatchObject({ resourceId: RESOURCE_ID, version: 1 })
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledWith(
        harness.client,
        expect.anything(),
        [{ resourceId: RESOURCE_ID, op: 'write' }]
      )
      expectNothingOnThePoolInTx(harness)
    })
  })
})

describe('upload finalizer: the hook skips re-authorization on abort or deadline', () => {
  it('T-L1a: an abort before the hook skips the re-authorization', async () => {
    await withStagedPart('gfs-upload-finalizer-l1a-', async root => {
      const controller = new AbortController()
      const harness = finalizerHarness(root, STABLE, { abortBeforeHook: controller })

      await expect(
        harness.finalizer(session(), [part(root)], controller.signal, undefined, USER_PRINCIPAL)
      ).rejects.toThrow('client went away')
      expect(harness.events).toContain('beforePublication')
      expect(harness.events).toContain('transaction:begin')
      expect(harness.permissions.authorize).not.toHaveBeenCalled()
      expect(harness.pool.query).not.toHaveBeenCalled()
      // Abort and deadline are checked first inside the transaction: no subject read.
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })

  it('T-L1b: an expired deadline before the hook skips the re-authorization', async () => {
    await withStagedPart('gfs-upload-finalizer-l1b-', async root => {
      const harness = finalizerHarness(root, STABLE)

      await expect(
        harness.finalizer(session(), [part(root)], undefined, Date.now() - 1, USER_PRINCIPAL)
      ).rejects.toMatchObject({
        code: 'precondition_failed',
        message: 'upload finalization timed out',
      })
      expect(harness.events).toContain('beforePublication')
      expect(harness.events).toContain('transaction:begin')
      expect(harness.permissions.authorize).not.toHaveBeenCalled()
      expect(harness.pool.query).not.toHaveBeenCalled()
      // Abort and deadline are checked first inside the transaction: no subject read.
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })
})

describe('upload finalizer: missing re-authorization outcome', () => {
  for (const [label, build] of [
    ['create', () => session()],
    ['replace', () => replaceSession()],
  ] as const) {
    it(`T-L2 (${label}): a writer that never ran the hook fails before any subject read`, async () => {
      await withStagedPart(`gfs-upload-finalizer-l2-${label}-`, async root => {
        const harness = finalizerHarness(root, STABLE, { skipBeforePublication: true })

        await expect(
          harness.finalizer(build(), [part(root)], undefined, undefined, USER_PRINCIPAL)
        ).rejects.toMatchObject({
          code: 'internal',
          message: 'upload was not re-authorized before publication',
        })
        expect(harness.events).toContain('transaction:begin')
        expect(harness.events).not.toContain('beforePublication')
        expect(harness.permissions.authorize).not.toHaveBeenCalled()
        expect(harness.client.query).not.toHaveBeenCalled()
        expect(harness.receiptRan()).toBe(false)
      })
    })
  }
})

describe('upload finalizer: abort and deadline after the in-transaction reads', () => {
  it('T-L3b: an abort during the subject reads rejects before the receipt update', async () => {
    await withStagedPart('gfs-upload-finalizer-l3b-', async root => {
      const controller = new AbortController()
      const harness = finalizerHarness(root, STABLE, {
        onClientQuery: sql => {
          if (sql.includes('FROM users')) controller.abort(new Error('aborted during subject read'))
        },
      })

      await expect(
        harness.finalizer(session(), [part(root)], controller.signal, undefined, USER_PRINCIPAL)
      ).rejects.toThrow('aborted during subject read')
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.receiptRan()).toBe(false)
    })
  })

  it('T-L3c: a deadline passed during the subject reads rejects before the receipt update', async () => {
    await withStagedPart('gfs-upload-finalizer-l3c-', async root => {
      const deadlineAtMs = Date.now() + 60_000
      const harness = finalizerHarness(root, STABLE, {
        onClientQuery: sql => {
          if (sql.includes('FROM users')) vi.spyOn(Date, 'now').mockReturnValue(deadlineAtMs + 1)
        },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, deadlineAtMs, USER_PRINCIPAL)
      ).rejects.toMatchObject({
        code: 'precondition_failed',
        message: 'upload finalization timed out',
      })
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.receiptRan()).toBe(false)
    })
  })
})

describe('upload finalizer: permission epoch and stored denials re-decide on the client', () => {
  it('T-O2a: an epoch move between hooks re-decides on the client and publishes on allow', async () => {
    await withStagedPart('gfs-upload-finalizer-o2a-', async root => {
      let generation = 1
      const harness = finalizerHarness(root, () => ({ generation, bypassed: false }), {
        betweenHooks: () => {
          generation = 2
        },
      })

      await expect(harness.finalizer(session(), [part(root)])).resolves.toMatchObject({
        resourceId: UPLOAD_ID,
      })
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledTimes(1)
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledWith(
        harness.client,
        expect.objectContaining({ subjects: [FINALIZER_SUBJECT] }),
        [{ resourceId: PARENT_ID, op: 'write' }]
      )
      expect(harness.events).toContain('authorizeWithin:in-tx')
      expect(harness.receiptRan()).toBe(true)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-O2a (epoch moved during the decision): re-decides on the client', async () => {
    await withStagedPart('gfs-upload-finalizer-o2a2-', async root => {
      let generation = 1
      const harness = finalizerHarness(root, () => ({ generation, bypassed: false }))
      harness.permissions.authorize.mockImplementation(async () => {
        generation = 2
        return { allowed: true }
      })

      await expect(harness.finalizer(session(), [part(root)])).resolves.toMatchObject({
        resourceId: UPLOAD_ID,
      })
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledTimes(1)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-O2b: an epoch move between hooks rejects when the re-decision denies', async () => {
    await withStagedPart('gfs-upload-finalizer-o2b-', async root => {
      let generation = 1
      const harness = finalizerHarness(root, () => ({ generation, bypassed: false }), {
        betweenHooks: () => {
          generation = 2
        },
        withinAllowed: false,
      })

      await expect(harness.finalizer(session(), [part(root)])).rejects.toMatchObject({
        code: 'forbidden',
        message: 'upload authorization was revoked before publication',
      })
      expect(harness.events).toContain('authorizeWithin:in-tx')
      expect(harness.receiptRan()).toBe(false)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-O2c / T-L1c′: a bypassed epoch still re-authorizes on the pool and re-decides on the client', async () => {
    await withStagedPart('gfs-upload-finalizer-o2c-', async root => {
      const harness = finalizerHarness(root, () => ({ generation: 0, bypassed: true }))

      await expect(harness.finalizer(session(), [part(root)])).resolves.toMatchObject({
        resourceId: UPLOAD_ID,
      })
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('authorize:no-tx')
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('authorizeWithin:in-tx')
      expect(harness.receiptRan()).toBe(true)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-O2d: a stored denial is re-decided when a team was gained, and publishes on allow', async () => {
    await withStagedPart('gfs-upload-finalizer-o2d-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        allowed: false,
        pool: { teams: [TEAM_1] },
        client: { teams: [TEAM_1, TEAM_2] },
        withinAllowed: true,
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).resolves.toMatchObject({ resourceId: UPLOAD_ID })
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledTimes(1)
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledWith(
        harness.client,
        expect.objectContaining({ subjects: expect.arrayContaining([`team:${TEAM_2}`]) }),
        [{ resourceId: PARENT_ID, op: 'write' }]
      )
      expect(harness.receiptRan()).toBe(true)
      expectNothingOnThePoolInTx(harness)
    })
  })

  it('T-O2e: a stored denial is final when nothing changed', async () => {
    await withStagedPart('gfs-upload-finalizer-o2e-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        allowed: false,
        pool: { teams: [TEAM_1] },
        client: { teams: [TEAM_1] },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.clientRead('team_members')).toBe(true)
      expect(harness.permissions.authorizeWithin).not.toHaveBeenCalled()
      expect(harness.receiptRan()).toBe(false)
    })
  })

  it('T-O2f: a stored denial is final when subjects were only lost', async () => {
    await withStagedPart('gfs-upload-finalizer-o2f-', async root => {
      const harness = finalizerHarness(root, STABLE, {
        allowed: false,
        pool: { teams: [TEAM_1] },
        client: { teams: [] },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.clientRead('team_members')).toBe(true)
      expect(harness.permissions.authorizeWithin).not.toHaveBeenCalled()
      expect(harness.receiptRan()).toBe(false)
    })
  })

  it('T-O2g: a subject denied in the transaction wins over a moved epoch', async () => {
    await withStagedPart('gfs-upload-finalizer-o2g-', async root => {
      let generation = 1
      const harness = finalizerHarness(root, () => ({ generation, bypassed: false }), {
        betweenHooks: () => {
          generation = 2
        },
        client: { user: { lifecycle_state: 'retired', lifecycle_version: 3 } },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
      expect(harness.clientRead('users')).toBe(true)
      expect(harness.permissions.authorizeWithin).not.toHaveBeenCalled()
      expect(harness.receiptRan()).toBe(false)
    })
  })

  it('T-O2h: the epoch is read after the subject reads', async () => {
    await withStagedPart('gfs-upload-finalizer-o2h-', async root => {
      let generation = 1
      const harness = finalizerHarness(root, () => ({ generation, bypassed: false }), {
        onClientQuery: sql => {
          if (sql.includes('FROM team_members')) generation = 2
        },
      })

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, USER_PRINCIPAL)
      ).resolves.toMatchObject({ resourceId: UPLOAD_ID })
      expect(harness.clientRead('team_members')).toBe(true)
      expect(harness.permissions.authorizeWithin).toHaveBeenCalledTimes(1)
      expectNothingOnThePoolInTx(harness)
    })
  })
})
