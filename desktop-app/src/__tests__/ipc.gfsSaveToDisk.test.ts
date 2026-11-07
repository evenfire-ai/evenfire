import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppService } from '../appService.js'
import { GfsClient, type GfsTransport } from '../gfs/uriHandler.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  showSaveDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { isReady: vi.fn(() => false), on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: electron.showSaveDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => electron.handlers.set(channel, handler)),
    on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) =>
      electron.listeners.set(channel, listener)
    ),
    removeHandler: vi.fn(),
  },
}))
vi.mock('../appService.js', () => ({ AppService: class {} }))

const testDirectory = mkdtempSync(path.join(os.tmpdir(), 'evenfire-save-ipc-'))
const destination = path.join(testDirectory, 'saved.txt')
const binding = {
  environmentKey: 'test',
  profileId: 'profile',
  restBaseUrl: 'https://rest.example',
  userId: 'user-1',
  sessionGeneration: 7,
  gfsAuthEpoch: 3,
}
const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'
const trusted = { senderFrame: { url: 'file:///app/index.html' } }
const service = {
  getSessionGeneration: () => 7,
  admitGfsSave: vi.fn(async () => ({
    binding,
    receipt: Promise.resolve({
      uri: resourceUri,
      version: 4,
      filename: 'report.txt',
      bytes: new TextEncoder().encode('exact admitted bytes').buffer,
    }),
  })),
  beginGfsSaveDialog: vi.fn(async (_binding: unknown, show: () => Promise<unknown>) => ({
    completion: show(),
  })),
  assertGfsSaveAuthority: vi.fn(async () => undefined),
  publishGfsSave: vi.fn(async (_binding: unknown, publish: () => unknown) => await publish()),
}

