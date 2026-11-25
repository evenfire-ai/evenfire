import { afterEach, expect, it, vi } from 'vitest'
import {
  type Deferred,
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

type Harness = Awaited<ReturnType<typeof createNativeCommitTestHarness>>
type ServiceUnderTest = Harness['service'] & {
  createSandboxUiDeepLink(
    teamId?: string,
    writeClipboard?: (url: string) => Promise<void>
  ): Promise<{ url: string }>
  selectRuntimeConfig(optionId: string): Promise<unknown>
  suspendDesktopGfsUploadsForAuthBoundary(): Promise<void>
}

const profileUiOrigin = 'https://10.0.0.5'
const teamId = 'team-1'
const location = { appId: 'app-1', path: '/open' }
const shareUrl = `${profileUiOrigin}/apps/open?team=${teamId}`

afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('../sandboxUiDriver.js')
  vi.doUnmock('../sandboxUiDeepLinks.js')
  await cleanupNativeCommitTestHarness()
})

it('keeps clipboard admission ahead of a queued environment change', async () => {
  const importStarted: Deferred<void> = deferred<void>()
  const releaseImport: Deferred<void> = deferred<void>()
  const clipboardStarted: Deferred<void> = deferred<void>()
  const releaseClipboard: Deferred<void> = deferred<void>()
  vi.doMock('../sandboxUiDriver.js', () => ({
    getActiveSandboxUiLocation: () => location,
    unmountSandboxUiView: async () => undefined,
  }))
  vi.doMock('../sandboxUiDeepLinks.js', async () => {
    importStarted.resolve(undefined)
    await releaseImport.promise
    return {
      buildSandboxUiWebLink: () => shareUrl,
    }
  })

  const harness = await createNativeCommitTestHarness()
  const service = harness.service as ServiceUnderTest
  service.sessionToken = 'synthetic-session'
  service.me = { id: 'user-1' }
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  const binding = harness.runtimeConfig.captureProfileOriginBinding()
  await harness.runtimeConfig.persistProfileOriginForBinding(binding, profileUiOrigin)

  let clipboardFinished = false
  const events: string[] = []
  const writeClipboard = async (url: string) => {
    expect(url).toBe(shareUrl)
    events.push('clipboard-start')
    clipboardStarted.resolve(undefined)
    await releaseClipboard.promise
    clipboardFinished = true
    events.push('clipboard-finished')
  }

  let share: Promise<{ url: string }> | undefined
  let selection: Promise<void> | undefined
  try {
    share = service.createSandboxUiDeepLink(teamId, writeClipboard)
    void share.catch(() => undefined)
    await importStarted.promise

    let selectionFinished = false
    selection = service.selectRuntimeConfig(harness.optionB.id).then(() => {
      selectionFinished = true
      events.push('selection-finished')
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(selectionFinished).toBe(false)

    releaseImport.resolve(undefined)
    const clipboardAdmitted = await Promise.race([
      clipboardStarted.promise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
    ])
    expect(clipboardAdmitted).toBe(true)
    const selectionOvertookClipboard = await Promise.race([
      selection.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
    ])
    expect(selectionOvertookClipboard).toBe(false)
    expect(clipboardFinished).toBe(false)

    releaseClipboard.resolve(undefined)
    await expect(share).resolves.toEqual({ url: shareUrl })
    await selection
    expect(events).toEqual(['clipboard-start', 'clipboard-finished', 'selection-finished'])
  } finally {
    releaseImport.resolve(undefined)
    releaseClipboard.resolve(undefined)
    await Promise.allSettled([...(share ? [share] : []), ...(selection ? [selection] : [])])
  }
})
