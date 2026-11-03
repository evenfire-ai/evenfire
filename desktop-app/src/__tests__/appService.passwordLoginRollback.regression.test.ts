import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const fixture = vi.hoisted(() => ({
  directory: '',
  loginCount: 0,
  chatBindCount: 0,
  activeChatUserId: null as string | null,
  candidateBindingError: null as Error | null,
  candidatePublicationReservationLost: false,
  getMeTokens: [] as string[],
  keychain: new Map<string, string>(),
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}))

const userA = {
  id: 'password-rollback-user-a',
  email: 'a@example.test',
  name: null,
  picture: null,
  teamId: 'password-rollback-team-a',
  teamName: 'Team A',
  role: 'member',
}
const userB = { ...userA, id: 'password-rollback-user-b', email: 'b@example.test' }

function sessionToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 60 * 60 })
  ).toString('base64url')
  return `header.${payload}.signature`
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const tokenA = sessionToken(userA.id)
const tokenB = sessionToken(userB.id)
const keyOf = (service: string, account: string) => `${service}::${account}`

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fixture.directory), isReady: vi.fn(() => true) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  shell: { openExternal: vi.fn() },
}))
vi.mock('keytar', () => fixture)
vi.mock('../windowsSessionAuthorityAcl.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityAcl.js')>()
  const { createWindowsSessionAuthorityAclUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityAclUnitFixture.js')
  return createWindowsSessionAuthorityAclUnitFixture(actual)
})
vi.mock('../windowsSessionAuthorityFileOps.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityFileOps.js')>()
  const { createWindowsSessionAuthorityFileOpsUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityFileOpsUnitFixture.js')
  return createWindowsSessionAuthorityFileOpsUnitFixture(actual)
})
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(async (userId: string) => {
    fixture.activeChatUserId = userId
  }),
  prepareChatStoreBindingForUser: vi.fn(async (userId: string) => {
    fixture.chatBindCount += 1
    if (userId === userB.id && fixture.candidateBindingError) throw fixture.candidateBindingError
    return {
      canPublish: () => true,
      reservePublication: () =>
        userId === userB.id && fixture.candidatePublicationReservationLost
          ? null
          : () => {
              fixture.activeChatUserId = userId
              return 3
            },
      afterPublication: vi.fn(),
      discard: vi.fn(),
    }
  }),
  requireChatStore: vi.fn(() => {
    if (!fixture.activeChatUserId) throw new Error('Not authenticated')
    return {
      userId: fixture.activeChatUserId,
      getAuthorityScope: () => ({
        environmentKey: 'password-rollback-env',
        userId: fixture.activeChatUserId!,
        teamId: userA.teamId,
      }),
    }
  }),
  unbindChatStore: vi.fn(() => {
    fixture.activeChatUserId = null
  }),
}))
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({
    notifySessionChanged: vi.fn(),
    unpinAllSandboxUiSurfaces: vi.fn(),
  }),
}))