function saveHandler(): Handler {
  const handler = electron.handlers.get('gfs:saveToDisk')
  if (!handler) throw new Error('gfs:saveToDisk handler was not registered')
  return handler
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterAll(() => {
  rmSync(testDirectory, { recursive: true, force: true })
})

afterEach(() => {
  for (const name of readdirSync(testDirectory)) {
    if (name.endsWith('.partial')) {
      rmSync(path.join(testDirectory, name), { recursive: true, force: true })
    }
  }
})

describe('gfs:saveToDisk trusted owner', () => {
  it('binds dialog, accepted metadata and bytes to one idempotent terminal save', async () => {
    try {
      rmSync(destination)
    } catch {
      // Start with a clean destination.
    }
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const payload = {
      uri: resourceUri,
      expectedSessionGeneration: 7,
      requestId: 'save-request-0001',
    }

    const first = await saveHandler()(trusted, payload)
    const second = await saveHandler()(trusted, payload)

    expect(first).toMatchObject({
      status: 'saved_access_verified',
      uri: resourceUri,
      version: 4,
      filePath: destination,
    })
    expect(second).toEqual(first)
    expect(readFileSync(destination, 'utf8')).toBe('exact admitted bytes')
    expect(service.admitGfsSave).toHaveBeenCalledOnce()
    expect(service.beginGfsSaveDialog).toHaveBeenCalledOnce()
    expect(service.publishGfsSave).toHaveBeenCalledOnce()
    expect(electron.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: 'report.txt',
      title: 'Save file',
    })
  })

  it('cleans the owner stage when the final auth-queue fence rejects publication', async () => {
    const finalPath = path.join(testDirectory, 'stale-authority.txt')
    try {
      rmSync(finalPath)
    } catch {
      // Start with a clean destination.
    }
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: finalPath })
    service.publishGfsSave.mockRejectedValueOnce(new Error('stale_auth_epoch'))

    await expect(
      saveHandler()(trusted, {
        uri: resourceUri,
        expectedSessionGeneration: 7,
        requestId: 'stale-authority-request',
      })
    ).rejects.toThrow('stale_auth_epoch')

    expect(service.publishGfsSave).toHaveBeenCalled()
    expect(existsSync(finalPath)).toBe(false)
    expect(readdirSync(testDirectory).some(name => name.endsWith('.partial'))).toBe(false)
    service.publishGfsSave.mockImplementation(
      async (_binding: unknown, publish: () => unknown) => await publish()
    )
  })

  it('rejects an absent or null observed generation before dispatch', async () => {
    service.admitGfsSave.mockClear()
    await expect(
      saveHandler()(trusted, { uri: resourceUri, requestId: 'bad-generation' })
    ).rejects.toThrow('invalid_session_generation')
    await expect(
      saveHandler()(trusted, {
        uri: resourceUri,
        expectedSessionGeneration: null,
        requestId: 'null-generation',
      })
    ).rejects.toThrow('invalid_session_generation')
    expect(service.admitGfsSave).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing URI',
      new Headers({
        'x-gfs-version': '17',
        'content-disposition': "attachment; filename*=UTF-8''report.txt",
      }),
    ],
    [
      'mismatched URI',
      new Headers({
        'x-gfs-uri': 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'x-gfs-version': '17',
        'content-disposition': "attachment; filename*=UTF-8''report.txt",
      }),
    ],
    [
      'missing version',
      new Headers({
        'x-gfs-uri': resourceUri,
        'content-disposition': "attachment; filename*=UTF-8''report.txt",
      }),
    ],
    [
      'unsafe filename',
      new Headers({
        'x-gfs-uri': resourceUri,
        'x-gfs-version': '17',
        'content-disposition': "attachment; filename*=UTF-8''CON.txt",
      }),
    ],
  ])(
    'rejects %s admitted metadata before the main save owner opens or stages',
    async (_label, headers) => {
      const body = new TextEncoder().encode('protected bytes').buffer
      const transport = {
        baseUrl: 'https://api.example/',
        requestJson: vi.fn(),
        fetchBytes: vi.fn(),
        fetchBytesWithMetadata: vi.fn(async () => ({ bytes: body, headers })),
      } as unknown as GfsTransport
      const client = new GfsClient(transport)
      service.admitGfsSave.mockImplementation(async (uri, _generation, signal) => ({
        binding,
        receipt: client.downloadWithReceipt(uri, 'test-token', signal),
      }))
      electron.showSaveDialog.mockClear()
      service.beginGfsSaveDialog.mockClear()
      const protectedDestination = path.join(testDirectory, 'must-not-publish.txt')
      try {
        rmSync(protectedDestination)
      } catch {
        // Start with a clean destination.
      }

      await expect(
        saveHandler()(trusted, {
          uri: resourceUri,
          expectedSessionGeneration: 7,
          requestId: `invalid-receipt-${String(_label).replaceAll(' ', '-')}`,
        })
      ).rejects.toThrow(/receipt metadata is missing or inconsistent/)

      expect(electron.showSaveDialog).not.toHaveBeenCalled()
      expect(service.beginGfsSaveDialog).not.toHaveBeenCalled()
      expect(existsSync(protectedDestination)).toBe(false)
    }
  )

  it('settles a cooperative GFS producer after explicit owner cancellation', async () => {
    let producerSettled = false
    let releaseProducer: (() => void) | undefined
    service.admitGfsSave.mockClear()
    try {
      rmSync(destination)
    } catch {
      // Start with a clean destination.
    }
    const producerStarted = new Promise<void>(resolve => {
      service.admitGfsSave.mockImplementation(async (uri, _generation, signal) => {
        const transport = {
          baseUrl: 'https://api.example/',
          requestJson: vi.fn(),
          fetchBytes: vi.fn(),
          fetchBytesWithMetadata: vi.fn(
            (_url: string, _token: string, options?: { signal?: AbortSignal }) =>
              new Promise<{ bytes: ArrayBuffer; headers: Headers }>(resolveBytes => {
                resolve()
                options?.signal?.addEventListener(
                  'abort',
                  () => {
                    producerSettled = true
                    resolveBytes({
                      bytes: new TextEncoder().encode('settled after cancel').buffer,
                      headers: new Headers({
                        'x-gfs-uri': resourceUri,
                        'x-gfs-version': '4',
                        'content-disposition': "attachment; filename*=UTF-8''report.txt",
                      }),
                    })
                  },
                  { once: true }
                )
                releaseProducer = () => {
                  resolveBytes({
                    bytes: new TextEncoder().encode('settled after cancel').buffer,
                    headers: new Headers({
                      'x-gfs-uri': resourceUri,
                      'x-gfs-version': '4',
                      'content-disposition': "attachment; filename*=UTF-8''report.txt",
                    }),
                  })
                }
              })
          ),
        } as unknown as GfsTransport
        const client = new GfsClient(transport)
        return { binding, receipt: client.downloadWithReceipt(uri, 'test-token', signal) }
      })
    })
    electron.showSaveDialog.mockClear()

    const pending = saveHandler()(trusted, {
      uri: resourceUri,
      expectedSessionGeneration: 7,
      requestId: 'cooperative-cancel-request',
    })
    await producerStarted
    electron.listeners.get('gfs:abort')?.(trusted, { requestId: 'cooperative-cancel-request' })
    const settledBeforeBound = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ])
    if (!settledBeforeBound) releaseProducer?.()
    expect(producerSettled).toBe(true)
    await expect(pending).resolves.toMatchObject({
      status: 'cancelled_no_publication',
      uri: resourceUri,
    })
    expect(electron.showSaveDialog).not.toHaveBeenCalled()
    expect(service.admitGfsSave).toHaveBeenCalledOnce()
    expect(existsSync(destination)).toBe(false)
    service.admitGfsSave.mockImplementation(async () => ({
      binding,
      receipt: Promise.resolve({
        uri: resourceUri,
        version: 4,
        filename: 'report.txt',
        bytes: new TextEncoder().encode('exact admitted bytes').buffer,
      }),
    }))
  })
})
