import { describe, expect, it, vi } from 'vitest'
import { GfsError } from '../api/errors'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbAuditSink, PermissionClient } from '../authz/permissionClient'
import { createGfsUploadFinalizer } from './uploadFinalizer'
import type { UploadPartRow, UploadSessionRow } from './uploadSession'

const UPLOAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PARENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FINALIZER_SUBJECT = 'host:1st:mcp-host/gfs-finalizer-test'
const BODY = Buffer.from('published upload')
const SHA256 = createHash('sha256').update(BODY).digest('hex')

function session(): UploadSessionRow {
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
  }
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

interface HarnessOptions {
  /** Runs between beforePublication and the publication transaction. */
  betweenHooks?: () => void
  /** A writer check that rejects inside the transaction before onPublished. */
  writerRejection?: Error
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
  const permissions = {
    permissionEpoch,
    authorize: vi.fn(async () => {
      events.push(`authorize:${state.inTransaction ? 'in-tx' : 'no-tx'}`)
      return { allowed: true }
    }),
  } as unknown as PermissionClient
  const client = {
    query: vi.fn(async () => {
      events.push(`client:${state.inTransaction ? 'in-tx' : 'no-tx'}`)
      return { rows: [{}] }
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
  const writeService = {
    create: vi.fn(async (input: any) => {
      const chunks: Buffer[] = []
      for await (const chunk of input.content.stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(BODY)
      await input.beforePublication?.(input.signal)
      options.betweenHooks?.()
      state.inTransaction = true
      events.push('transaction:begin')
      try {
        if (options.writerRejection) throw options.writerRejection
        await input.onPublished(client, resource, input.signal)
      } finally {
        state.inTransaction = false
      }
      return resource
    }),
    replace: vi.fn(),
  }
  const pool = {
    query: vi.fn(async (sql: string) => {
      events.push(`pool:${state.inTransaction ? 'in-tx' : 'no-tx'}`)
      if (sql.includes('FROM users')) {
        return { rows: [{ id: USER_ID, lifecycle_state: 'active', lifecycle_version: 3 }] }
      }
      return { rows: [] }
    }),
  }
  const finalizer = createGfsUploadFinalizer({
    pool: pool as never,
    storageMountPath: root,
    permissions,
    writeService: writeService as never,
    audit: {} as DbAuditSink,
  })
  return { finalizer, permissions, client, writeService, pool, events }
}

describe('production GFS upload finalizer seam', () => {
  it('streams committed parts and marks the session completed in the publication transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gfs-upload-finalizer-'))
    try {
      const partPath = join(root, '.uploads', UPLOAD_ID, 'parts', '0.part')
      await mkdir(join(root, '.uploads', UPLOAD_ID, 'parts'), { recursive: true })
      await writeFile(partPath, BODY)
      const harness = finalizerHarness(root, () => ({ generation: 1, bypassed: false }))

      await expect(harness.finalizer(session(), [part(root)])).resolves.toEqual({
        resourceId: UPLOAD_ID,
        version: 0,
        sha256: SHA256,
      })
      expect(harness.client.query).toHaveBeenCalledWith(
        expect.stringContaining("SET state = 'completed'"),
        expect.arrayContaining([UPLOAD_ID, UPLOAD_ID, 0, SHA256, 0])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a permission-epoch change before publication and never marks completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gfs-upload-finalizer-revoked-'))
    try {
      const partPath = join(root, '.uploads', UPLOAD_ID, 'parts', '0.part')
      await mkdir(join(root, '.uploads', UPLOAD_ID, 'parts'), { recursive: true })
      await writeFile(partPath, BODY)
      let generation = 1
      const harness = finalizerHarness(root, () => {
        return { generation, bypassed: false }
      })
      harness.permissions.authorize = vi.fn().mockImplementation(async () => {
        generation = 2
        return { allowed: true }
      }) as never

      await expect(harness.finalizer(session(), [part(root)])).rejects.toMatchObject({
        code: 'precondition_failed',
        message: 'authorization changed during upload finalization',
      })
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.client.query).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an explicit authorization denial before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gfs-upload-finalizer-denied-'))
    try {
      const partPath = join(root, '.uploads', UPLOAD_ID, 'parts', '0.part')
      await mkdir(join(root, '.uploads', UPLOAD_ID, 'parts'), { recursive: true })
      await writeFile(partPath, BODY)
      const harness = finalizerHarness(root, () => ({ generation: 1, bypassed: false }))
      harness.permissions.authorize = vi.fn().mockResolvedValue({ allowed: false }) as never

      await expect(harness.finalizer(session(), [part(root)])).rejects.toMatchObject({
        code: 'forbidden',
      })
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('transaction:begin')
      expect(harness.client.query).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  it('re-authorizes before the publication transaction and checks out no pool client inside it', async () => {
    await withStagedPart('gfs-upload-finalizer-no-nested-', async root => {
      const harness = finalizerHarness(root, () => ({ generation: 1, bypassed: false }))

      await expect(
        harness.finalizer(session(), [part(root)], undefined, undefined, {
          drive: 'main',
          ownerSubject: USER_ID,
          primarySubject: USER_ID,
          principalType: 'user',
          authGeneration: 3,
        })
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
      // Inside the transaction only the receipt update runs, on its own client.
      expect(harness.events.slice(harness.events.indexOf('transaction:begin'))).toEqual([
        'transaction:begin',
        'client:in-tx',
      ])
      expect(harness.events).not.toContain('pool:in-tx')
      expect(harness.events).not.toContain('authorize:in-tx')
    })
  })

  it('rejects a permission-epoch change between re-authorization and publication', async () => {
    await withStagedPart('gfs-upload-finalizer-toctou-', async root => {
      let generation = 1
      const harness = finalizerHarness(root, () => ({ generation, bypassed: false }), {
        betweenHooks: () => {
          generation = 2
        },
      })

      await expect(harness.finalizer(session(), [part(root)])).rejects.toMatchObject({
        code: 'precondition_failed',
        message: 'authorization changed during upload finalization',
      })
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('transaction:begin')
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })

  it("keeps the writer's own rejection ahead of a stored denial", async () => {
    await withStagedPart('gfs-upload-finalizer-writer-first-', async root => {
      const writerRejection = new GfsError('not_found', `parent not found: ${PARENT_ID}`)
      const harness = finalizerHarness(root, () => ({ generation: 1, bypassed: false }), {
        writerRejection,
      })
      harness.permissions.authorize = vi.fn().mockResolvedValue({ allowed: false }) as never

      await expect(harness.finalizer(session(), [part(root)])).rejects.toBe(writerRejection)
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('transaction:begin')
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })

  it('rethrows a re-authorization error unchanged inside the publication transaction', async () => {
    await withStagedPart('gfs-upload-finalizer-store-error-', async root => {
      const storeError = new GfsError('not_mounted', 'permission store unavailable: test')
      const harness = finalizerHarness(root, () => ({ generation: 1, bypassed: false }))
      harness.permissions.authorize = vi.fn().mockRejectedValue(storeError) as never

      await expect(harness.finalizer(session(), [part(root)])).rejects.toBe(storeError)
      expect(harness.permissions.authorize).toHaveBeenCalledTimes(1)
      expect(harness.events).toContain('transaction:begin')
      expect(harness.client.query).not.toHaveBeenCalled()
    })
  })
})
