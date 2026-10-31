import { describe, expect, it, vi } from 'vitest'
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

function finalizerHarness(
  root: string,
  permissionEpoch: () => { generation: number; bypassed: boolean }
) {
  const permissions = {
    permissionEpoch,
    authorize: vi.fn().mockResolvedValue({ allowed: true }),
  } as unknown as PermissionClient
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [{}] }),
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
      await input.onPublished(client, resource)
      return resource
    }),
    replace: vi.fn(),
  }
  const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
  const finalizer = createGfsUploadFinalizer({
    pool: pool as never,
    storageMountPath: root,
    permissions,
    writeService: writeService as never,
    audit: {} as DbAuditSink,
  })
  return { finalizer, permissions, client, writeService }
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
      expect(harness.client.query).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('upload finalization records the Desktop user activity', () => {
  const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  async function userHarness() {
    const root = await mkdtemp(join(tmpdir(), 'gfs-upload-finalizer-user-'))
    await mkdir(join(root, '.uploads', UPLOAD_ID, 'parts'), { recursive: true })
    await writeFile(join(root, '.uploads', UPLOAD_ID, 'parts', '0.part'), BODY)
    const calls: Array<{ sql: string; values: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values })
        return { rows: [{}] }
      }),
    }
    const resource = {
      resourceId: UPLOAD_ID,
      rid: UPLOAD_ID.replaceAll('-', ''),
      drive: 'main',
      parentResourceId: PARENT_ID,
      name: 'payload.bin',
      kind: 'file' as const,
      bytes: BODY.length,
      version: 0,
      blobKey: 'generation/payload',
      contentSha256: SHA256,
      deletedAt: null,
      path: '/payload.bin',
      updatedAt: new Date().toISOString(),
    }
    const writeService = {
      create: vi.fn(async (input: { onPublished: (c: unknown, r: unknown) => Promise<void> }) => {
        for await (const _chunk of (input as unknown as { content: { stream: AsyncIterable<Buffer> } }).content.stream) {
          /* consume */
        }
        await input.onPublished(client, resource)
        return resource
      }),
      replace: vi.fn(async (input: { onPublished: (c: unknown, r: unknown) => Promise<void> }) => {
        for await (const _chunk of (input as unknown as { content: { stream: AsyncIterable<Buffer> } }).content.stream) {
          /* consume */
        }
        await input.onPublished(client, resource)
        return resource
      }),
    }
    // resolveAuthzContext for a user: an active user row and no teams.
    const pool = {
      query: vi.fn(async (sql: string) =>
        sql.includes('FROM users')
          ? { rows: [{ id: USER_ID, lifecycle_state: 'active', lifecycle_version: 1 }] }
          : { rows: [] }
      ),
    }
    const finalizer = createGfsUploadFinalizer({
      pool: pool as never,
      storageMountPath: root,
      permissions: {
        permissionEpoch: () => ({ generation: 1, bypassed: false }),
        authorize: vi.fn().mockResolvedValue({ allowed: true }),
      } as unknown as PermissionClient,
      writeService: writeService as never,
      audit: {} as DbAuditSink,
    })
    return { root, finalizer, client, calls, writeService }
  }

  function userSession() {
    return {
      ...session(),
      ownerSubject: USER_ID,
      primarySubject: USER_ID,
    }
  }

  it('records the published file for the Desktop user, after the session completion UPDATE', async () => {
    const harness = await userHarness()
    try {
      await harness.finalizer(userSession(), [part(harness.root)], undefined, undefined, {
        drive: 'main',
        ownerSubject: USER_ID,
        primarySubject: USER_ID,
        authGeneration: 1,
      })

      const activity = harness.calls.filter(call =>
        call.sql.includes('gfs_record_user_file_activity')
      )
      expect(activity).toHaveLength(1)
      expect(activity[0]!.values).toEqual([USER_ID, [UPLOAD_ID]])
      // Ordering: the session completion runs first, then the activity row.
      const completed = harness.calls.findIndex(call =>
        call.sql.includes("SET state = 'completed'")
      )
      const recorded = harness.calls.findIndex(call =>
        call.sql.includes('gfs_record_user_file_activity')
      )
      expect(completed).toBeGreaterThanOrEqual(0)
      expect(recorded).toBeGreaterThan(completed)
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  })

  it('records nothing for a Host upload session', async () => {
    const harness = await userHarness()
    try {
      await harness.finalizer(session(), [part(harness.root)])
      expect(
        harness.calls.filter(call => call.sql.includes('gfs_record_user_file_activity'))
      ).toEqual([])
      // Witness: the completion UPDATE ran, so the hook was reached.
      expect(harness.calls.some(call => call.sql.includes("SET state = 'completed'"))).toBe(true)
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  })
})
