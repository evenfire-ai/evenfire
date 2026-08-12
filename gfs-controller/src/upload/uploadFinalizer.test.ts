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
const BODY = Buffer.from('published upload')
const SHA256 = createHash('sha256').update(BODY).digest('hex')

function session(): UploadSessionRow {
  return {
    uploadId: UPLOAD_ID,
    idempotencyKey: 'finalizer-test',
    drive: 'main',
    ownerSubject: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    primarySubject: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
