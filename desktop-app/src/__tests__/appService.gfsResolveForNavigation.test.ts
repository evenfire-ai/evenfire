import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { testSessionMe, testTeamSwitchResult } from '../../testSupport/authTestFixtures.js'
import { resolvedDirectory } from '../../ui/src/gfs/__fixtures__/gfsProducerFixtures.js'
import { AppService } from '../appService.js'
import { AuthClient } from '../authClient.js'
import { config } from '../config.js'
import type { SessionMe } from '../types.js'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

const RID = '859df99de46b407bb0ec4b0f7cb424a5'
const URI = `gfs://main/${RID}`
const FOLDER = resolvedDirectory(RID, 'test-subscription')
const RESOLVE_PATH = '/api/v1/me/gfs/resolve'

const tokenFor = (teamId: string) => `fixture-session-${teamId}`
const meFor = (teamId: string): SessionMe =>
  testSessionMe({ teamId, teamName: teamId.toUpperCase() })
// A session of a different user on the same team, answered by the same `/me` route.
const OTHER_USER_TOKEN = 'fixture-other-user-session'
const OTHER_USER_ME: SessionMe = testSessionMe({
  id: 'user-b',
  email: 'user-b@example.test',
  name: 'User B',
  teamId: 'team-a',
  teamName: 'TEAM-A',
})

type ServiceState = {
  sessionToken: string | null
  me: SessionMe | null
  gfsAuthEpoch: number
  gfsDispatchBlocked: boolean
  tokenStore: unknown
  desktopGfsUploadStatePath: () => Promise<string>
  activateGfsAuthScope: () => void
  runWithTeamContext<T>(teamId: string, op: (token: string) => Promise<T>): Promise<T>
}
// A plain intersection with AppService collapses to `never` because some of
// these members are private there; only the public methods under test are kept.
type TestService = ServiceState &
  Pick<AppService, 'resolveGfsUriForNavigation' | 'logout' | 'switchTeam'>

// One local endpoint stands in for external-rest-api. The real AppService
// GfsClient and the real AuthClient both talk to it over the real httpClient
// transport, so the resolved resource, the GFS failure (an ApiError wrapped in
// GfsUriError) and the session/team-switch answers all go through the actual
// client code. The `/me` and switch-team bodies come from the shared auth test
// fixtures typed as `SessionMe` and the switch result: their producer is
// control-api, which this suite cannot stand up.
let server: Server
let originalBaseUrl: string
let requests: IncomingMessage[] = []
let authRequests: string[] = []
let respond: { status: number; body: unknown } = { status: 200, body: { ok: true, data: FOLDER } }
// Runs before the resolve response is written, so a flow started here (and
// awaited when it must complete first) lands inside the in-flight resolve.
let onRequest: () => void | Promise<void> = () => {}
let stateDir: string

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  return raw
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://local').pathname
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (pathname === RESOLVE_PATH) {
      requests.push(req)
      await onRequest()
      send(respond.status, respond.body)
      return
    }
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (pathname === '/api/v1/me' && req.method === 'GET' && bearer === OTHER_USER_TOKEN) {
      authRequests.push('me:other-user')
      send(200, OTHER_USER_ME)
      return
    }
    const teamId = bearer.startsWith('fixture-session-')
      ? bearer.slice('fixture-session-'.length)
      : ''
    if (pathname === '/api/v1/me' && req.method === 'GET' && teamId) {
      authRequests.push(`me:${teamId}`)
      send(200, meFor(teamId))
      return
    }
    if (pathname === '/api/v1/me/switch-team' && req.method === 'POST' && teamId) {
      const target = String((JSON.parse(await readBody(req)) as { teamId?: unknown }).teamId)
      authRequests.push(`switch:${teamId}->${target}`)
      send(200, testTeamSwitchResult(target, tokenFor(target)))
      return
    }
    send(404, { ok: false, error: { code: 'not_found', message: `unrouted ${pathname}` } })
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

beforeEach(async () => {
  requests = []
  authRequests = []
  respond = { status: 200, body: { ok: true, data: FOLDER } }
  onRequest = () => {}
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gfs-resolve-navigation-'))
})

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true })
})

/** Signed in on team-a, with the GFS scope activated by the real activation step. */
function activeService(): TestService {
  const service = new AppService() as unknown as TestService
  // Keychain and the upload-state file are the only edges replaced.
  service.tokenStore = {
    setSessionToken: vi.fn().mockResolvedValue(undefined),
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    getSessionToken: vi.fn().mockResolvedValue(null),
  }
  service.desktopGfsUploadStatePath = async () => path.join(stateDir, 'gfs-upload-sessions.json')
  service.sessionToken = tokenFor('team-a')
  service.me = meFor('team-a')
  service.activateGfsAuthScope()
  return service
}

