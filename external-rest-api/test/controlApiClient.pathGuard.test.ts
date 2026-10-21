import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ControlApiError,
  ControlApiPathError,
  assertControlApiPathAllowed,
  controlApiBinaryRequestWithStatus,
  controlApiPassthroughGet,
  controlApiRequest,
  controlApiRequestWithStatus,
  controlApiStreamRequest,
} from '../src/controlApiClient.js'

// A bare `?` is intentionally allowed: the SharedFileSystem relay forwards the
// caller's opaque query string through the path argument
// (src/routes/contextSharedFilesystems.ts:88-95) and the brief forbids changing
// that interpolation site. The query cannot change the pathname, and every
// dot-segment form below still rejects a relocated pathname. `#` is rejected
// because URL construction would turn it into a fragment and drop the suffix.
const REJECTED_PATHS = [
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
  [
    'shared filesystem relay query',
    '/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/files/report.txt?download=1',
  ],
] as const

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('control-api path guard', () => {
  it('rejects every relocation form while accepting the ordinary control-api paths in the same test', () => {
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
      assertControlApiPathAllowed('/external/members/invitations/../../access/resolve?/resend')
    } catch (error) {
      expect(error).toBeInstanceOf(ControlApiPathError)
      expect(error).toBeInstanceOf(ControlApiError)
      expect((error as ControlApiError).status).toBe(400)
      expect((error as ControlApiError).code).toBe('invalid_request')
    }
  })

  it('fails closed in every control-api client before fetch, then fetches the accepted path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ served: true }))
    vi.stubGlobal('fetch', fetchMock)
    const rejected = '/external/members/invitations/../../access/resolve?/resend'

    await expect(controlApiRequest('POST', rejected)).rejects.toBeInstanceOf(ControlApiPathError)
    await expect(controlApiRequestWithStatus('POST', rejected)).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    await expect(controlApiBinaryRequestWithStatus('GET', rejected)).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    await expect(controlApiStreamRequest('GET', rejected)).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    await expect(controlApiPassthroughGet(rejected, '?state=proof')).rejects.toBeInstanceOf(
      ControlApiPathError
    )
    expect(fetchMock).not.toHaveBeenCalled()

    // Same-test positive witness: an ordinary path still reaches the stubbed
    // transport through the same client and the same credential path.
    await expect(controlApiRequest('GET', '/external/access/capabilities')).resolves.toEqual({
      served: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/api/v1/external/access/capabilities')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['x-service-token']).toBe('external-rest-api')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })
})
