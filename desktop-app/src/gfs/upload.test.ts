import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopGfsUploadJob, uploadLocalFile } from './upload.js'

function requestPath(url: string): string {
  return new URL(url).pathname
}

function expectCanonicalDrive(url: string, drive: string): void {
  expect(new URL(url).searchParams.get('drive')).toBe(drive)
}

describe('desktop GFS indexed uploader', () => {
  it('streams independent binary parts with base64 checksums and completes the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-upload-'))
    try {
      const filePath = join(root, 'payload.bin')
      const bytes = Buffer.concat([Buffer.alloc(1024 * 1024, 0x11), Buffer.alloc(512 * 1024, 0x22)])
      await writeFile(filePath, bytes)
      const partRequests: Array<{ headers: Record<string, string>; body: Buffer }> = []
      const transport = {
        async requestJson<T>(method: 'GET' | 'POST' | 'DELETE'): Promise<T> {
          if (method === 'GET') {
            return {
              ok: true,
              data: { upload: { resumableV2: { enabled: true, maxFileBytes: 200 * 1024 * 1024 } } },
            } as T
          }
          if (method === 'POST') {
            return {
              ok: true,
              data: {
                uploadId: '11111111-1111-4111-8111-111111111111',
                drive: 'main',
                operation: 'create',
                expectedBytes: bytes.length,
                partBytes: 1024 * 1024,
                partCount: 2,
                state: 'initiated',
                contiguousBytes: 0,
                committedBytes: 0,
                committedPartCount: 0,
                activePartCount: 0,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                resultResourceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                resultVersion: 1,
              },
            } as T
          }
          throw new Error(`unexpected ${method}`)
        },
        async requestPart(
          _url: string,
          _token: string,
          headers: Record<string, string>,
          body: NodeJS.ReadableStream
        ) {
          const chunks: Buffer[] = []
          for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
          partRequests.push({ headers, body: Buffer.concat(chunks) })
          return { status: 204, text: '' }
        },
      }
      const result = await uploadLocalFile({
        baseUrl: 'https://api.example',
        token: 'token',
        filePath,
        name: 'payload.bin',
        drive: 'main',
        operation: 'create',
        parentRid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        transport,
      })
      expect(result.state).toBe('initiated')
      expect(partRequests).toHaveLength(2)
      for (const request of partRequests) {
        const expected = createHash('sha256').update(request.body).digest('base64')
        expect(request.headers['upload-checksum']).toBe(`sha256 ${expected}`)
        expect(Number(request.headers['upload-chunk-length'])).toBe(request.body.length)
        expect(request.headers['content-type']).toBe('application/offset+octet-stream')
      }
      expect(
        Buffer.concat(partRequests.map(request => request.body).sort((a, b) => a[0]! - b[0]!))
      ).toHaveLength(bytes.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resumes from sparse status and does not replay a committed part', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-upload-resume-'))
    try {
      const filePath = join(root, 'payload.bin')
      const bytes = Buffer.concat([
        Buffer.alloc(1024 * 1024, 0x31),
        Buffer.alloc(1024 * 1024, 0x32),
      ])
      await writeFile(filePath, bytes)
      const committedSha = createHash('sha256')
        .update(bytes.subarray(0, 1024 * 1024))
        .digest('base64')
      const partNumbers: number[] = []
      const session = {
        uploadId: '22222222-2222-4222-8222-222222222222',
        drive: 'main',
        operation: 'create' as const,
        expectedBytes: bytes.length,
        partBytes: 1024 * 1024,
        partCount: 2,
        state: 'uploading',
        contiguousBytes: bytes.length / 2,
        committedBytes: bytes.length / 2,
        committedPartCount: 1,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      const transport = {
        async requestJson<T>(method: 'GET' | 'POST' | 'HEAD' | 'DELETE', url: string): Promise<T> {
          if (method === 'GET' && requestPath(url).endsWith('/capabilities'))
            return { ok: true, data: { upload: { resumableV2: { enabled: true } } } } as T
          if (method === 'HEAD') return {} as T
          if (method === 'GET' && url.includes('/status'))
            return {
              ok: true,
              data: {
                session,
                parts: [
                  {
                    partNumber: 0,
                    offsetBytes: 0,
                    lengthBytes: bytes.length / 2,
                    sha256: committedSha,
                  },
                ],
              },
            } as T
          if (method === 'POST' && requestPath(url).endsWith('/complete'))
            return {
              ok: true,
              data: {
                ...session,
                state: 'completed',
                committedBytes: bytes.length,
                committedPartCount: 2,
                resultResourceId: 'resource-2',
                resultVersion: 2,
              },
            } as T
          throw new Error(`unexpected ${method} ${url}`)
        },
        async requestPart(
          _url: string,
          _token: string,
          headers: Record<string, string>,
          body: NodeJS.ReadableStream
        ) {
          partNumbers.push(Number(headers['upload-part-number']))
          for await (const _chunk of body as AsyncIterable<Buffer>) {
            /* drain */
          }
          return { status: 204, text: '' }
        },
      }
      const result = await new DesktopGfsUploadJob({
        baseUrl: 'https://api.example',
        token: 'token',
        filePath,
        name: 'payload.bin',
        drive: 'main',
        operation: 'create',
        parentRid: 'parent-2',
        resumeUploadId: session.uploadId,
        transport,
      }).start()
      expect(result.state).toBe('completed')
      expect(partNumbers).toEqual([1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a resumed committed part when the local bytes no longer match its server checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-upload-resume-mismatch-'))
    try {
      const filePath = join(root, 'payload.bin')
      const original = Buffer.alloc(1024, 0x31)
      await writeFile(filePath, Buffer.alloc(1024, 0x42))
      const committedSha = createHash('sha256').update(original).digest('base64')
      const session = {
        uploadId: '25252525-2525-4252-8252-252525252525',
        drive: 'main',
        operation: 'create' as const,
        expectedBytes: 1024,
        partBytes: 1024,
        partCount: 1,
        state: 'uploading',
        contiguousBytes: 1024,
        committedBytes: 1024,
        committedPartCount: 1,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      let partRequests = 0
      let completeCalls = 0
      const transport = {
        async requestJson<T>(method: 'GET' | 'POST' | 'HEAD', url: string): Promise<T> {
          if (method === 'GET' && requestPath(url).endsWith('/capabilities'))
            return { ok: true, data: { upload: { resumableV2: { enabled: true } } } } as T
          if (method === 'HEAD') return {} as T
          if (method === 'GET' && url.includes('/status'))
            return {
              ok: true,
              data: {
                session,
                parts: [{ partNumber: 0, offsetBytes: 0, lengthBytes: 1024, sha256: committedSha }],
              },
            } as T
          if (method === 'POST' && requestPath(url).endsWith('/complete')) {
            completeCalls += 1
            return { ok: true, data: { ...session, state: 'completed' } } as T
          }
          throw new Error(`unexpected ${method} ${url}`)
        },
        async requestPart() {
          partRequests += 1
          return { status: 204, text: '' }
        },
      }
      await expect(
        new DesktopGfsUploadJob({
          baseUrl: 'https://api.example',
          token: 'token',
          filePath,
          name: 'payload.bin',
          drive: 'main',
          operation: 'create',
          parentRid: 'parent-mismatch',
          resumeUploadId: session.uploadId,
          transport,
        }).start()
      ).rejects.toThrow(/source_changed: committed part 0/)
      expect(partRequests).toBe(0)
      expect(completeCalls).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reconciles a completed session after a lost complete response without replaying parts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-upload-completed-reconcile-'))
    try {
      const filePath = join(root, 'payload.bin')
      await writeFile(filePath, Buffer.alloc(1024, 0x51))
      const session = {
        uploadId: '26262626-2626-4262-8262-262626262626',
        drive: 'main',
        operation: 'create' as const,
        expectedBytes: 1024,
        partBytes: 1024,
        partCount: 1,
        state: 'completed',
        contiguousBytes: 1024,
        committedBytes: 1024,
        committedPartCount: 1,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        resultResourceId: 'resource-completed',
        resultVersion: 7,
      }
      let partRequests = 0
      let completeCalls = 0
      const transport = {
        async requestJson<T>(method: 'GET' | 'POST' | 'HEAD', url: string): Promise<T> {
          if (method === 'GET' && requestPath(url).endsWith('/capabilities'))
            return { ok: true, data: { upload: { resumableV2: { enabled: true } } } } as T
          if (method === 'HEAD') return {} as T
          if (method === 'GET' && url.includes('/status'))
            return { ok: true, data: { session, parts: [] } } as T
          if (method === 'POST' && requestPath(url).endsWith('/complete')) {
            completeCalls += 1
            return { ok: true, data: session } as T
          }
          throw new Error(`unexpected ${method} ${url}`)
        },
        async requestPart() {
          partRequests += 1
          return { status: 204, text: '' }
        },
      }
      const result = await new DesktopGfsUploadJob({
        baseUrl: 'https://api.example',
        token: 'token',
        filePath,
        name: 'payload.bin',
        drive: 'main',
        operation: 'create',
        parentRid: 'parent-completed',
        resumeUploadId: session.uploadId,
        transport,
      }).start()
      expect(result.state).toBe('completed')
      expect(partRequests).toBe(0)
      expect(completeCalls).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to complete when the source changes between parts and complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-upload-source-'))
    try {
      const filePath = join(root, 'payload.bin')
      await writeFile(filePath, Buffer.alloc(1024, 0x41))
      let completeCalled = false
      const session = {
        uploadId: '33333333-3333-4333-8333-333333333333',
        drive: 'main',
        operation: 'create' as const,
        expectedBytes: 1024,
        partBytes: 1024,
        partCount: 1,
        state: 'initiated',
        contiguousBytes: 0,
        committedBytes: 0,
        committedPartCount: 0,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      const transport = {
        async requestJson<T>(method: 'GET' | 'POST' | 'HEAD' | 'DELETE', url: string): Promise<T> {
          if (method === 'GET')
            return { ok: true, data: { upload: { resumableV2: { enabled: true } } } } as T
          if (method === 'POST' && requestPath(url).endsWith('/uploads'))
            return { ok: true, data: session } as T
          if (method === 'POST' && requestPath(url).endsWith('/complete')) {
            completeCalled = true
            return { ok: true, data: { ...session, state: 'completed' } } as T
          }
          throw new Error(`unexpected ${method} ${url}`)
        },
        async requestPart(
          _url: string,
          _token: string,
          _headers: Record<string, string>,
          body: NodeJS.ReadableStream
        ) {
          for await (const _chunk of body as AsyncIterable<Buffer>) {
            /* drain */
          }
          await writeFile(filePath, Buffer.alloc(1024, 0x42))
          return { status: 204, text: '' }
        },
      }
      await expect(
        new DesktopGfsUploadJob({
          baseUrl: 'https://api.example',
          token: 'token',
          filePath,
          name: 'payload.bin',
          drive: 'main',
          operation: 'create',
          parentRid: 'parent-3',
          transport,
        }).start()
      ).rejects.toThrow(/source_changed/)
      expect(completeCalled).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('latches the four-to-two fallback after three retryable transport failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-upload-fallback-'))
    try {
      const filePath = join(root, 'payload.bin')
      await writeFile(filePath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
      const statuses = [500, 500, 500, 204, 204, 204, 204]
      let partRequests = 0
      let completeCalls = 0
      const session = {
        uploadId: '44444444-4444-4444-8444-444444444444',
        drive: 'main',
        operation: 'create' as const,
        expectedBytes: 8,
        partBytes: 2,
        partCount: 4,
        state: 'initiated',
        contiguousBytes: 0,
        committedBytes: 0,
        committedPartCount: 0,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      const transport = {
        async requestJson<T>(method: 'GET' | 'POST', url: string): Promise<T> {
          if (method === 'GET')
            return {
              ok: true,
              data: {
                upload: {
                  resumableV2: {
                    enabled: true,
                    maxFileBytes: 200 * 1024 * 1024,
                    maxConcurrentPartsPerSession: 4,
                    fallbackConcurrency: 2,
                  },
                },
              },
            } as T
          if (method === 'POST' && requestPath(url).endsWith('/uploads')) {
            completeCalls += 1
            return { ok: true, data: session } as T
          }
          completeCalls += 1
          return {
            ok: true,
            data: { ...session, state: 'completed', committedBytes: 8, committedPartCount: 4 },
          } as T
        },
        async requestPart(
          _url: string,
          _token: string,
          _headers: Record<string, string>,
          body: NodeJS.ReadableStream
        ) {
          partRequests += 1
          for await (const _chunk of body as AsyncIterable<Buffer>) {
            /* drain */
          }
          return { status: statuses.shift() ?? 204, text: '' }
        },
      }
      const result = await new DesktopGfsUploadJob({
        baseUrl: 'https://api.example',
        token: 'token',
        filePath,
        name: 'payload.bin',
        drive: 'main',
        operation: 'create',
        parentRid: 'parent-fallback',
        transport,
      }).start()
      expect(result.state).toBe('completed')
      expect(partRequests).toBe(7)
      expect(completeCalls).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('propagates one non-main canonical drive through every indexed lifecycle request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-upload-drive-'))
    try {
      const filePath = join(root, 'payload.bin')
      const bytes = Buffer.from([0x61, 0x62])
      await writeFile(filePath, bytes)
      const uploadId = '55555555-5555-4555-8555-555555555555'
      const baseSession = {
        uploadId,
        drive: 'archive',
        operation: 'create' as const,
        expectedBytes: bytes.length,
        partBytes: bytes.length,
        partCount: 1,
        state: 'uploading' as const,
        contiguousBytes: 0,
        committedBytes: 0,
        committedPartCount: 0,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      const seen = new Set<string>()
      let statusCompleted = false
      const transport = {
        async requestJson<T>(
          method: 'GET' | 'POST' | 'HEAD' | 'DELETE',
          url: string,
          options?: { body?: unknown }
        ): Promise<T> {
          expectCanonicalDrive(url, 'archive')
          const path = requestPath(url)
          if (path.endsWith('/capabilities')) {
            seen.add('capabilities')
            return { ok: true, data: { upload: { resumableV2: { enabled: true } } } } as T
          }
          if (method === 'POST' && path.endsWith('/uploads')) {
            seen.add('create')
            expect((options?.body as { drive?: unknown }).drive).toBe('archive')
            return { ok: true, data: { ...baseSession, state: 'initiated' } } as T
          }
          if (method === 'HEAD') {
            seen.add('head')
            return {} as T
          }
          if (method === 'GET' && path.endsWith('/status')) {
            seen.add('status')
            const state = statusCompleted ? 'completed' : 'uploading'
            return {
              ok: true,
              data: {
                session: {
                  ...baseSession,
                  state,
                  contiguousBytes: statusCompleted ? bytes.length : 0,
                  committedBytes: statusCompleted ? bytes.length : 0,
                  committedPartCount: statusCompleted ? 1 : 0,
                },
                parts: [],
              },
            } as T
          }
          if (method === 'POST' && path.endsWith('/pause')) {
            seen.add('pause')
            return { ok: true, data: { ...baseSession, state: 'paused' } } as T
          }
          if (method === 'POST' && path.endsWith('/resume')) {
            seen.add('resume')
            statusCompleted = true
            return { ok: true, data: baseSession } as T
          }
          if (method === 'POST' && path.endsWith('/complete')) {
            seen.add('complete')
            return {
              ok: true,
              data: {
                ...baseSession,
                state: 'completed',
                contiguousBytes: bytes.length,
                committedBytes: bytes.length,
                committedPartCount: 1,
              },
            } as T
          }
          if (method === 'DELETE') {
            seen.add('delete')
            return { ok: true } as T
          }
          throw new Error(`unexpected ${method} ${url}`)
        },
        async requestPart(
          url: string,
          _token: string,
          _headers: Record<string, string>,
          body: NodeJS.ReadableStream
        ) {
          expectCanonicalDrive(url, 'archive')
          seen.add('part')
          for await (const _chunk of body as AsyncIterable<Buffer>) {
            /* drain */
          }
          return { status: 204, text: '' }
        },
      }

      await new DesktopGfsUploadJob({
        baseUrl: 'https://api.example',
        token: 'token',
        filePath,
        name: 'payload.bin',
        drive: 'archive',
        operation: 'create',
        parentRid: 'parent-drive',
        transport,
      }).start()

      const lifecycleJob = new DesktopGfsUploadJob({
        baseUrl: 'https://api.example',
        token: 'token',
        filePath,
        name: 'payload.bin',
        drive: 'archive',
        operation: 'create',
        parentRid: 'parent-drive',
        transport,
      })
      ;(lifecycleJob as unknown as { session: typeof baseSession }).session = baseSession
      await lifecycleJob.pause()
      await lifecycleJob.resume()

      const cancelJob = new DesktopGfsUploadJob({
        baseUrl: 'https://api.example',
        token: 'token',
        filePath,
        name: 'payload.bin',
        drive: 'archive',
        operation: 'create',
        parentRid: 'parent-drive',
        transport,
      })
      ;(cancelJob as unknown as { session: typeof baseSession }).session = baseSession
      await cancelJob.cancel()

      expect([...seen].sort()).toEqual(
        [
          'capabilities',
          'complete',
          'create',
          'delete',
          'head',
          'part',
          'pause',
          'resume',
          'status',
        ].sort()
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fences an epoch-stale job before any later part or completion request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evenfire-gfs-upload-epoch-'))
    try {
      const filePath = join(root, 'payload.bin')
      await writeFile(filePath, Buffer.from([1, 2]))
      let stale = false
      let partRequests = 0
      let completeRequests = 0
      const session = {
        uploadId: '66666666-6666-4666-8666-666666666666',
        drive: 'main',
        operation: 'create' as const,
        expectedBytes: 2,
        partBytes: 1,
        partCount: 2,
        state: 'initiated',
        contiguousBytes: 0,
        committedBytes: 0,
        committedPartCount: 0,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      const transport = {
        async requestJson<T>(method: 'GET' | 'POST', url: string): Promise<T> {
          if (method === 'GET')
            return {
              ok: true,
              data: {
                upload: {
                  resumableV2: { enabled: true, maxConcurrentPartsPerSession: 1 },
                },
              },
            } as T
          if (requestPath(url).endsWith('/uploads')) return { ok: true, data: session } as T
          completeRequests += 1
          return { ok: true, data: { ...session, state: 'completed' } } as T
        },
        async requestPart(
          _url: string,
          _token: string,
          _headers: Record<string, string>,
          body: NodeJS.ReadableStream
        ) {
          partRequests += 1
          for await (const _chunk of body as AsyncIterable<Buffer>) {
            /* drain */
          }
          stale = true
          return { status: 204, text: '' }
        },
      }
      await expect(
        new DesktopGfsUploadJob({
          baseUrl: 'https://api.example',
          token: 'token',
          filePath,
          name: 'payload.bin',
          drive: 'main',
          operation: 'create',
          parentRid: 'parent-epoch',
          assertAuthEpoch: () => {
            if (stale) throw new Error('stale_auth_epoch: test epoch changed')
          },
          transport,
        }).start()
      ).rejects.toThrow('stale_auth_epoch: test epoch changed')
      expect(partRequests).toBe(1)
      expect(completeRequests).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts and awaits an in-flight lifecycle request before auth suspension settles', async () => {
    const session = {
      uploadId: '77777777-7777-4777-8777-777777777777',
      drive: 'main',
      operation: 'create' as const,
      expectedBytes: 1,
      partBytes: 1,
      partCount: 1,
      state: 'uploading',
      contiguousBytes: 0,
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    let lifecycleRequests = 0
    let lifecycleSettled = false
    const transport = {
      requestJson<T>(
        _method: 'GET' | 'POST' | 'HEAD' | 'DELETE',
        _url: string,
        options?: { signal?: AbortSignal }
      ): Promise<T> {
        lifecycleRequests += 1
        return new Promise<T>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              queueMicrotask(() => {
                lifecycleSettled = true
                reject(options.signal?.reason)
              })
            },
            { once: true }
          )
        })
      },
      async requestPart() {
        throw new Error('part request was not expected')
      },
    }
    const job = new DesktopGfsUploadJob({
      baseUrl: 'https://api.example',
      token: 'token',
      filePath: '/not-read-for-this-control-operation',
      name: 'payload.bin',
      drive: 'main',
      operation: 'create',
      parentRid: 'parent-auth-suspend',
      transport,
    })
    ;(job as unknown as { session: typeof session }).session = session

    const pauseOutcome = job.pause().then(
      () => null,
      error => error
    )
    for (let turn = 0; turn < 5 && lifecycleRequests === 0; turn += 1) await Promise.resolve()
    expect(lifecycleRequests).toBe(1)
    await job.suspendForAuth()

    expect(lifecycleSettled).toBe(true)
    await expect(pauseOutcome).resolves.toMatchObject({
      message: 'GFS upload suspended by authentication fence',
    })
    expect(job.snapshot().state).toBe('suspended_auth')
    await expect(job.resume()).rejects.toThrow('stale_auth_epoch')
    expect(lifecycleRequests).toBe(1)
  })
})
