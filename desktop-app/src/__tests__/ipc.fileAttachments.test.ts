/**
 * Issue #678 — the IPC boundary checks the shape of an inline `kind:'file'`
 * attachment and refuses a malformed one before it reaches the host. Image
 * attachments keep the contract they always had.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

function fileAttachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'file-1',
    kind: 'file',
    filename: 'notes.txt',
    mimeType: 'text/plain',
    detectedMediaType: 'text/plain',
    encoding: 'base64',
    dataBase64: 'aGVsbG8=',
    sizeBytes: 5,
    digest: {
      algorithm: 'sha256',
      hex: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    },
    ...overrides,
  }
}

function send(attachments: unknown) {
  const registered = electron.handlers.get('rpc:invokeHostMessage')
  if (!registered) throw new Error('no IPC handler registered for rpc:invokeHostMessage')
  return registered(trusted, { hostRef: 'agent-x', payload: { content: 'hi', attachments } })
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService)
})

afterEach(() => {
  service.invokeHostMessage.mockClear()
})

describe('rpc:invokeHostMessage file attachments', () => {
  it('forwards a well-formed file attachment untouched', async () => {
    const attachments = [fileAttachment()]
    await send(attachments)
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
    const request = service.invokeHostMessage.mock.calls[0]?.[1] as Record<string, unknown>
    expect(request.attachments).toEqual(attachments)
  })

  it('accepts an empty declared media type, which the host allows', async () => {
    await send([fileAttachment({ mimeType: '' })])
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('leaves image attachments to the contract they always had', async () => {
    const image = {
      id: 'img-1',
      kind: 'image',
      mimeType: 'image/png',
      encoding: 'base64',
      dataBase64: 'iVBORw0KGgo=',
    }
    await send([image])
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
    const request = service.invokeHostMessage.mock.calls[0]?.[1] as Record<string, unknown>
    expect(request.attachments).toEqual([image])
  })

  it.each([
    ['id', { id: '  ' }],
    ['filename', { filename: '' }],
    ['mimeType', { mimeType: 5 }],
    ['detectedMediaType', { detectedMediaType: undefined }],
    ['encoding', { encoding: 'utf8' }],
    ['dataBase64', { dataBase64: 42 }],
    ['sizeBytes', { sizeBytes: -1 }],
    ['sizeBytes', { sizeBytes: 1.5 }],
    ['digest', { digest: { algorithm: 'md5', hex: 'a'.repeat(64) } }],
    ['digest', { digest: { algorithm: 'sha256', hex: 'not-hex' } }],
    ['digest', { digest: undefined }],
  ])('rejects a file attachment with a bad %s before it reaches the host', async (field, patch) => {
    await expect(
      send([fileAttachment(), fileAttachment({ id: 'file-2', ...patch })])
    ).rejects.toThrow(
      `Invalid host message request: COMPOSER_FILE_ATTACHMENT_INVALID attachments[1].${field}`
    )
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(0)
    // Control: the same request without the bad entry goes through.
    await send([fileAttachment()])
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects an attachments field that is not a list', async () => {
    await expect(send({ id: 'x' })).rejects.toThrow('Invalid host message request: attachments')
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(0)
    // Control: a list goes through.
    await send([])
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
  })
})
