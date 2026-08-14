import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GFS_FILE_UPLOAD_MAX_BYTES, GFS_FILE_UPLOAD_MAX_MEGABYTES } from '@constants/gfsFileUpload'
import {
  GfsUploadJob,
  type GfsUploadStatus,
  assertGfsFileUploadSize,
  isAmbiguousUploadStatus,
  isRetryableUploadStatus,
  normalizeInstabilityFailureThreshold,
  parseRetryAfter,
} from '@lib/gfsFileUpload'

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

describe('parseRetryAfter', () => {
  it('accepts delta-seconds and caps untrusted server delays', () => {
    expect(parseRetryAfter('2')).toBe(2_000)
    expect(parseRetryAfter('60')).toBe(5_000)
    expect(parseRetryAfter('not-a-date')).toBeUndefined()
  })
})

describe('normalizeInstabilityFailureThreshold', () => {
  it('uses the protocol default when older writers omit the field', () => {
    expect(normalizeInstabilityFailureThreshold(undefined)).toBe(3)
  })

  it('accepts bounded writer-configured thresholds and rejects invalid values', () => {
    expect(normalizeInstabilityFailureThreshold(1)).toBe(1)
    expect(normalizeInstabilityFailureThreshold(5)).toBe(5)
    expect(() => normalizeInstabilityFailureThreshold(0)).toThrow(/invalid instability threshold/)
    expect(() => normalizeInstabilityFailureThreshold(101)).toThrow(/invalid instability threshold/)
    expect(() => normalizeInstabilityFailureThreshold(1.5)).toThrow(/invalid instability threshold/)
  })
})

describe('isRetryableUploadStatus', () => {
  it('uses the same transient allowlist as Desktop and does not retry storage exhaustion', () => {
    expect(isRetryableUploadStatus(503)).toBe(true)
    expect(isRetryableUploadStatus(507)).toBe(false)
    expect(isRetryableUploadStatus(501)).toBe(false)
  })

  it('only reconciles statuses whose response may follow a committed write', () => {
    expect(isAmbiguousUploadStatus(500)).toBe(true)
    expect(isAmbiguousUploadStatus(429)).toBe(false)
    expect(isAmbiguousUploadStatus(507)).toBe(false)
    expect(isAmbiguousUploadStatus(501)).toBe(false)
  })
})

