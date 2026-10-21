import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ControlApiError,
  ControlApiPathError,
  assertControlApiPathAllowed,
  assertControlApiRawQueryAllowed,
  controlApiBinaryRequestWithStatus,
  controlApiPassthroughGet,
  controlApiRequest,
  controlApiRequestWithStatus,
  controlApiStreamRequest,
} from '../src/controlApiClient.js'

// A `?` in the path is rejected: Express decodes `%3f` in a route param before
// the call site interpolates it, and URL construction would otherwise truncate
// the suffix and select a different control-api handler. The SharedFileSystem
// relay's opaque query travels through `rawQueryString` instead.
const REJECTED_PATHS = [
  ['raw query delimiter', '/external/members/invitations?/resend'],
  ['raw query truncation', '/external/members/U?/teams/T'],
  [
    'raw SFS wildcard question mark',
    '/external/contexts/c/shared-filesystems/s/proxy/files/a?b.txt',
  ],
  ['raw dot-dot segment', '/external/members/invitations/../../access/resolve?/resend'],
  ['encoded dot-dot segments', '/external/members/invitations/%2e%2e/%2e%2e/access/resolve'],
  ['mixed-case encoded dot-dot segments', '/external/members/invitations/%2E./%2e./access/resolve'],
  ['single dot segment', '/external/contexts/./shared-filesystems'],
  ['encoded single dot segment', '/external/contexts/%2e/shared-filesystems'],
  [
    'encoded separator dot-dot segments',
    '/external/contexts/c/shared-filesystems/s/proxy/..%2f..%2f..%2f..%2f..%2faccess%2fresolve',
  ],
  [
    'encoded separator capability alias',
    '/external/contexts/c/shared-filesystems/s/proxy/..%2faccess%2fcapabilities',
  ],
  ['fragment delimiter', '/external/access/capabilities#/../access/resolve'],
  ['fragment suffix', '/external/members/invitations/id/resend#/../../access/resolve'],
] as const

const ACCEPTED_PATHS = [
  ['capabilities', '/external/access/capabilities'],
  [
    'invitation resend',
    '/external/members/invitations/7f9c2bce-1a2b-4c3d-8e4f-0123456789ab/resend',
  ],
  [
    'shared filesystem relay file',
    '/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/files/report.txt',
  ],
] as const

const REJECTED_RAW_QUERIES = [
  ['missing leading question mark', 'download=1'],
  ['fragment delimiter', '?download=1#fragment'],
  ['control character', '?download=\u0001'],
] as const

const ACCEPTED_RAW_QUERIES = [
  ['empty', ''],
  ['product-shaped download', '?path=notes%2Fplan.md'],
] as const

const REJECTED_PATH = '/external/members/invitations/../../access/resolve?/resend'
const ACCEPTED_PATH = '/external/access/capabilities'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(): ReturnType<typeof vi.fn> {
  // A Response body can be consumed once, so each call needs a fresh response.
  const fetchMock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(jsonResponse({ served: true })))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function fetchedUrl(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): URL {
  const [url] = fetchMock.mock.calls[callIndex] as [string, RequestInit]
  return new URL(url)
}

describe('control-api path guard', () => {
  it('rejects every relocation form including a raw question mark while accepting ordinary control-api paths in the same test', () => {
    for (const [name, path] of REJECTED_PATHS) {
      expect(() => assertControlApiPathAllowed(path), name).toThrow(ControlApiPathError)
    }
    for (const [name, path] of ACCEPTED_PATHS) {
      expect(() => assertControlApiPathAllowed(path), name).not.toThrow()
    }
  })

  it('classifies a rejected path as the existing invalid-request client error', () => {
    expect.assertions(4)
    try {
      assertControlApiPathAllowed(REJECTED_PATH)
    } catch (error) {
      expect(error).toBeInstanceOf(ControlApiPathError)
      expect(error).toBeInstanceOf(ControlApiError)
      expect((error as ControlApiError).status).toBe(400)
      expect((error as ControlApiError).code).toBe('invalid_request')
    }
  })

  it('accepts only an empty or leading-question-mark raw query without fragments or control characters', () => {
    for (const [name, rawQueryString] of ACCEPTED_RAW_QUERIES) {
      expect(() => assertControlApiRawQueryAllowed(rawQueryString), name).not.toThrow()
    }
    for (const [name, rawQueryString] of REJECTED_RAW_QUERIES) {
      expect(() => assertControlApiRawQueryAllowed(rawQueryString), name).toThrow(
        ControlApiPathError
      )
    }
  })

  it('fails loudly before fetch when raw and structured queries are both supplied', async () => {
    const fetchMock = stubFetch()

    await expect(
      controlApiStreamRequest(
        'GET',
        '/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/files',
        { query: { download: '1' }, rawQueryString: '?download=1' }
      )
    ).rejects.toThrow('mutually exclusive')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed in the JSON client before fetch, then fetches accepted paths', async () => {
    const fetchMock = stubFetch()

    await expect(controlApiRequest('POST', REJECTED_PATH)).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    await expect(controlApiRequestWithStatus('POST', REJECTED_PATH)).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    expect(fetchMock).not.toHaveBeenCalled()

    // Same-test positive witness for each JSON entry point.
    await expect(controlApiRequestWithStatus('GET', ACCEPTED_PATH)).resolves.toEqual({
      data: { served: true },
      status: 200,
    })
    await expect(controlApiRequest('GET', ACCEPTED_PATH)).resolves.toEqual({ served: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const callIndex of [0, 1]) {
      expect(fetchedUrl(fetchMock, callIndex).pathname).toBe('/api/v1/external/access/capabilities')
    }
  })

  it('fails closed in the binary client before fetch, then fetches an accepted path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from('binary-body'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(controlApiBinaryRequestWithStatus('GET', REJECTED_PATH)).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    expect(fetchMock).not.toHaveBeenCalled()

    const result = await controlApiBinaryRequestWithStatus('GET', ACCEPTED_PATH)
    expect(result.body.equals(Buffer.from('binary-body'))).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchedUrl(fetchMock, 0).pathname).toBe('/api/v1/external/access/capabilities')
  })

  it('fails closed in the stream client before fetch, then forwards a raw query unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('stream-body', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(controlApiStreamRequest('GET', REJECTED_PATH)).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    expect(fetchMock).not.toHaveBeenCalled()

    const response = await controlApiStreamRequest(
      'GET',
      '/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/v1/files/download',
      { rawQueryString: '?path=notes%2Fplan.md' }
    )
    expect(await response.text()).toBe('stream-body')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const upstream = fetchedUrl(fetchMock, 0)
    expect(upstream.pathname).toBe(
      '/api/v1/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/v1/files/download'
    )
    expect(upstream.search).toBe('?path=notes%2Fplan.md')
  })

  it('fails closed in the passthrough client before fetch, then fetches an accepted path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html>callback</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(controlApiPassthroughGet(REJECTED_PATH, '?state=proof')).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    await expect(
      controlApiPassthroughGet('/oauth-callback/google-gmail', '?state=proof#fragment')
    ).rejects.toBeInstanceOf(ControlApiPathError)
    expect(fetchMock).not.toHaveBeenCalled()

    const result = await controlApiPassthroughGet('/oauth-callback/google-gmail', '?state=proof')
    expect(result).toEqual({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html>callback</html>',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const upstream = fetchedUrl(fetchMock, 0)
    expect(upstream.pathname).toBe('/api/v1/oauth-callback/google-gmail')
    expect(upstream.search).toBe('?state=proof')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })
})