describe('R23-H1 public password-login rollback', () => {
  let directory = ''
  let originalRestUrl: string | undefined
  let originalRpcUrl: string | undefined
  let AppService: typeof import('../appService.js').AppService
  let TokenStore: typeof import('../tokenStore.js').TokenStore

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    fixture.loginCount = 0
    fixture.chatBindCount = 0
    fixture.activeChatUserId = null
    fixture.candidateBindingError = new Error('synthetic candidate chat preparation failure')
    fixture.candidatePublicationReservationLost = false
    fixture.getMeTokens = []
    fixture.keychain.clear()
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-password-rollback-'))
    fixture.directory = directory
    originalRestUrl = process.env.EXTERNAL_REST_API_BASE_URL
    originalRpcUrl = process.env.RPC_PROXY_BASE_URL
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://rest.password-rollback.test'
    process.env.RPC_PROXY_BASE_URL = 'http://rpc.password-rollback.test'
    fixture.getPassword.mockImplementation(
      async (service: string, account: string) =>
        fixture.keychain.get(keyOf(service, account)) ?? null
    )
    fixture.setPassword.mockImplementation(
      async (service: string, account: string, token: string) => {
        fixture.keychain.set(keyOf(service, account), token)
      }
    )
    fixture.deletePassword.mockImplementation(async (service: string, account: string) =>
      fixture.keychain.delete(keyOf(service, account))
    )
    const [{ AppService: appServiceClass }, { TokenStore: tokenStoreClass }] = await Promise.all([
      import('../appService.js'),
      import('../tokenStore.js'),
    ])
    AppService = appServiceClass
    TokenStore = tokenStoreClass
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (directory) await fs.rm(directory, { recursive: true, force: true })
    if (originalRestUrl === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
    else process.env.EXTERNAL_REST_API_BASE_URL = originalRestUrl
    if (originalRpcUrl === undefined) delete process.env.RPC_PROXY_BASE_URL
    else process.env.RPC_PROXY_BASE_URL = originalRpcUrl
    fixture.directory = ''
    fixture.keychain.clear()
    vi.resetModules()
  })

  function createService(options: { isolated?: boolean } = {}) {
    const service = new AppService({
      tokenStore: new TokenStore(options.isolated ? { isolatedUserDataPath: directory } : {}),
      getUserDataDirectory: () => directory,
    })
    vi.spyOn(service as never, 'resolveRuntimeConfigIfNeeded' as never).mockResolvedValue(
      undefined as never
    )
    return service
  }

  it('restores the accepted prior source when candidate preparation fails after publication', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        fixture.loginCount += 1
        const result =
          fixture.loginCount === 1 ? { token: tokenA, me: userA } : { token: tokenB, me: userB }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/v1/me')) {
        const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
        fixture.getMeTokens.push(token)
        const me = token === tokenA ? userA : token === tokenB ? userB : null
        return new Response(JSON.stringify(me), {
          status: me ? 200 : 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected HTTP request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    await expect(service.passwordLogin(userA.email, 'synthetic-password-a')).resolves.toMatchObject(
      {
        authenticated: true,
        me: userA,
      }
    )
    const [{ getActiveEnvKey }, { readSessionAuthoritySourceSelection }] = await Promise.all([
      import('../config.js'),
      import('../sessionAuthorityAcceptance.js'),
    ])
    const acceptedBeforeReplacement = await readSessionAuthoritySourceSelection({
      tokenStore: new TokenStore(),
      envKey: getActiveEnvKey(),
    })
    expect(acceptedBeforeReplacement.status).toBe('accepted')
    if (acceptedBeforeReplacement.status !== 'accepted')
      throw new Error('The password producer did not select the accepted source')
    expect(acceptedBeforeReplacement.session.token).toBe(tokenA)
    expect(acceptedBeforeReplacement.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: userA.id,
    })

    await expect(service.passwordLogin(userB.email, 'synthetic-password-b')).rejects.toThrow(
      'synthetic candidate chat preparation failure'
    )

    expect(service.getCachedUserId()).toBe(userA.id)
    const acceptedAfterRejection = await readSessionAuthoritySourceSelection({
      tokenStore: new TokenStore(),
      envKey: getActiveEnvKey(),
    })
    expect(acceptedAfterRejection.status).toBe('accepted')
    if (acceptedAfterRejection.status !== 'accepted')
      throw new Error('Rejected replacement removed the prior accepted source')
    expect(acceptedAfterRejection.session.token).toBe(tokenA)
    expect(acceptedAfterRejection.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: userA.id,
    })

    const restarted = createService()
    const requestsBeforeRestart = fixture.getMeTokens.length
    await expect(restarted.initialize()).resolves.toMatchObject({
      authenticated: true,
      me: userA,
    })
    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).toEqual([tokenA])
    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).not.toContain(tokenB)
    expect(restarted.getCachedUserId()).toBe(userA.id)
  })

  it('never persists a rejected password replacement over a prior memory-only bearer', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        fixture.loginCount += 1
        const result =
          fixture.loginCount === 1 ? { token: tokenA, me: userA } : { token: tokenB, me: userB }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/v1/me')) {
        const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
        fixture.getMeTokens.push(token)
        const me = token === tokenA ? userA : token === tokenB ? userB : null
        return new Response(JSON.stringify(me), {
          status: me ? 200 : 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected HTTP request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    fixture.getPassword.mockRejectedValue(
      Object.assign(new Error('fixture Keytar access denied'), { code: 'EACCES' })
    )

    const service = createService({ isolated: true })
    await expect(service.passwordLogin(userA.email, 'synthetic-password-a')).resolves.toMatchObject(
      {
        authenticated: true,
        me: userA,
        sessionMode: 'temporary',
      }
    )
    expect([...fixture.keychain.values()]).not.toContain(tokenA)

    await expect(service.passwordLogin(userB.email, 'synthetic-password-b')).rejects.toThrow(
      'synthetic candidate chat preparation failure'
    )
    expect([...fixture.keychain.values()]).not.toContain(tokenA)
    expect([...fixture.keychain.values()]).not.toContain(tokenB)

    const restarted = createService()
    const requestsBeforeRestart = fixture.getMeTokens.length
    await expect(restarted.initialize()).resolves.toMatchObject({
      authenticated: false,
      me: null,
    })
    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).not.toContain(tokenA)
    expect(restarted.getCachedUserId()).toBeNull()
  })

  it('does not restore prior A while another producer still denies A in the journal', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        fixture.loginCount += 1
        const result =
          fixture.loginCount === 1 ? { token: tokenA, me: userA } : { token: tokenB, me: userB }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/v1/me')) {
        const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
        fixture.getMeTokens.push(token)
        const me = token === tokenA ? userA : token === tokenB ? userB : null
        return new Response(JSON.stringify(me), {
          status: me ? 200 : 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected HTTP request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    await expect(service.passwordLogin(userA.email, 'synthetic-password-a')).resolves.toMatchObject(
      {
        authenticated: true,
        me: userA,
      }
    )

    const binding = await import('../chatStoreBinding.js')
    const journal = await import('../sessionPersistenceJournal.js')
    const config = await import('../config.js')
    let denialAdded = false
    vi.mocked(binding.prepareChatStoreBindingForUser).mockImplementationOnce(async () => {
      // A second, real producer creates an independent denial after B's own
      // candidate denial is retired but before rollback can publish A.
      const otherProducer = new journal.SessionPersistenceProducer(
        directory,
        config.getActiveEnvKey(),
        null,
        () => {},
        () => {}
      )
      otherProducer.prepare('keytar', tokenA)
      denialAdded = true
      return {
        canPublish: () => true,
        reservePublication: () => () => 9,
        discard: vi.fn(),
      }
    })

    await expect(service.passwordLogin(userB.email, 'synthetic-password-b')).rejects.toThrow(
      'Session authority transaction no longer owns the observed frame'
    )
    expect(denialAdded).toBe(true)
    expect(service.getCachedUserId()).toBeNull()
    const { readSessionPersistenceJournal, isSessionPersistenceCandidateDenied } =
      await import('../sessionPersistenceJournal.js')
    expect(
      isSessionPersistenceCandidateDenied(
        readSessionPersistenceJournal(directory, config.getActiveEnvKey()),
        tokenA
      )
    ).toBe(true)
    expect([...fixture.keychain.values()]).not.toContain(tokenB)

    const restarted = createService()
    const beforeRestart = fixture.getMeTokens.length
    await expect(restarted.initialize()).resolves.toMatchObject({
      authenticated: false,
      me: null,
    })
    expect(fixture.getMeTokens.slice(beforeRestart)).not.toContain(tokenA)
    expect(fixture.getMeTokens.slice(beforeRestart)).not.toContain(tokenB)
  })

  it('does not restore GFS or Home after logout-pending wins a delayed login authority read', async () => {
    const gfsRequestTokens: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        fixture.loginCount += 1
        const result =
          fixture.loginCount === 1 ? { token: tokenA, me: userA } : { token: tokenB, me: userB }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/v1/me/gfs/')) {
        gfsRequestTokens.push(
          new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
        )
        return new Response(JSON.stringify({ error: 'synthetic GFS denial' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/v1/me')) {
        const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
        fixture.getMeTokens.push(token)
        const me = token === tokenA ? userA : token === tokenB ? userB : null
        return new Response(JSON.stringify(me), {
          status: me ? 200 : 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected HTTP request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    await expect(service.passwordLogin(userA.email, 'synthetic-password-a')).resolves.toMatchObject(
      {
        authenticated: true,
        me: userA,
      }
    )
    // This scenario must reach authenticated-consumer suspension before LP supersedes the
    // replacement. The default fixture rejection happens during chat preparation and would
    // leave the GFS rollback assertion unexercised.
    fixture.candidateBindingError = null
    const gfsFilePath = path.join(directory, 'synthetic-upload.txt')
    await fs.writeFile(gfsFilePath, 'synthetic upload body')
    const serviceWithPrivateGfs = service as unknown as {
      activateGfsAuthScope: (identity?: unknown) => void
      suspendDesktopGfsUploadsForAuthBoundary: (identity?: unknown) => Promise<void>
    }
    const activateGfsAuthScope = serviceWithPrivateGfs.activateGfsAuthScope.bind(service)
    const gfsSuspension = vi.spyOn(serviceWithPrivateGfs, 'suspendDesktopGfsUploadsForAuthBoundary')
    let markerReadFailureInjected = false
    let gfsAttempt: Promise<{ error: unknown } | { value: unknown }> | undefined
    let staleGfsReactivationCount = 0
    vi.spyOn(serviceWithPrivateGfs, 'activateGfsAuthScope').mockImplementation(identity => {
      activateGfsAuthScope(identity)
      if (markerReadFailureInjected && !gfsAttempt) {
        staleGfsReactivationCount += 1
        // Attempt the actual public GFS producer synchronously at the moment
        // stale rollback reopens its scope, before control returns to recovery.
        gfsAttempt = service
          .startGfsFileUpload('synthetic-parent', 'synthetic-upload.txt', gfsFilePath)
          .then(
            value => ({ value }),
            error => ({ error })
          )
      }
    })

    const tokenStore = (
      service as unknown as {
        tokenStore: { verifiedStorageBase: () => Promise<string> }
      }
    ).tokenStore
    const enteredInspection = deferred()
    const releaseInspection = deferred()
    const verifiedStorageBase = tokenStore.verifiedStorageBase.bind(tokenStore)
    vi.spyOn(tokenStore, 'verifiedStorageBase').mockImplementation(async () => {
      const storageBase = await verifiedStorageBase()
      enteredInspection.resolve()
      await releaseInspection.promise
      return storageBase
    })

    const replacing = service.passwordLogin(userB.email, 'synthetic-password-b').then(
      value => ({ value }),
      error => ({ error })
    )
    let quitPreparation: Promise<void> | undefined
    let restoreOpen: (() => void) | undefined
    try {
      await enteredInspection.promise
      quitPreparation = service.prepareForQuit()
      await expect(service.logout()).resolves.toMatchObject({
        kind: 'not-committed',
        reason: 'deferred',
      })

      const [{ getActiveEnvKey }, { readPendingExternalLogoutMarker }] = await Promise.all([
        import('../config.js'),
        import('../pendingExternalLogout.js'),
      ])
      const envKey = getActiveEnvKey()
      expect(readPendingExternalLogoutMarker(directory, envKey)?.intent.intent).toBe(
        'logout-pending'
      )

      const open = fsSync.openSync.bind(fsSync)
      const markerPrefix = path.join(directory, 'pending-external-logout-')
      const markerReadSpy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
        if (!markerReadFailureInjected && String(file).startsWith(markerPrefix)) {
          markerReadFailureInjected = true
          throw Object.assign(new Error('fixture transient marker observation'), { code: 'EMFILE' })
        }
        return open(file, flags, mode)
      })
      restoreOpen = () => markerReadSpy.mockRestore()
      releaseInspection.resolve()

      const replacement = await replacing
      expect('error' in replacement).toBe(true)
      // Both the replacement producer and logout fence the same accepted owner. The second
      // suspension is intentional; it must not reopen the stale owner's GFS scope.
      expect(gfsSuspension).toHaveBeenCalledTimes(2)
      expect(markerReadFailureInjected).toBe(true)
      expect(staleGfsReactivationCount).toBe(0)
      expect(gfsAttempt).toBeUndefined()
      expect(gfsRequestTokens).toEqual([])
      await expect(service.listGfsUploadSessions()).rejects.toThrow(
        'GFS upload dispatch is unavailable without an active authenticated scope'
      )
      expect(service.getCachedUserId()).toBeNull()
      const chatBinding = await import('../chatStoreBinding.js')
      expect(() => chatBinding.requireChatStore()).toThrow('Not authenticated')
      const authClient = (
        service as unknown as {
          authClient: { issueRpcToken: (...args: never[]) => Promise<unknown> }
        }
      ).authClient
      const issueRpcToken = vi.spyOn(authClient, 'issueRpcToken')
      await expect(service.listAccessibleMcpServers(['synthetic-host'])).rejects.toThrow(
        'Not authenticated'
      )
      expect(issueRpcToken).not.toHaveBeenCalled()

      const restarted = createService()
      const beforeRestart = fixture.getMeTokens.length
      await expect(restarted.initialize()).resolves.toMatchObject({
        authenticated: false,
        me: null,
      })
      expect(fixture.getMeTokens.slice(beforeRestart)).not.toContain(tokenA)
      expect(fixture.getMeTokens.slice(beforeRestart)).not.toContain(tokenB)
      expect(readPendingExternalLogoutMarker(directory, envKey)?.intent.intent).toBe(
        'logout-pending'
      )
    } finally {
      releaseInspection.resolve()
      restoreOpen?.()
      await replacing
      if (quitPreparation) await quitPreparation
    }
  })

  it('revalidates LP synchronously after prior-owner rollback preflight', async () => {
    const gfsRequestTokens: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/v2/password-login')) {
        fixture.loginCount += 1
        const result =
          fixture.loginCount === 1 ? { token: tokenA, me: userA } : { token: tokenB, me: userB }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/v1/me/gfs/')) {
        gfsRequestTokens.push(
          new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
        )
        return new Response(JSON.stringify({ error: 'synthetic GFS denial' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/v1/me')) {
        const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
        fixture.getMeTokens.push(token)
        const me = token === tokenA ? userA : token === tokenB ? userB : null
        return new Response(JSON.stringify(me), {
          status: me ? 200 : 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected HTTP request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = createService()
    await expect(service.passwordLogin(userA.email, 'synthetic-password-a')).resolves.toMatchObject(
      {
        authenticated: true,
        me: userA,
      }
    )
    const secondService = createService()
    await expect(secondService.initialize()).resolves.toMatchObject({
      authenticated: true,
      me: userA,
    })
    fixture.candidateBindingError = null
    fixture.candidatePublicationReservationLost = true

    const { SessionAuthorityAcceptanceTransaction } =
      await import('../sessionAuthorityAcceptance.js')
    type RollbackPreflight = {
      authorizePriorConsumerRollback(assertOwned: () => void | Promise<void>): Promise<boolean>
    }
    const prototype =
      SessionAuthorityAcceptanceTransaction.prototype as unknown as RollbackPreflight
    const originalPreflight = prototype.authorizePriorConsumerRollback
    let competingLogout: Awaited<ReturnType<typeof secondService.logout>> | undefined
    vi.spyOn(prototype, 'authorizePriorConsumerRollback').mockImplementation(async function (
      this: RollbackPreflight,
      assertOwned
    ) {
      const priorOwnerWasCurrent = await originalPreflight.call(this, assertOwned)
      expect(priorOwnerWasCurrent).toBe(true)
      competingLogout = await secondService.logout()
      return priorOwnerWasCurrent
    })

    const gfsFilePath = path.join(directory, 'synthetic-upload-after-lp.txt')
    await fs.writeFile(gfsFilePath, 'synthetic upload body')
    const internal = service as unknown as {
      activateGfsAuthScope: (identity?: unknown) => void
    }
    const activateGfsAuthScope = internal.activateGfsAuthScope.bind(service)
    const suspendGfs = vi.spyOn(service, 'suspendDesktopGfsUploadsForAuthBoundary')
    let staleGfsReactivationCount = 0
    let gfsAttempt: Promise<unknown> | undefined
    vi.spyOn(internal, 'activateGfsAuthScope').mockImplementation(identity => {
      activateGfsAuthScope(identity)
      staleGfsReactivationCount += 1
      gfsAttempt = service.startGfsFileUpload(
        'synthetic-parent',
        'synthetic-upload-after-lp.txt',
        gfsFilePath
      )
    })

    await expect(service.passwordLogin(userB.email, 'synthetic-password-b')).rejects.toThrow(
      'Session-token mutation was superseded before storage dispatch'
    )
    expect(suspendGfs).toHaveBeenCalledOnce()
    if (gfsAttempt) await gfsAttempt.catch(() => undefined)

    expect(competingLogout).toMatchObject({ kind: 'committed' })
    expect(staleGfsReactivationCount).toBe(0)
    expect(gfsRequestTokens).toEqual([])
    expect(service.getCachedUserId()).toBeNull()
    await expect(service.listGfsUploadSessions()).rejects.toThrow(
      'GFS upload dispatch is unavailable without an active authenticated scope'
    )
    const { requireChatStore } = await import('../chatStoreBinding.js')
    expect(() => requireChatStore()).toThrow('Not authenticated')
    const authClient = (
      service as unknown as {
        authClient: { issueRpcToken: (...args: never[]) => Promise<unknown> }
      }
    ).authClient
    const issueRpcToken = vi.spyOn(authClient, 'issueRpcToken')
    await expect(service.listAccessibleMcpServers(['synthetic-host'])).rejects.toThrow(
      'Not authenticated'
    )
    expect(issueRpcToken).not.toHaveBeenCalled()

    const restarted = createService()
    const requestsBeforeRestart = fixture.getMeTokens.length
    await expect(restarted.initialize()).resolves.toMatchObject({
      authenticated: false,
      me: null,
    })
    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).not.toContain(tokenA)
    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).not.toContain(tokenB)
  })
})
