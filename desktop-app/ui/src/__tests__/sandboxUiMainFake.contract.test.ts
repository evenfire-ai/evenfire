import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SANDBOX_UI_REFRESH_INTERVAL_MS } from '../../../src/sandboxUiSessionRefresh'
import { type SandboxUiMainFake, createSandboxUiMainFake } from './__fixtures__/sandboxUiMainFake'

vi.mock(
  'electron',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiElectronFakes')).electronModule
)
vi.mock(
  '../../../src/config',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).configModule
)
vi.mock(
  '../../../src/sandboxUiPartitionGc',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).partitionGcModule
)
vi.mock(
  '../../../src/rpcTokenManager',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks'))
      .rpcTokenManagerModule
)
vi.mock(
  '../../../src/authClient',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).authClientModule
)
vi.mock(
  '../../../src/tokenStore',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).tokenStoreModule
)

// What the App suites' sandbox-ui bridge shows the renderer, in the order the
// renderer sees it. The bridge is the real main process; these pin the parts
// of its contract the App suites lean on, so a bridge that drifted from main
// (events ahead of the replies main sent first, an open that fails after
// mounting without releasing its view, a close that names no launch) fails
// here instead of quietly passing App tests.

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const BOUNDS = { x: 0, y: 40, width: 800, height: 600 }

function openRequest(launchId: string, recipeName = 'alpha') {
  return { launchId, recipeNs: 'sandbox-recipes', recipeName, bounds: BOUNDS }
}

describe('the App suites’ sandbox-ui bridge delivers what main produces, in order', () => {
  let main: SandboxUiMainFake
  /** Everything the renderer observed, in arrival order. */
  let seen: string[]

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    main = createSandboxUiMainFake()
    seen = []
    main.bridge.onReleased(event => {
      seen.push(`released ${event.launchId} ${event.reason} ${JSON.stringify(event.location)}`)
    })
    main.bridge.onRefreshError(event => {
      seen.push(`refreshError ${event.launchId} ${event.message}`)
    })
    main.bridge.onRefreshRecovered(event => {
      seen.push(`refreshRecovered ${event.launchId} ${event.appRef}`)
    })
  })

  afterEach(async () => {
    await main.dispose()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function open(launchId: string, recipeName?: string): Promise<void> {
    return main.bridge.open(openRequest(launchId, recipeName)).then(
      () => {
        seen.push(`open ${launchId} ok`)
      },
      (error: Error) => {
        seen.push(`open ${launchId} failed: ${error.message}`)
      }
    )
  }

  function close(launchId: string): Promise<void> {
    return main.bridge.close({ launchId }).then(
      () => {
        seen.push(`close ${launchId} ok`)
      },
      (error: Error) => {
        seen.push(`close ${launchId} failed: ${error.message}`)
      }
    )
  }

  it('handles a close and an open sent in one tick in the order they were sent', async () => {
    await open(A)
    await main.settle()
    seen = []

    void close(A)
    void open(B, 'beta')
    await main.settle()

    expect(seen).toEqual(['released ' + A + ' closed {}', `close ${A} ok`, `open ${B} ok`])
    expect(main.live()?.launchId).toBe(B)
  })

  it('reports the view an open replaces before that open settles', async () => {
    await open(A)
    await main.settle()
    seen = []

    await open(B, 'beta')
    await main.settle()

    expect(seen).toEqual([`released ${A} replaced {}`, `open ${B} ok`])
  })

  it('rejects an open whose mint fails without reporting a view for it', async () => {
    await open(A)
    await main.settle()
    seen = []
    main.failNextOpen(new Error('upstream unavailable'))

    await open(B, 'beta')
    await main.settle()

    expect(seen).toEqual([`released ${A} replaced {}`, `open ${B} failed: upstream unavailable`])
    expect(main.live()).toBeNull()
  })

  it('reports the release of a view that mounted before the open that mounted it rejects', async () => {
    main.failNextOpenAfterMount(new Error('attach failed'))

    await open(A)
    await main.settle()

    expect(seen).toEqual([`released ${A} open_failed {}`, `open ${A} failed: attach failed`])
    expect(main.live()).toBeNull()
  })

  it('reports a view whose renderer dies inside its mount as crashed, before the open rejects', async () => {
    main.crashNextMount()

    await open(A)
    await main.settle()

    expect(seen).toEqual([
      `released ${A} crashed null`,
      `open ${A} failed: The app view closed before it finished opening`,
    ])
  })

  it('refuses a close that names no launch and leaves the live view alone', async () => {
    await open(A)
    await main.settle()
    seen = []

    await main.bridge.close({} as { launchId: string }).then(
      () => seen.push('close ok'),
      (error: Error) => seen.push(`close failed: ${error.message}`)
    )
    await main.settle()

    expect(seen).toEqual(['close failed: launchId must be a UUID'])
    expect(main.live()?.launchId).toBe(A)
  })

  it('ignores a close for a launch that no longer owns the view', async () => {
    await open(A)
    await open(B, 'beta')
    await main.settle()
    seen = []

    await close(A)
    await main.settle()

    expect(seen).toEqual([`close ${A} ok`])
    expect(main.live()?.launchId).toBe(B)
  })

  it('reports the route the user navigated to when the view is closed', async () => {
    await open(A)
    await main.settle()
    main.navigate('/inbox')
    seen = []

    await close(A)
    await main.settle()

    expect(seen).toEqual([`released ${A} closed {"routePath":"/inbox"}`, `close ${A} ok`])
  })

  it('reports a refresh that succeeds after main gave up as recovered, for the view that failed', async () => {
    await open(A)
    await main.settle()
    seen = []

    await main.refreshFailed(new Error('upstream unavailable'))
    await main.hostReturned()
    await main.settle()

    expect(seen).toEqual([
      expect.stringMatching(new RegExp(`^refreshError ${A} .*upstream unavailable`)),
      `refreshRecovered ${A} sandbox-recipes/alpha`,
    ])
    expect(main.live()?.launchId).toBe(A)
  })

  it('reports no recovery for a refresh that never failed', async () => {
    await open(A)
    await main.settle()
    seen = []

    await main.hostReturned(SANDBOX_UI_REFRESH_INTERVAL_MS)
    await main.settle()

    expect(seen).toEqual([])
    expect(main.live()?.launchId).toBe(A)
  })

  it('releases the live view when the session changes', async () => {
    await open(A)
    await main.settle()
    seen = []

    main.endSession()
    await main.settle()

    expect(seen).toEqual([`released ${A} session {}`])
    expect(main.live()).toBeNull()
  })
})