class FakeXhr {
  static requests: FakeXhr[] = []
  static statuses: number[] = []
  static statusesByPart: Record<number, number[]> = {}
  static responseLosses = 0
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number }) => void) | null } =
    { onprogress: null }
  status = 204
  responseText = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  headers = new Map<string, string>()
  body: Blob | null = null
  url = ''

  open(_method: string, url: string): void {
    this.url = url
  }
  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }
  getResponseHeader(name: string): string | null {
    return this.headers.get(name) ?? null
  }
  send(body: Blob): void {
    this.body = body
    const partNumber = /\/parts\/(\d+)(?:\?|$)/.exec(this.url)?.[1]
    const partStatuses =
      partNumber === undefined ? undefined : FakeXhr.statusesByPart[Number(partNumber)]
    this.status = partStatuses?.shift() ?? FakeXhr.statuses.shift() ?? 204
    if (this.status === 429) this.headers.set('retry-after', '0')
    FakeXhr.requests.push(this)
    void body.arrayBuffer().then(() => {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: Math.max(1, Math.floor(body.size / 2)),
      })
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size })
      if (FakeXhr.responseLosses > 0) {
        FakeXhr.responseLosses -= 1
        this.onerror?.()
        return
      }
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
    FakeXhr.statusesByPart = {}
    FakeXhr.responseLosses = 0
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('honors the writer-advertised maxFileBytes before creating a session', async () => {
    const file = new File([new Uint8Array([1, 2])], 'ceiling.bin')
    let createCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && String(_input).endsWith('/capabilities'))
          return new Response(
            JSON.stringify({ upload: { resumableV2: { enabled: true, maxFileBytes: 1 } } }),
            { status: 200 }
          )
        if (method === 'POST' && String(_input).endsWith('/uploads')) createCalls += 1
        return new Response(null, { status: 204 })
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-ceiling' },
      }).start()
    ).rejects.toThrow('writer limit is 1 bytes')
    expect(createCalls).toBe(0)
  })

  it('rejects a create receipt that changes the canonical control-ui drive', async () => {
    const file = new File([new Uint8Array([3])], 'drive-drift.bin')
    let partCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(
            JSON.stringify({
              upload: { resumableV2: { enabled: true } },
            }),
            {
              status: 200,
            }
          )
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '18181818-1818-4181-8181-181818181818',
                drive: 'archive',
                expectedBytes: 1,
                partBytes: 1,
                partCount: 1,
                state: 'initiated',
                committedBytes: 0,
                committedPartCount: 0,
                activePartCount: 0,
              },
            }),
            { status: 201 }
          )
        if (method === 'PUT') partCalls += 1
        return new Response(null, { status: 204 })
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-drive-drift' },
      }).start()
    ).rejects.toThrow('upload_drive_mismatch')
    expect(partCalls).toBe(0)
  })

  it('rejects a create receipt that omits the canonical control-ui drive', async () => {
    const file = new File([new Uint8Array([4])], 'missing-drive.bin')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(
            JSON.stringify({
              upload: { resumableV2: { enabled: true } },
            }),
            { status: 200 }
          )
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '19191919-1919-4191-8191-191919191919',
                expectedBytes: 1,
                partBytes: 1,
                partCount: 1,
                state: 'initiated',
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
        target: { operation: 'create', parentRid: 'parent-missing-drive' },
      }).start()
    ).rejects.toThrow('upload_drive_mismatch')
  })

  it('rejects a resumed status receipt that omits the canonical control-ui drive', async () => {
    const file = new File([new Uint8Array([5])], 'missing-status-drive.bin')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'HEAD')
          return new Response(null, { status: 204, headers: { 'upload-length': '1' } })
        if (method === 'GET' && url.includes('/status'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                session: {
                  uploadId: '20202020-2020-4020-8020-202020202020',
                  expectedBytes: 1,
                  partBytes: 1,
                  partCount: 1,
                  state: 'uploading',
                  committedBytes: 0,
                  committedPartCount: 0,
                  activePartCount: 0,
                },
                parts: [],
              },
            }),
            { status: 200 }
          )
        return new Response(null, { status: 204 })
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-missing-status-drive' },
        resumeUploadId: '20202020-2020-4020-8020-202020202020',
      }).start()
    ).rejects.toThrow('upload status changed during reconciliation')
  })

  it('rejects a completion receipt that omits the canonical control-ui drive', async () => {
    const file = new File([new Uint8Array([6])], 'missing-complete-drive.bin')
    const session = {
      uploadId: '21212121-2121-4121-8121-212121212121',
      drive: 'main',
      expectedBytes: 1,
      partBytes: 1,
      partCount: 1,
      state: 'initiated',
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
        if (method === 'POST' && url.endsWith('/complete'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: { ...session, drive: undefined, state: 'completed' },
            }),
            { status: 200 }
          )
        return new Response(null, { status: 204 })
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-missing-complete-drive' },
      }).start()
    ).rejects.toThrow('upload_drive_mismatch')
  })

  it('resumes only the missing part and emits visible progress before completion', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'payload.bin', { lastModified: 12 })
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2])))
    const part0 = [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
    const responses: Array<{ status: number; body?: unknown }> = []
    const status: GfsUploadStatus = {
      session: {
        uploadId: '11111111-1111-4111-8111-111111111111',
        drive: 'main',
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
    const part1Digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array([3, 4]))
    )
    expect(FakeXhr.requests[0]?.headers.get('Upload-Checksum')).toBe(
      `sha256 ${btoa(String.fromCharCode(...part1Digest))}`
    )
    expect(progress.some(value => value < 4)).toBe(true)
    expect(progress.at(-1)).toBe(4)
    expect(responses).toHaveLength(0)
  })

  it('retries a lifecycle 429 using the server Retry-After header', async () => {
    const file = new File([new Uint8Array([21])], 'retry-after.bin')
    const session = {
      uploadId: '12121212-1212-4121-8121-121212121212',
      drive: 'main',
      expectedBytes: 1,
      partBytes: 1,
      partCount: 1,
      state: 'initiated',
      contiguousBytes: 0,
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    let createCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/uploads')) {
          createCalls += 1
          if (createCalls === 1)
            return new Response('{"error":"quota_exceeded"}', {
              status: 429,
              headers: { 'retry-after': '0' },
            })
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
        }
        if (method === 'POST' && url.endsWith('/complete'))
          return new Response(
            JSON.stringify({ ok: true, data: { ...session, state: 'completed' } }),
            {
              status: 200,
            }
          )
        throw new Error(`unexpected ${method} ${url}`)
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-retry-after' },
      }).start()
    ).resolves.toMatchObject({ state: 'completed' })
    expect(createCalls).toBe(2)
  })

  it('retries an XHR part 429 using the server Retry-After header', async () => {
    const file = new File([new Uint8Array([22])], 'part-retry-after.bin')
    const session = {
      uploadId: '13131313-1313-4131-8131-131313131314',
      drive: 'main',
      expectedBytes: 1,
      partBytes: 1,
      partCount: 1,
      state: 'initiated',
      contiguousBytes: 0,
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    FakeXhr.statuses = [429, 204]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
        if (method === 'POST' && url.endsWith('/complete'))
          return new Response(
            JSON.stringify({ ok: true, data: { ...session, state: 'completed' } }),
            {
              status: 200,
            }
          )
        throw new Error(`unexpected ${method} ${url}`)
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-part-retry-after' },
      }).start()
    ).resolves.toMatchObject({ state: 'completed' })
    expect(FakeXhr.requests).toHaveLength(2)
  })

  it('uses the extended bounded part budget while a writer is restarting', async () => {
    const file = new File([new Uint8Array([23])], 'part-writer-restart.bin')
    const session = {
      uploadId: '14141414-1414-4141-8141-141414141414',
      drive: 'main',
      expectedBytes: 1,
      partBytes: 1,
      partCount: 1,
      state: 'initiated',
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    FakeXhr.statuses = [502, 502, 502, 502, 502, 204]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
        if (method === 'HEAD') return new Response(null, { status: 204 })
        if (method === 'GET' && url.includes('/status'))
          return new Response(JSON.stringify({ ok: true, data: { session, parts: [] } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/complete'))
          return new Response(
            JSON.stringify({ ok: true, data: { ...session, state: 'completed' } }),
            { status: 200 }
          )
        throw new Error(`unexpected ${method} ${url}`)
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-part-writer-restart' },
      }).start()
    ).resolves.toMatchObject({ state: 'completed' })
    expect(FakeXhr.requests).toHaveLength(6)
  })

  it('removes a failed part attempt from aggregate progress before retrying it', async () => {
    const file = new File([new Uint8Array([31, 32, 33, 34])], 'progress-retry.bin')
    const session = {
      uploadId: '16161616-1616-4161-8161-161616161616',
      drive: 'main',
      expectedBytes: 4,
      partBytes: 4,
      partCount: 1,
      state: 'initiated',
      contiguousBytes: 0,
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    FakeXhr.statuses = [502, 204]
    const progress: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
        if (method === 'HEAD') return new Response(null, { status: 204 })
        if (method === 'GET' && url.includes('/status'))
          return new Response(JSON.stringify({ ok: true, data: { session, parts: [] } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/complete'))
          return new Response(
            JSON.stringify({ ok: true, data: { ...session, state: 'completed' } }),
            { status: 200 }
          )
        throw new Error(`unexpected ${method} ${url}`)
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-progress-retry' },
        onProgress: value => progress.push(value.uploadedBytes),
      }).start()
    ).resolves.toMatchObject({ state: 'completed' })

    expect(progress.some((value, index) => index > 0 && value < progress[index - 1]!)).toBe(true)
  })

  it('adopts a status-confirmed committed part after its XHR response is lost', async () => {
    const file = new File([new Uint8Array([5, 6, 7, 8])], 'response-loss.bin', {
      lastModified: 13,
    })
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
    const sha256 = [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
    const uploadId = '15151515-1515-4151-8151-151515151515'
    const session = {
      uploadId,
      drive: 'main',
      expectedBytes: file.size,
      partBytes: file.size,
      partCount: 1,
      state: 'initiated',
      contiguousBytes: 0,
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    let statusCalls = 0
    let completeCalls = 0
    FakeXhr.responseLosses = 1
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
        if (method === 'HEAD') return new Response(null, { status: 204 })
        if (method === 'GET' && url.includes('/status')) {
          statusCalls += 1
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                session: {
                  ...session,
                  state: 'uploading',
                  contiguousBytes: file.size,
                  committedBytes: file.size,
                  committedPartCount: 1,
                },
                parts: [
                  {
                    partNumber: 0,
                    offsetBytes: 0,
                    lengthBytes: file.size,
                    sha256,
                  },
                ],
              },
            }),
            { status: 200 }
          )
        }
        if (method === 'POST' && url.endsWith('/complete')) {
          completeCalls += 1
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                ...session,
                state: 'completed',
                contiguousBytes: file.size,
                committedBytes: file.size,
                committedPartCount: 1,
              },
            }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected ${method} ${url}`)
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-response-loss' },
      }).start()
    ).resolves.toMatchObject({ state: 'completed' })

    expect(FakeXhr.requests).toHaveLength(1)
    expect(statusCalls).toBe(1)
    expect(completeCalls).toBe(1)
  })

  it('retries a missing target even when a sibling part still holds a lease', async () => {
    const file = new File([new Uint8Array([5, 6])], 'active-sibling.bin')
    const session = {
      uploadId: '18181818-1818-4181-8181-181818181818',
      drive: 'main',
      expectedBytes: 2,
      partBytes: 1,
      partCount: 2,
      state: 'initiated',
      contiguousBytes: 0,
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    let statusCalls = 0
    FakeXhr.responseLosses = 1
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(
            JSON.stringify({
              upload: { resumableV2: { enabled: true, maxConcurrentPartsPerSession: 1 } },
            }),
            { status: 200 }
          )
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
        if (method === 'HEAD') return new Response(null, { status: 204 })
        if (method === 'GET' && url.includes('/status')) {
          statusCalls += 1
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                session: {
                  ...session,
                  state: 'uploading',
                  activePartCount: 1,
                  activePartNumbers: [1],
                },
                parts: [],
              },
            }),
            { status: 200 }
          )
        }
        if (method === 'POST' && url.endsWith('/complete'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: { ...session, state: 'completed', committedBytes: 2, committedPartCount: 2 },
            }),
            { status: 200 }
          )
        throw new Error(`unexpected ${method} ${url}`)
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-active-sibling' },
      }).start()
    ).resolves.toMatchObject({ state: 'completed' })
    expect(statusCalls).toBe(1)
    expect(FakeXhr.requests).toHaveLength(3)
  })

  it('reconciles one ambiguous part against the live sibling lease set under four-way concurrency', async () => {
    const file = new File([new Uint8Array([11, 12, 13, 14, 15, 16, 17, 18])], 'four-way.bin')
    FakeXhr.statusesByPart = { 3: [500, 204] }
    let statusCalls = 0
    let completeCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(
            JSON.stringify({
              upload: {
                resumableV2: {
                  enabled: true,
                  preferredChunkBytes: 2,
                  maxChunkBytes: 2,
                  maxConcurrentPartsPerSession: 4,
                  fallbackConcurrency: 2,
                  instabilityFailureThreshold: 3,
                },
              },
            }),
            { status: 200 }
          )
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '35353535-3535-4353-8353-353535353535',
                drive: 'main',
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
        if (method === 'HEAD') return new Response(null, { status: 204 })
        if (method === 'GET' && url.includes('/status')) {
          statusCalls += 1
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                session: {
                  uploadId: '35353535-3535-4353-8353-353535353535',
                  drive: 'main',
                  expectedBytes: 8,
                  partBytes: 2,
                  partCount: 4,
                  state: 'uploading',
                  contiguousBytes: 0,
                  committedBytes: 0,
                  committedPartCount: 0,
                  activePartCount: 3,
                  activePartNumbers: [0, 1, 2],
                },
                parts: [],
              },
            }),
            { status: 200 }
          )
        }
        if (method === 'POST' && url.endsWith('/complete')) {
          completeCalls += 1
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '35353535-3535-4353-8353-353535353535',
                drive: 'main',
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

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-four-way' },
      }).start()
    ).resolves.toMatchObject({ state: 'completed' })
    expect(statusCalls).toBe(1)
    expect(completeCalls).toBe(1)
    expect(FakeXhr.requests).toHaveLength(5)
  })

  it('persists an unresolved response-loss session without replaying its part', async () => {
    const file = new File([new Uint8Array([9, 10])], 'outcome-unknown.bin', {
      lastModified: 14,
    })
    const session = {
      uploadId: '16161616-1616-4161-8161-161616161616',
      drive: 'main',
      expectedBytes: file.size,
      partBytes: file.size,
      partCount: 1,
      state: 'initiated',
      contiguousBytes: 0,
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
    }
    let reconcileStatusCalls = 0
    let completeCalls = 0
    let persisted = 0
    FakeXhr.responseLosses = 1
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const url = String(_input)
        if (method === 'GET' && url.endsWith('/capabilities'))
          return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
            status: 200,
          })
        if (method === 'POST' && url.endsWith('/uploads'))
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
        if (method === 'HEAD') return new Response(null, { status: 204 })
        if (method === 'GET' && url.includes('/status')) {
          reconcileStatusCalls += 1
          throw new Error('status transport unavailable')
        }
        if (method === 'POST' && url.endsWith('/complete')) {
          completeCalls += 1
          return new Response(JSON.stringify({ ok: true, data: session }), { status: 200 })
        }
        throw new Error(`unexpected ${method} ${url}`)
      })
    )

    await expect(
      new GfsUploadJob({
        file,
        name: file.name,
        target: { operation: 'create', parentRid: 'parent-outcome-unknown' },
        onPersist: () => {
          persisted += 1
        },
      }).start()
    ).rejects.toThrow('One or more upload parts could not be committed.')

    expect(persisted).toBe(1)
    expect(FakeXhr.requests).toHaveLength(1)
    expect(reconcileStatusCalls).toBe(3)
    expect(completeCalls).toBe(0)
  })

  it('fails closed when response-loss status omits or corrupts activePartCount', async () => {
    const file = new File([new Uint8Array([11, 12])], 'invalid-active-count.bin', {
      lastModified: 15,
    })
    const invalidCounts: unknown[] = [undefined, 0.5, -1]

    for (const [index, activePartCount] of invalidCounts.entries()) {
      const session = {
        uploadId: `17171717-1717-4171-8171-17171717171${index}`,
        drive: 'main',
        expectedBytes: file.size,
        partBytes: file.size,
        partCount: 1,
        state: 'initiated',
        contiguousBytes: 0,
        committedBytes: 0,
        committedPartCount: 0,
        ...(activePartCount === undefined ? {} : { activePartCount }),
      }
      let statusCalls = 0
      let completeCalls = 0
      FakeXhr.requests = []
      FakeXhr.statuses = []
      FakeXhr.responseLosses = 1
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const method = init?.method ?? 'GET'
          const url = String(_input)
          if (method === 'GET' && url.endsWith('/capabilities'))
            return new Response(JSON.stringify({ upload: { resumableV2: { enabled: true } } }), {
              status: 200,
            })
          if (method === 'POST' && url.endsWith('/uploads'))
            return new Response(JSON.stringify({ ok: true, data: session }), { status: 201 })
          if (method === 'HEAD') return new Response(null, { status: 204 })
          if (method === 'GET' && url.includes('/status')) {
            statusCalls += 1
            return new Response(
              JSON.stringify({
                ok: true,
                data: { session: { ...session, state: 'uploading' }, parts: [] },
              }),
              { status: 200 }
            )
          }
          if (method === 'POST' && url.endsWith('/complete')) {
            completeCalls += 1
            return new Response(JSON.stringify({ ok: true, data: session }), { status: 200 })
          }
          throw new Error(`unexpected ${method} ${url}`)
        })
      )

      await expect(
        new GfsUploadJob({
          file,
          name: file.name,
          target: { operation: 'create', parentRid: `parent-invalid-active-${index}` },
        }).start()
      ).rejects.toThrow('One or more upload parts could not be committed.')

      expect(FakeXhr.requests).toHaveLength(1)
      expect(statusCalls).toBe(1)
      expect(completeCalls).toBe(0)
    }
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
                drive: 'main',
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
    ).rejects.toThrow(/invalid SHA-256|does not match/)
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
                  preferredChunkBytes: 2,
                  maxChunkBytes: 2,
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
                drive: 'main',
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
        if (method === 'HEAD') return new Response(null, { status: 204 })
        if (method === 'GET' && String(_input).includes('/status'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                session: {
                  uploadId: '33333333-3333-4333-8333-333333333333',
                  drive: 'main',
                  expectedBytes: 8,
                  partBytes: 2,
                  partCount: 4,
                  state: 'uploading',
                  contiguousBytes: 0,
                  committedBytes: 0,
                  committedPartCount: 0,
                  activePartCount: 0,
                },
                parts: [],
              },
            }),
            { status: 200 }
          )
        if (method === 'POST' && String(_input).endsWith('/complete')) {
          completeCalls += 1
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '33333333-3333-4333-8333-333333333333',
                drive: 'main',
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
              upload: { resumableV2: { enabled: true, preferredChunkBytes: 2, maxChunkBytes: 2 } },
            }),
            { status: 200 }
          )
        if (init?.method === 'POST' && String(_input).endsWith('/uploads'))
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                uploadId: '44444444-4444-4444-8444-444444444444',
                drive: 'main',
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
