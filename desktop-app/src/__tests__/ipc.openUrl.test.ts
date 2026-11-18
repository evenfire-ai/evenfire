import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  openExternal: vi.fn(async () => undefined),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openExternal: electron.openExternal },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))
vi.mock('../appService.js', () => ({ AppService: class {} }))

const trusted = { senderFrame: { url: 'file:///app/index.html' } }

function openUrl(url: unknown): Promise<unknown> {
  const handler = electron.handlers.get('app:openUrl')
  if (!handler) throw new Error('app:openUrl handler was not registered')
  return handler(trusted, { url })
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers({} as unknown as AppService, async () => 0)
})

afterEach(() => {
  electron.openExternal.mockClear()
})

describe('app:openUrl (S-11)', () => {
  it('hands the mail client only the address, dropping every query field', async () => {
    await openUrl('mailto:a@b.c?attach=/etc/passwd')

    expect(electron.openExternal).toHaveBeenCalledTimes(1)
    expect(electron.openExternal).toHaveBeenCalledWith('mailto:a@b.c')
  })

  it('accepts the scheme in any case and keeps several recipients', async () => {
    await openUrl('MAILTO:a@b.c,d@e.f?subject=hi&body=x')

    expect(electron.openExternal).toHaveBeenCalledWith('mailto:a@b.c,d@e.f')
  })

  it.each(['mailto:?to=x', 'mailto:', 'mailto:  ?cc=y'])('rejects %s (no recipient)', async url => {
    await expect(openUrl(url)).rejects.toThrow('no recipient')
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('keeps several recipients and drops a mixed-case query', async () => {
    await openUrl('mailto:a@b.c,d@e.f')
    await openUrl('MAILTO:a@b.c?subject=x')

    expect(electron.openExternal.mock.calls).toEqual([['mailto:a@b.c,d@e.f'], ['mailto:a@b.c']])
  })

  it('drops a fragment', async () => {
    await openUrl('mailto:a@b.c#frag')

    expect(electron.openExternal).toHaveBeenCalledWith('mailto:a@b.c')
  })

  it.each([
    'mailto:a@b.c%3Fattach=/etc/passwd',
    'mailto:a@b.c&attach=x',
    'mailto:a@b.c%0D%0ABcc:x@y',
    'mailto:a@b.c,',
    'mailto:a@b.c,,d@e.f',
    'mailto:a b@c.d',
    'mailto:a@b@c.d',
    'mailto:a@b.c/../x',
  ])('rejects %s (invalid recipient)', async url => {
    await expect(openUrl(url)).rejects.toThrow('invalid recipient')
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('rejects an oversized mailto: URL', async () => {
    await expect(openUrl(`mailto:${'a'.repeat(2048)}@b.c`)).rejects.toThrow('too long')
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('opens http(s) unchanged', async () => {
    await openUrl('https://evenfire.ai/a?b=c')
    await openUrl('http://example.com/')

    expect(electron.openExternal.mock.calls).toEqual([
      ['https://evenfire.ai/a?b=c'],
      ['http://example.com/'],
    ])
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'gfs://main/x', 'HTTPS://evenfire.ai'])(
    'still rejects %s',
    async url => {
      await expect(openUrl(url)).rejects.toThrow('Only HTTP(S) or mailto: URLs are allowed')
      expect(electron.openExternal).not.toHaveBeenCalled()
    }
  )
})
