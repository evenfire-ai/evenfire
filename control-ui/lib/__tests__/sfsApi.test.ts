import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deleteSharedFileSystem,
  sfsDelete,
  sfsDownloadUrl,
  sfsListFiles,
  sfsMkdir,
  sfsMove,
  sfsUpload,
} from '../api'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sfs api helpers — URL shape', () => {
  it('sfsListFiles hits the proxy with the right path query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { path: 'docs', entries: [], truncated: false } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )
    await sfsListFiles('team-mission', 'docs')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/shared-filesystems/team-mission/proxy/v1/files')
    expect(url).toContain('path=docs')
    expect(init.credentials).toBe('include')
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('encodes the SFS name for paths with hyphens / unicode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { path: '', entries: [], truncated: false } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )
    await sfsListFiles('team mission with spaces', '')
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('team%20mission%20with%20spaces')
  })

  it('sfsMkdir POSTs the mkdir endpoint with a JSON body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    )
    await sfsMkdir('team-mission', 'docs/2026')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/proxy/v1/files/mkdir')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ path: 'docs/2026' }))
  })

  it('sfsMove POSTs the move endpoint with from + to', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    await sfsMove('team-mission', 'a.md', 'archive/a.md')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBe(JSON.stringify({ from: 'a.md', to: 'archive/a.md' }))
  })

  it('sfsDelete encodes path and optional recursive flag', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    await sfsDelete('team-mission', 'old/dir', true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(url).toContain('path=old%2Fdir')
    expect(url).toContain('recursive=true')
  })

  it('deleteSharedFileSystem accepts a 204 empty response', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))

    await expect(deleteSharedFileSystem('team-mission')).resolves.toBeUndefined()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(url).toContain('/api/v1/admin/shared-filesystems/team-mission')
  })

  it('sfsDownloadUrl returns a path that goes through the admin proxy', () => {
    const url = sfsDownloadUrl('team-mission', 'mission.md')
    expect(url).toContain('/api/v1/admin/shared-filesystems/team-mission/proxy/v1/files/download')
    expect(url).toContain('path=mission.md')
  })
})

describe('sfsUpload', () => {
  it('POSTs multipart with file + path field using the admin session cookie', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { path: 'a.md', kind: 'file', size: 5, mtime: new Date().toISOString() },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    )
    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'a.md', { type: 'text/markdown' })
    await sfsUpload('team-mission', 'a.md', file, 'create')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: FormData }]
    expect(init.method).toBe('POST')
    expect(url).toContain('/proxy/v1/files/upload')
    expect(init.credentials).toBe('include')
    expect(init.headers).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)
    expect(init.body.get('path')).toBe('a.md')
    const sentFile = init.body.get('file') as File
    expect(sentFile?.name).toBe('a.md')
  })

  it('uses PUT and /replace when mode=replace', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { path: 'a.md', kind: 'file', size: 1, mtime: '2026-01-01' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    const file = new File(['x'], 'a.md')
    await sfsUpload('team-mission', 'a.md', file, 'replace')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PUT')
    expect(url).toContain('/proxy/v1/files/replace')
  })

  it('throws with the wfc error envelope on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: { code: 'already_exists', message: 'file exists' } }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    )
    const file = new File(['x'], 'a.md')
    await expect(sfsUpload('team-mission', 'a.md', file, 'create')).rejects.toThrow(/file exists/)
  })
})
