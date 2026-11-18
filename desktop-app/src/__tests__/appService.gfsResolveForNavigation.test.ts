import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import { resolvedDirectory } from '../../ui/src/gfs/__fixtures__/gfsProducerFixtures.js'
import { AppService } from '../appService.js'
import { config } from '../config.js'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

const RID = '859df99de46b407bb0ec4b0f7cb424a5'
const URI = `gfs://main/${RID}`
const FOLDER = resolvedDirectory(RID, 'test-subscription')

type ServiceState = {
  sessionToken: string | null
  me: { id: string } | null
  gfsAuthEpoch: number
  gfsDispatchBlocked: boolean
}

// The real AppService GfsClient + real httpClient transport run against this
// endpoint, so both the resolved resource and the failure (an ApiError wrapped
// in GfsUriError) come from the actual producer.
let server: Server
let originalBaseUrl: string
let requests: IncomingMessage[] = []
let respond: { status: number; body: unknown } = { status: 200, body: { ok: true, data: FOLDER } }
let onRequest: () => void = () => {}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req)
    onRequest()
    res.writeHead(respond.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(respond.body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  originalBaseUrl = config.externalRestApiBaseUrl
  config.externalRestApiBaseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  config.externalRestApiBaseUrl = originalBaseUrl
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
  requests = []
  respond = { status: 200, body: { ok: true, data: FOLDER } }
  onRequest = () => {}
})

function activeService(): AppService & ServiceState {
  const service = new AppService() as unknown as AppService & ServiceState
  service.sessionToken = 'fixture-session-token'
  service.me = { id: 'user-a' }
  service.gfsAuthEpoch = 4
  service.gfsDispatchBlocked = false
  return service
}

describe('AppService.resolveGfsUriForNavigation (S-10)', () => {
  it('resolves through the real GFS client when the authority is unchanged', async () => {
    const service = activeService()

    const result = await service.resolveGfsUriForNavigation(URI)

    expect(result).toEqual({ status: 'resolved', resource: FOLDER })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.authorization).toBe('Bearer fixture-session-token')
  })

  it('is superseded when the GFS auth epoch advances during the resolve', async () => {
    const service = activeService()
    onRequest = () => {
      service.gfsAuthEpoch += 1
    }

    await expect(service.resolveGfsUriForNavigation(URI)).resolves.toEqual({
      status: 'superseded',
    })
    expect(requests).toHaveLength(1)
  })

  it('is superseded when the signed-in user changes during the resolve', async () => {
    const service = activeService()
    onRequest = () => {
      service.me = { id: 'user-b' }
    }

    await expect(service.resolveGfsUriForNavigation(URI)).resolves.toEqual({
      status: 'superseded',
    })
    expect(requests).toHaveLength(1)
  })

  it('is superseded when the session token is gone on return', async () => {
    const service = activeService()
    onRequest = () => {
      service.sessionToken = null
    }

    await expect(service.resolveGfsUriForNavigation(URI)).resolves.toEqual({
      status: 'superseded',
    })
    expect(requests).toHaveLength(1)
  })

  it('stays resolved across a transient team hop that swaps only the token', async () => {
    const service = activeService()
    onRequest = () => {
      service.sessionToken = 'fixture-team-hop-token'
    }

    await expect(service.resolveGfsUriForNavigation(URI)).resolves.toEqual({
      status: 'resolved',
      resource: FOLDER,
    })
    expect(requests).toHaveLength(1)
  })

  it('is unavailable when the real client rejects with a GfsUriError', async () => {
    const service = activeService()
    respond = { status: 404, body: { ok: false, error: { code: 'not_found', message: 'nope' } } }
    const { GfsClient, GfsUriError } = await import('../gfs/uriHandler.js')
    const { requestJson } = await import('../httpClient.js')
    const producerError = await new GfsClient({
      baseUrl: config.externalRestApiBaseUrl,
      requestJson,
      fetchBytes: async () => new ArrayBuffer(0),
    })
      .resolveUri(URI, 'fixture-session-token')
      .catch((error: unknown) => error)
    // Guards the premise: the producer really rejects this endpoint with the
    // wrapped error shape the method has to absorb.
    expect(producerError).toBeInstanceOf(GfsUriError)
    expect((producerError as Error).cause).toBeInstanceOf(Error)
    requests = []

    await expect(service.resolveGfsUriForNavigation(URI)).resolves.toEqual({
      status: 'unavailable',
    })
    expect(requests).toHaveLength(1)
  })

  it('is superseded, not unavailable, when the resolve fails after the epoch moved', async () => {
    const service = activeService()
    respond = { status: 404, body: { ok: false, error: { code: 'not_found', message: 'nope' } } }
    onRequest = () => {
      service.gfsAuthEpoch += 1
    }

    await expect(service.resolveGfsUriForNavigation(URI)).resolves.toEqual({
      status: 'superseded',
    })
    expect(requests).toHaveLength(1)
  })

  it.each([
    ['me is null (restore in progress)', (s: ServiceState) => (s.me = null)],
    ['GFS dispatch is blocked', (s: ServiceState) => (s.gfsDispatchBlocked = true)],
    ['there is no session token', (s: ServiceState) => (s.sessionToken = null)],
  ])('is superseded without any network call when %s at entry', async (_label, mutate) => {
    const control = activeService()
    await expect(control.resolveGfsUriForNavigation(URI)).resolves.toMatchObject({
      status: 'resolved',
    })
    expect(requests).toHaveLength(1)
    requests = []

    const service = activeService()
    mutate(service)

    await expect(service.resolveGfsUriForNavigation(URI)).resolves.toEqual({
      status: 'superseded',
    })
    expect(requests).toHaveLength(0)
  })
})
