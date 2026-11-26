import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pushedBrowserSignInSnapshots } from '../../testSupport/browserSignInHarness.js'
import { LOGIN_SCREEN_ROWS } from '../../testSupport/edgeContractRecords.js'
import type { AppService } from '../appService.js'
import { buildLoginMethodsModel } from '../browserSignInModel.js'
import type { BrowserSignInSnapshot, LoginMethodsAnswer } from '../types.js'

/**
 * The browser sign-in IPC surface (design §10.1, §13): five invoke channels and one event, each
 * handler behind `assertTrustedSender`, the preload members that reach them, and none of the
 * service's test-only seams, there or in `main.ts`.
 */

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off },
  webUtils: { getPathForFile: vi.fn() },
}))
vi.mock('../appService.js', () => ({ AppService: class {} }))

const CHANNELS = [
  'auth:getLoginMethods',
  'auth:startBrowserSignIn',
  'auth:cancelBrowserSignIn',
  'auth:getBrowserSignInState',
  'auth:acknowledgeBrowserSignInResult',
] as const
type Channel = (typeof CHANNELS)[number]

const SERVICE_METHOD = {
  'auth:getLoginMethods': 'getLoginMethods',
  'auth:startBrowserSignIn': 'startBrowserSignIn',
  'auth:cancelBrowserSignIn': 'cancelBrowserSignIn',
  'auth:getBrowserSignInState': 'getBrowserSignInState',
  'auth:acknowledgeBrowserSignInResult': 'acknowledgeBrowserSignInResult',
} as const satisfies Record<Channel, keyof AppService>

/** The `AppService` members that exist for tests only (state model §7.3); none may cross IPC. */
const TEST_ONLY_SEAMS = [
  'getSessionPresence',
  'whenAuthCommitsSettled',
  'onSessionGenerationAdvanced',
  'browserSignInClock',
] as const

const trusted = { senderFrame: { url: 'file:///app/index.html' } }
const untrusted = { senderFrame: { url: 'https://hostile.example.test/' } }

const service = {
  getLoginMethods: vi.fn(),
  startBrowserSignIn: vi.fn(),
  cancelBrowserSignIn: vi.fn(),
  getBrowserSignInState: vi.fn(),
  acknowledgeBrowserSignInResult: vi.fn(),
}

function handler(channel: string): Handler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`${channel} handler was not registered`)
  return registered
}

/** One snapshot of each kind, as the real store pushed it. */
async function snapshotsByKind() {
  const snapshots = await pushedBrowserSignInSnapshots()
  const find = (predicate: (snapshot: BrowserSignInSnapshot) => boolean) => {
    const found = snapshots.find(predicate)
    if (!found) throw new Error('pushedBrowserSignInSnapshots lacks a snapshot this test reads')
    return found
  }
  return {
    waiting: find(snapshot => snapshot.phase === 'waiting'),
    redeeming: find(snapshot => snapshot.phase === 'redeeming'),
    failed: find(snapshot => snapshot.phase === 'ended' && snapshot.outcome === 'failed'),
    cancelled: find(snapshot => snapshot.phase === 'ended' && snapshot.outcome === 'cancelled'),
    refused: find(snapshot => snapshot.phase === 'ended' && snapshot.outcome === 'refused'),
    idle: find(snapshot => snapshot.phase === 'idle'),
  }
}

function methodsAnswer(): LoginMethodsAnswer {
  const row = LOGIN_SCREEN_ROWS.find(([label]) => label === 'password-and-oidc')
  if (!row) throw new Error('LOGIN_SCREEN_ROWS has no password-and-oidc row')
  return { model: buildLoginMethodsModel(row[1], { linksAvailable: true }), generation: 3 }
}

