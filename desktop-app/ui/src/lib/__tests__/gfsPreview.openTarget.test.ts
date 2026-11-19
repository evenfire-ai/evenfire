import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppService } from '../../../../src/appService'
import type { ResolvedGfsResource } from '../../../../src/gfs/uriHandler'
import {
  openGfsResourcePayload,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '../../gfs/__fixtures__/gfsProducerFixtures'
import { gfsResourceOpenTarget } from '../gfsPreview'

// Only so the main-process plugin runtime can load; nothing here touches it.
vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/unused') },
  BrowserWindow: class {},
  Notification: class {},
}))

const RID = '859df99de46b407bb0ec4b0f7cb424a5'
const URI = `gfs://main/${RID}`

const runtimeDirs: string[] = []
afterAll(async () => {
  await Promise.all(runtimeDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * The `pluginSdk:openGfsResource` payload exactly as the real main-process
 * `PluginSdkRuntime.openGfsResource` sends it, for a resource the real
 * `GfsClient` resolved, structured-cloned as Electron IPC does.
 */
async function runtimePayload(resource: ResolvedGfsResource) {
  const resolved = await resolveResource(resource)
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'evenfire-open-target-'))
  runtimeDirs.push(userDataDir)
  const send = vi.fn()
  const { PluginSdkRuntime } = await import('../../../../src/pluginSdkRuntime')
  const runtime = new PluginSdkRuntime({
    service: { resolveGfsUri: async () => resolved } as unknown as AppService,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    userDataDir,
  })
  await expect(runtime.openGfsResource(resource.gfsUri)).resolves.toEqual({ opened: true })
  const sent = send.mock.calls.filter(([channel]) => channel === 'pluginSdk:openGfsResource')
  expect(sent).toHaveLength(1)
  return structuredClone(sent[0]![1]) as Awaited<ReturnType<typeof openGfsResourcePayload>>
}

// Both producers that feed `gfsResourceOpenTarget`: the plugin SDK wire payload
// (`bytes: null` when the resolve omits it) and the resolve result itself.
const producers = [
  ['plugin payload', runtimePayload],
  ['resolved resource', resolveResource],
] as const

describe.each(producers)('gfsResourceOpenTarget — %s', (_label, produce) => {
  it('opens a directory in the files browser, even when its name looks previewable', async () => {
    const resource = await produce(resolvedDirectory(RID, 'notes.md', { gfsUri: URI }))

    expect(gfsResourceOpenTarget(resource)).toEqual({ kind: 'files', gfsUri: URI })
  })

  it('opens a previewable file as a preview of the resolved resource', async () => {
    const resource = await produce(
      resolvedFile(RID, 'README.md', { gfsUri: URI, bytes: 120, version: 7 })
    )

    expect(gfsResourceOpenTarget(resource)).toEqual({
      kind: 'preview',
      preview: { gfsUri: URI, kind: 'markdown', name: 'README.md', bytes: 120, version: 7 },
    })
  })

  it('opens an image as an image preview with its mime type', async () => {
    const resource = await produce(resolvedFile(RID, 'diagram.PNG', { gfsUri: URI, bytes: 9 }))

    expect(gfsResourceOpenTarget(resource)).toEqual({
      kind: 'preview',
      preview: {
        gfsUri: URI,
        kind: 'image',
        mimeType: 'image/png',
        name: 'diagram.PNG',
        bytes: 9,
        version: 1,
      },
    })
  })

  it('opens a non-previewable file in the files browser at its resolved uri', async () => {
    const resource = await produce(resolvedFile(RID, 'report.pdf', { gfsUri: URI }))

    expect(gfsResourceOpenTarget(resource)).toEqual({ kind: 'files', gfsUri: URI })
  })

  it('treats a resource without a byte count as zero bytes', async () => {
    const { bytes: _omitted, ...withoutBytes } = resolvedFile(RID, 'demo.mp4', { gfsUri: URI })
    const resource = await produce(withoutBytes)

    expect(gfsResourceOpenTarget(resource)).toEqual({
      kind: 'preview',
      preview: {
        gfsUri: URI,
        kind: 'video',
        mimeType: 'video/mp4',
        name: 'demo.mp4',
        bytes: 0,
        version: 1,
      },
    })
  })
})

describe('plugin open payload', () => {
  it('carries `bytes: null` when the resolve omits it', async () => {
    const { bytes: _omitted, ...withoutBytes } = resolvedFile(RID, 'demo.mp4', { gfsUri: URI })

    expect(await runtimePayload(withoutBytes)).toEqual({
      gfsUri: URI,
      name: 'demo.mp4',
      kind: 'file',
      bytes: null,
      version: 1,
    })
  })

  // The renderer App suites cannot load the runtime (it imports `electron`),
  // so they use the fixture's mirror of its projection; this keeps the mirror
  // honest.
  it.each([
    ['with a byte count', resolvedFile(RID, 'README.md', { gfsUri: URI, bytes: 120, version: 7 })],
    ['without a byte count', resolvedFile(RID, 'demo.mp4', { gfsUri: URI, bytes: undefined })],
    ['for a directory', resolvedDirectory(RID, 'Folder', { gfsUri: URI })],
  ])('matches the fixture mirror %s', async (_label, resource) => {
    expect(await openGfsResourcePayload(resource)).toEqual(await runtimePayload(resource))
  })
})
