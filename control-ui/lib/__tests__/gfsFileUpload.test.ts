import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GFS_FILE_UPLOAD_MAX_BYTES, GFS_FILE_UPLOAD_MAX_MEGABYTES } from '@constants/gfsFileUpload'
import { GfsUploadJob, type GfsUploadStatus, assertGfsFileUploadSize } from '@lib/gfsFileUpload'

describe('assertGfsFileUploadSize', () => {
  it('accepts files at the upload limit', () => {
    expect(() => assertGfsFileUploadSize(GFS_FILE_UPLOAD_MAX_BYTES)).not.toThrow()
  })

  it('rejects files above the upload limit', () => {
    expect(() => assertGfsFileUploadSize(GFS_FILE_UPLOAD_MAX_BYTES + 1)).toThrow(
      `GFS uploads are limited to ${GFS_FILE_UPLOAD_MAX_MEGABYTES} MB per file.`
    )
  })
})

class FakeXhr {
  static requests: FakeXhr[] = []
  static statuses: number[] = []
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number }) => void) | null } =
    { onprogress: null }
  status = 204
  responseText = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  headers = new Map<string, string>()
  body: Blob | null = null

  open(): void {}
  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }
  send(body: Blob): void {
    this.body = body
    this.status = FakeXhr.statuses.shift() ?? 204
    FakeXhr.requests.push(this)
    void body.arrayBuffer().then(() => {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: Math.max(1, Math.floor(body.size / 2)),
      })
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size })
      this.onload?.()
    })
  }
  abort(): void {
    this.onabort?.()
  }
}

describe('GfsUploadJob', () => {
  beforeEach(() => {
    FakeXhr.requests = []
    FakeXhr.statuses = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resumes only the missing part and emits visible progress before completion', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'payload.bin', { lastModified: 12 })
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2])))
    const part0 = btoa(String.fromCharCode(...digest))
    const responses: Array<{ status: number; body?: unknown }> = []
    const status: GfsUploadStatus = {
      session: {
        uploadId: '11111111-1111-4111-8111-111111111111',
        expectedBytes: 4,
        partBytes: 2,
        partCount: 2,
        state: 'uploading',
        contiguousBytes: 2,
        committedBytes: 2,
        committedPartCount: 1,
        activePartCount: 0,
      },
      parts: [{ partNumber: 0, offsetBytes: 0, lengthBytes: 2, sha256: part0 }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && String(_input).endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'HEAD')
          return new Response(null, { status: 204, headers: { 'upload-length': '4' } })
        if (method === 'GET' && String(_input).includes('/status'))
          return new Response(JSON.stringify({ ok: true, data: status }), { status: 200 })
        if (method === 'POST' && String(_input).endsWith('/complete'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                ...status.session,
                state: 'completed',
                committedBytes: 4,
                committedPartCount: 2,
              },
            }),
            { status: 200 }
          )
        responses.push({ status: 204, body: method })
        return new Response(null, { status: 204 })
      })
    )
    const progress: number[] = []
    const job = new GfsUploadJob({
      file,
      name: file.name,
      target: { operation: 'create', parentRid: 'parent-1' },
      resumeUploadId: status.session.uploadId,
      onProgress: value => progress.push(value.uploadedBytes),
    })
    const result = await job.start()
    expect(result.state).toBe('completed')
    expect(FakeXhr.requests).toHaveLength(1)
    expect(FakeXhr.requests[0]?.headers.get('Upload-Part-Number')).toBe('1')
    expect(progress.some(value => value < 4)).toBe(true)
    expect(progress.at(-1)).toBe(4)
    expect(responses).toHaveLength(0)
  })

  it('rejects a committed status part whose checksum does not match the selected file before PUT', async () => {
    const file = new File([new Uint8Array([1, 2])], 'payload.bin')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET' && String(_input).endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (init?.method === 'HEAD')
          return new Response(null, { status: 204, headers: { 'upload-length': '2' } })
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              session: {
                uploadId: '22222222-2222-4222-8222-222222222222',
                expectedBytes: 2,
                partBytes: 2,
                partCount: 1,
                state: 'uploading',
                contiguousBytes: 2,
                committedBytes: 2,
                committedPartCount: 1,
                activePartCount: 0,
              },
              parts: [{ partNumber: 0, offsetBytes: 0, lengthBytes: 2, sha256: 'wrong-checksum' }],
            },
          }),
          { status: 200 }
        )
      })
    )
    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-2' },
        resumeUploadId: '22222222-2222-4222-8222-222222222222',
      }).start()
    ).rejects.toThrow(/does not match/)
    expect(FakeXhr.requests).toHaveLength(0)
  })

  it('latches the four-to-two fallback after three consecutive retryable failures', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'payload.bin')
    FakeXhr.statuses = [500, 500, 500, 204, 204, 204, 204]
    let completeCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && String(_input).endsWith('/capabilities')) {
          return new Response(
            JSON.stringify({
              upload: {
                resumableV2: {
                  enabled: true,
                  preferredPartBytes: 2,
                  maxPartBytes: 2,
                  maxConcurrentPartsPerSession: 4,
                  fallbackConcurrency: 2,
                },
              },
            }),
            { status: 200 }
          )
        }
        if (method === 'POST' && String(_input).endsWith('/uploads')) {
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '33333333-3333-4333-8333-333333333333',
                expectedBytes: 8,
                partBytes: 2,
                partCount: 4,
                state: 'initiated',
                contiguousBytes: 0,
                committedBytes: 0,
                committedPartCount: 0,
                activePartCount: 0,
              },
            }),
            { status: 201 }
          )
        }
        if (method === 'POST' && String(_input).endsWith('/complete')) {
          completeCalls += 1
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '33333333-3333-4333-8333-333333333333',
                expectedBytes: 8,
                partBytes: 2,
                partCount: 4,
                state: 'completed',
                committedBytes: 8,
                committedPartCount: 4,
                activePartCount: 0,
              },
            }),
            { status: 200 }
          )
        }
        return new Response(null, { status: 204 })
      })
    )
    const result = await new GfsUploadJob({
      file,
      name: file.name,
      target: { operation: 'create', parentRid: 'parent-fallback' },
    }).start()
    expect(result.state).toBe('completed')
    expect(completeCalls).toBe(1)
    expect(FakeXhr.requests).toHaveLength(7)
  })

  it('does not retry a non-retryable conflict', async () => {
    const file = new File([new Uint8Array([1, 2])], 'payload.bin')
    FakeXhr.statuses = [409]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET' && String(_input).endsWith('/capabilities'))
          return new Response(
            JSON.stringify({
              upload: { resumableV2: { enabled: true, preferredPartBytes: 2, maxPartBytes: 2 } },
            }),
            { status: 200 }
          )
        if (init?.method === 'POST' && String(_input).endsWith('/uploads'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '44444444-4444-4444-8444-444444444444',
                expectedBytes: 2,
                partBytes: 2,
                partCount: 1,
                state: 'initiated',
                contiguousBytes: 0,
                committedBytes: 0,
                committedPartCount: 0,
                activePartCount: 0,
              },
            }),
            { status: 201 }
          )
        return new Response(null, { status: 204 })
      })
    )
    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-conflict' },
      }).start()
    ).rejects.toThrow(/could not be committed/)
    expect(FakeXhr.requests).toHaveLength(1)
  })
})
