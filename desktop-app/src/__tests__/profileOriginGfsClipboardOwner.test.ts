import { afterEach, expect, it, vi } from 'vitest'
import {
  type Deferred,
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

type Harness = Awaited<ReturnType<typeof createNativeCommitTestHarness>>
type ServiceUnderTest = Harness['service'] & {
  createGfsResourceDeepLink(
    uri: string,
    writeClipboard?: (url: string) => Promise<void>
  ): Promise<{ url: string }>
  selectRuntimeConfig(optionId: string): Promise<unknown>
  suspendDesktopGfsUploadsForAuthBoundary(): Promise<void>
}

const profileUiOrigin = 'https://10.0.0.5'
const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'
const shareUrl = `${profileUiOrigin}/open/files?uri=${encodeURIComponent(resourceUri)}`

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupNativeCommitTestHarness()
})

it('keeps GFS clipboard admission ahead of a queued environment change', async () => {
  const clipboardStarted: Deferred<void> = deferred<void>()
  const releaseClipboard: Deferred<void> = deferred<void>()

  const harness = await createNativeCommitTestHarness({
    configuredRest: 'https://api-a.example.test',
    profileUiBaseUrl: profileUiOrigin,
    restA: 'https://api-a.example.test',
  })
  const service = harness.service as ServiceUnderTest
  service.sessionToken = 'synthetic-session'
  service.me = { id: 'user-1' }
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)

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
    share = service.createGfsResourceDeepLink(resourceUri, writeClipboard)
    void share.catch(() => undefined)
    const admitted = await Promise.race([
      clipboardStarted.promise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
    ])
    expect(admitted).toBe(true)

    let selectionFinished = false
    selection = service.selectRuntimeConfig(harness.optionB.id).then(() => {
      selectionFinished = true
      events.push('selection-finished')
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(selectionFinished).toBe(false)
    expect(clipboardFinished).toBe(false)

    releaseClipboard.resolve(undefined)
    await expect(share).resolves.toEqual({ url: shareUrl })
    await selection
    expect(events).toEqual(['clipboard-start', 'clipboard-finished', 'selection-finished'])
  } finally {
    releaseClipboard.resolve(undefined)
    await Promise.allSettled([...(share ? [share] : []), ...(selection ? [selection] : [])])
  }
})