beforeAll(async () => {
  vi.stubEnv('EVENFIRE_RENDERER_URL', '')
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterEach(() => {
  for (const method of Object.values(service)) method.mockReset()
  electron.exposeInMainWorld.mockReset()
  electron.invoke.mockReset()
  electron.on.mockReset()
  electron.off.mockReset()
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('browser sign-in IPC handlers', () => {
  it.each(CHANNELS)('%s refuses an untrusted sender', async channel => {
    await expect(handler(channel)(untrusted, { attemptId: 1 })).rejects.toThrow(
      'Untrusted IPC sender'
    )
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()

    // The same call from the app's own renderer reaches the service.
    await handler(channel)(trusted, { attemptId: 1 })
    expect(service[SERVICE_METHOD[channel]]).toHaveBeenCalledTimes(1)
  })

  it('passes each call through', async () => {
    const snapshots = await snapshotsByKind()
    const methods = methodsAnswer()
    const started = { attemptId: snapshots.waiting.attemptId }
    service.getLoginMethods.mockResolvedValue(methods)
    service.startBrowserSignIn.mockResolvedValue(started)
    service.cancelBrowserSignIn.mockReturnValue(snapshots.cancelled)
    service.getBrowserSignInState.mockReturnValue(snapshots.redeeming)
    service.acknowledgeBrowserSignInResult.mockReturnValue(snapshots.idle)

    await expect(handler('auth:getLoginMethods')(trusted)).resolves.toBe(methods)
    // Start takes nothing from the renderer: not a sign-in URL, not an environment (D5).
    await expect(
      handler('auth:startBrowserSignIn')(trusted, {
        signInUrl: 'https://idp.example.test/desktop-login',
      })
    ).resolves.toBe(started)
    await expect(handler('auth:cancelBrowserSignIn')(trusted)).resolves.toBe(snapshots.cancelled)
    await expect(handler('auth:getBrowserSignInState')(trusted)).resolves.toBe(snapshots.redeeming)
    await expect(
      handler('auth:acknowledgeBrowserSignInResult')(trusted, { attemptId: 1 })
    ).resolves.toBe(snapshots.idle)

    expect(service.getLoginMethods.mock.calls).toEqual([[]])
    expect(service.startBrowserSignIn.mock.calls).toEqual([[]])
    expect(service.cancelBrowserSignIn.mock.calls).toEqual([[]])
    expect(service.getBrowserSignInState.mock.calls).toEqual([[]])
    expect(service.acknowledgeBrowserSignInResult.mock.calls).toEqual([[1]])
  })

  it.each([0, -1, 1.5, '1', null, undefined, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses attempt id %s',
    async attemptId => {
      await expect(
        handler('auth:acknowledgeBrowserSignInResult')(trusted, { attemptId })
      ).rejects.toThrow('Invalid browser sign-in attempt')
      expect(service.acknowledgeBrowserSignInResult).not.toHaveBeenCalled()
    }
  )
})

describe('browser sign-in preload members', () => {
  afterEach(() => {
    vi.resetModules()
  })

  async function exposedAuth(): Promise<Record<string, (...args: unknown[]) => unknown>> {
    await import('../preload.js')
    const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'clerum')?.[1]
    if (!exposed?.auth) throw new Error('preload exposed no clerum.auth')
    return exposed.auth
  }

  it('reaches each handler through its own channel, with the payload the handler reads', async () => {
    const snapshots = await snapshotsByKind()
    // The renderer's invoke reaches the main handler with the arguments it was given.
    electron.invoke.mockImplementation((channel: string, payload?: unknown) =>
      handler(channel)(trusted, payload)
    )
    service.acknowledgeBrowserSignInResult.mockReturnValue(snapshots.idle)
    const auth = await exposedAuth()

    await auth.getLoginMethods?.()
    await auth.startBrowserSignIn?.()
    await auth.cancelBrowserSignIn?.()
    await auth.getBrowserSignInState?.()
    await expect(auth.acknowledgeBrowserSignInResult?.(7)).resolves.toBe(snapshots.idle)

    expect(electron.invoke.mock.calls).toEqual([
      ['auth:getLoginMethods'],
      ['auth:startBrowserSignIn'],
      ['auth:cancelBrowserSignIn'],
      ['auth:getBrowserSignInState'],
      ['auth:acknowledgeBrowserSignInResult', { attemptId: 7 }],
    ])
    for (const channel of CHANNELS) {
      expect(service[SERVICE_METHOD[channel]]).toHaveBeenCalledTimes(1)
    }
    expect(service.acknowledgeBrowserSignInResult.mock.calls).toEqual([[7]])
  })

  it('delivers each auth:browserSignInResult snapshot to the subscriber until it unsubscribes', async () => {
    const snapshots = await pushedBrowserSignInSnapshots()
    const auth = await exposedAuth()
    const callback = vi.fn()

    const unsubscribe = auth.onBrowserSignInChanged?.(callback) as () => void
    const subscription = electron.on.mock.calls.find(
      ([channel]) => channel === 'auth:browserSignInResult'
    )
    const listener = subscription?.[1] as (event: unknown, snapshot: unknown) => void
    expect(listener).toBeTypeOf('function')
    for (const snapshot of snapshots) listener({}, snapshot)

    expect(callback.mock.calls).toEqual(snapshots.map(snapshot => [snapshot]))
    unsubscribe()
    expect(electron.off).toHaveBeenCalledWith('auth:browserSignInResult', listener)
  })
})

describe('browser sign-in test-only seams', () => {
  it('none is reachable through ipc.ts, preload.ts or main.ts', async () => {
    // `main.ts` builds the running app's `AppService`, so a seam option would be passed there.
    const sources = [
      { file: 'ipc.ts', marker: 'acknowledgeBrowserSignInResult' },
      { file: 'preload.ts', marker: 'acknowledgeBrowserSignInResult' },
      { file: 'main.ts', marker: 'browserSignInLinksAvailable' },
    ].map(({ file, marker }) => ({
      file,
      marker,
      text: readFileSync(join(__dirname, '..', file), 'utf8'),
    }))
    // The scan reads the files that carry the browser sign-in surface: each names its marker.
    for (const { file, marker, text } of sources) expect(text, file).toContain(marker)
    for (const { file, text } of sources) {
      for (const seam of TEST_ONLY_SEAMS) expect(text, `${file} names ${seam}`).not.toContain(seam)
    }

    // No registered channel and no exposed member is named after a seam, at any depth.
    const names = [...electron.handlers.keys()]
    vi.resetModules()
    await import('../preload.js')
    const collect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      for (const [key, member] of Object.entries(value)) {
        names.push(key)
        collect(member)
      }
    }
    for (const [, api] of electron.exposeInMainWorld.mock.calls) collect(api)
    expect(names).toContain('auth:acknowledgeBrowserSignInResult')
    expect(names).toContain('acknowledgeBrowserSignInResult')
    for (const seam of TEST_ONLY_SEAMS) {
      expect(names.filter(name => name.includes(seam))).toEqual([])
    }
    vi.resetModules()
  })
})
