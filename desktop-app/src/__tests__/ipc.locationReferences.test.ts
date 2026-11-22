/**
 * The IPC boundary parses the folder a message names with the shared
 * LocationReference v1 contract, next to the file references, and refuses a
 * malformed one instead of forwarding it to the host.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildGfsFileReference,
  buildGfsLocationReference,
  classifyBytes,
  parseLocationReferenceV1,
} from '@clerum/gfs-interaction-policy'
import vectorFile from '../../../packages/gfs-interaction-policy/fixtures/location-reference-vectors.v1.json'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))
// ipc.ts only uses AppService as a type at registration; the real module would
// pull in the whole main-process graph.
vi.mock('../appService.js', () => ({ AppService: class {} }))

const service = {
  invokeHostMessage: vi.fn(async (..._args: unknown[]) => ({ taskId: 'task-1' })),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }

const RID = '1234567890abcdef1234567890abcdef'

function reference(name = 'plan.md') {
  const built = buildGfsFileReference({
    drive: 'main',
    resourceId: RID,
    gfsUri: `gfs://main/${RID}`,
    version: 3,
    name,
    declaredMediaType: null,
    byteLength: 120,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: 120,
      declaredMediaType: null,
      filename: name,
    }),
  })
  if (!built.ok) throw new Error(`fixture reference invalid: ${built.code}`)
  return built.value
}

function send(payload: Record<string, unknown>) {
  const registered = electron.handlers.get('rpc:invokeHostMessage')
  if (!registered) throw new Error('no IPC handler registered for rpc:invokeHostMessage')
  return registered(trusted, { hostRef: 'agent-x', payload: { content: 'hi', ...payload } })
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterEach(() => {
  service.invokeHostMessage.mockClear()
})

const FOLDER_RID = 'abcdef1234567890abcdef1234567890'

function folder(name = 'Reports') {
  const built = buildGfsLocationReference({
    drive: 'main',
    resourceId: FOLDER_RID,
    gfsUri: `gfs://main/${FOLDER_RID}`,
    name,
  })
  if (!built.ok) throw new Error(`fixture folder invalid: ${built.code}`)
  return built.value
}

/** What the shared contract accepts for `input`: the value the boundary must forward. */
function parsedFolder(input: unknown) {
  const parsed = parseLocationReferenceV1(input)
  if (!parsed.ok) throw new Error(`expected a valid folder: ${parsed.code}`)
  return parsed.value
}

type Vector = { name: string; input: unknown; expected: { ok: boolean } }
const vectors = (vectorFile as { vectors: Vector[] }).vectors
const validVectors = vectors.filter(vector => vector.expected.ok)
const invalidVectors = vectors.filter(vector => !vector.expected.ok)

describe('rpc:invokeHostMessage locationReferences', () => {
  it('forwards the parsed folder next to the parsed file references', async () => {
    const fileReferences = [reference('plan.md')]
    const locationReferences = [folder()]
    await send({ fileReferences, locationReferences })
    expect(service.invokeHostMessage).toHaveBeenCalledWith(
      'agent-x',
      expect.objectContaining({
        content: 'hi',
        fileReferences,
        locationReferences: [parsedFolder(locationReferences[0])],
      }),
      undefined,
      undefined
    )
  })

  it('leaves a request without a folder without the field', async () => {
    await send({ fileReferences: [reference()] })
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
    const request = service.invokeHostMessage.mock.calls[0][1] as Record<string, unknown>
    expect(request.fileReferences).toEqual([reference()])
    expect(request).not.toHaveProperty('locationReferences')
  })

  it.each(validVectors.map(vector => [vector.name, vector.input] as const))(
    'forwards the golden vector: %s',
    async (_name, input) => {
      await send({ locationReferences: [input] })
      expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
      const request = service.invokeHostMessage.mock.calls[0][1] as Record<string, unknown>
      expect(request.locationReferences).toEqual([parsedFolder(input)])
    }
  )

  it.each(invalidVectors.map(vector => [vector.name, vector.input] as const))(
    'rejects the golden vector, even next to valid file references: %s',
    async (_name, input) => {
      await expect(
        send({ fileReferences: [reference()], locationReferences: [input] })
      ).rejects.toThrow('Invalid host message request: locationReferences[0]')
      expect(service.invokeHostMessage).toHaveBeenCalledTimes(0)
      // Control: the same request with a valid folder goes through.
      await send({ fileReferences: [reference()], locationReferences: [folder()] })
      expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects a value that is not a list', async () => {
    await expect(send({ locationReferences: folder() })).rejects.toThrow(
      'Invalid host message request: locationReferences'
    )
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(0)
  })
})