describe('AppService.resolveGfsUriForNavigation (S-10)', () => {
  it('resolves through the real GFS client when the authority is unchanged', async () => {
    const service = activeService()

    const result = await service.resolveGfsUriForNavigation(URI)

    expect(result).toEqual({ status: 'resolved', resource: FOLDER })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${tokenFor('team-a')}`)
  })

  describe('across a transient team hop', () => {
    it('stays resolved when the hop completes and restores the home team before the resolve returns', async () => {
      const service = activeService()
      const during: { token?: string | null; teamId?: string | null } = {}
      onRequest = async () => {
        await service.runWithTeamContext('team-b', async token => {
          during.token = token
          during.teamId = (service.me as SessionMe).teamId
        })
      }

      const result = await service.resolveGfsUriForNavigation(URI)

      // Liveness witness: the hop really installed team-b's token and principal
      // through the real switch, and restored team-a afterwards.
      expect(during).toEqual({ token: tokenFor('team-b'), teamId: 'team-b' })
      expect(authRequests).toEqual([
        'switch:team-a->team-b',
        'me:team-b',
        'switch:team-b->team-a',
        'me:team-a',
      ])
      expect(service.sessionToken).toBe(tokenFor('team-a'))
      expect(result).toEqual({ status: 'resolved', resource: FOLDER })
      expect(requests).toHaveLength(1)
    })

    it('stays resolved when the resolve returns while the hop token is still installed', async () => {
      const service = activeService()
      let releaseOperation!: () => void
      const operationReleased = new Promise<void>(resolve => {
        releaseOperation = resolve
      })
      let hop: Promise<void> | undefined
      const atReturn: { token?: string | null; teamId?: string | null } = {}
      onRequest = async () => {
        await new Promise<void>(entered => {
          hop = service.runWithTeamContext('team-b', async () => {
            entered()
            await operationReleased
          })
        })
        atReturn.token = service.sessionToken
        atReturn.teamId = (service.me as SessionMe).teamId
      }

      const result = await service.resolveGfsUriForNavigation(URI)
      releaseOperation()
      await hop

      // Liveness witness: the resolve answered while team-b's token was the
      // session token, and the hop restored team-a only after the verdict.
      expect(atReturn).toEqual({ token: tokenFor('team-b'), teamId: 'team-b' })
      expect(service.sessionToken).toBe(tokenFor('team-a'))
      expect(result).toEqual({ status: 'resolved', resource: FOLDER })
      expect(requests).toHaveLength(1)
    })
  })

  it('is superseded when the user logs out during the resolve', async () => {
    const service = activeService()
    onRequest = async () => {
      await service.logout()
    }

    const result = await service.resolveGfsUriForNavigation(URI)

    // Liveness witness: the real logout ran to the end.
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    expect(result).toEqual({ status: 'superseded' })
    expect(requests).toHaveLength(1)
  })

  // A deliberate switch keeps `me.id` but opens a new GFS scope (new epoch);
  // the renderer also keys its session by team, so the click is dropped.
  it('is superseded when the user deliberately switches team during the resolve', async () => {
    const service = activeService()
    onRequest = async () => {
      await service.switchTeam('team-b')
    }

    const result = await service.resolveGfsUriForNavigation(URI)

    // Liveness witness: the switch committed, and the user is the same one.
    expect(service.sessionToken).toBe(tokenFor('team-b'))
    expect(service.me).toMatchObject({ id: 'user-a', teamId: 'team-b' })
    expect(result).toEqual({ status: 'superseded' })
    expect(requests).toHaveLength(1)
  })

  it('is superseded, not unavailable, when the resolve fails after a deliberate team switch', async () => {
    const service = activeService()
    respond = { status: 404, body: { ok: false, error: { code: 'not_found', message: 'nope' } } }
    onRequest = async () => {
      await service.switchTeam('team-b')
    }

    const result = await service.resolveGfsUriForNavigation(URI)

    expect(service.me).toMatchObject({ id: 'user-a', teamId: 'team-b' })
    expect(result).toEqual({ status: 'superseded' })
    expect(requests).toHaveLength(1)
  })

  // These clauses of the fence are set by hand because no real flow changes
  // them on their own: every flow that replaces the user or drops the token
  // also advances the epoch, which would mask a missing clause.
  it.each([
    [
      'the signed-in user changes',
      async (s: ServiceState) => {
        // The other user's principal as the real AuthClient reads it from `/me`.
        s.me = await new AuthClient().getMe(OTHER_USER_TOKEN)
        expect(s.me).toEqual(OTHER_USER_ME)
      },
    ],
    [
      'the session token is gone on return',
      (s: ServiceState) => {
        s.sessionToken = null
      },
    ],
  ])('is superseded when %s during the resolve', async (_label, mutate) => {
    const service = activeService()
    onRequest = () => mutate(service)

    await expect(service.resolveGfsUriForNavigation(URI)).resolves.toEqual({
      status: 'superseded',
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
      .resolveUri(URI, tokenFor('team-a'))
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

  it('logs a malformed-URI failure without echoing the URI into the log', async () => {
    const service = activeService()
    const hostile = 'gfs://main\r\n[AppService] forged line'
    const { parseGfsUri, GfsUriError } = await import('../gfs/uriHandler.js')
    // Guards the premise: the real parser rejects this URI with a message that
    // carries the raw CR/LF, which is what a verbatim log would replay.
    let parserError: unknown
    try {
      parseGfsUri(hostile)
    } catch (error) {
      parserError = error
    }
    expect(parserError).toBeInstanceOf(GfsUriError)
    expect((parserError as Error).message).toContain('\r\n[AppService] forged line')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(service.resolveGfsUriForNavigation(hostile)).resolves.toEqual({
        status: 'unavailable',
      })
      expect(warn).toHaveBeenCalledTimes(1)
      const logged = warn.mock.calls[0]!.map(String).join(' ')
      expect(logged).toContain('GFS navigation resolve failed')
      expect(logged).not.toMatch(/[\r\n]/)
      expect(logged).not.toContain('forged line')
    } finally {
      warn.mockRestore()
    }
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
