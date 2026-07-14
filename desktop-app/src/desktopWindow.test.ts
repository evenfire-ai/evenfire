import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron before importing the module
const mockSetCookie = vi.fn()
const mockLoadURL = vi.fn().mockResolvedValue(undefined)
const mockOn = vi.fn()
const mockOnce = vi.fn()
const mockFocus = vi.fn()
const mockClose = vi.fn()
const mockDestroy = vi.fn()
const mockIsDestroyed = vi.fn().mockReturnValue(false)
const mockIsVisible = vi.fn().mockReturnValue(true)
const mockMaximize = vi.fn()
const mockShow = vi.fn()

const mockBrowserWindow = vi.fn().mockImplementation(() => ({
  loadURL: mockLoadURL,
  on: mockOn,
  once: mockOnce,
  focus: mockFocus,
  close: mockClose,
  destroy: mockDestroy,
  isDestroyed: mockIsDestroyed,
  isVisible: mockIsVisible,
  maximize: mockMaximize,
  show: mockShow,
  webContents: { session: { cookies: { set: mockSetCookie } } },
}))

const mockFromPartition = vi.fn().mockReturnValue({
  cookies: { set: mockSetCookie },
})

vi.mock('electron', () => ({
  BrowserWindow: mockBrowserWindow,
  session: { fromPartition: mockFromPartition },
}))

const mockPostDesktopSession = vi.fn()
vi.mock('./rpcProxyClient.js', () => ({
  RpcProxyClient: class {
    constructor() {}
    postDesktopSession = mockPostDesktopSession
  },
}))

describe('desktopWindow', () => {
  let openDesktopWindow: typeof import('./desktopWindow').openDesktopWindow
  let closeDesktopWindow: typeof import('./desktopWindow').closeDesktopWindow

  beforeEach(async () => {
    vi.clearAllMocks()
    mockIsDestroyed.mockReturnValue(false)
    mockFromPartition.mockReturnValue({ cookies: { set: mockSetCookie } })
    mockBrowserWindow.mockImplementation(() => ({
      loadURL: mockLoadURL,
      on: mockOn,
      once: mockOnce,
      focus: mockFocus,
      close: mockClose,
      destroy: mockDestroy,
      isDestroyed: mockIsDestroyed,
      isVisible: mockIsVisible,
      maximize: mockMaximize,
      show: mockShow,
      webContents: { session: { cookies: { set: mockSetCookie } } },
    }))
    // Re-import to reset module-level state
    vi.resetModules()
    const mod = await import('./desktopWindow.js')
    openDesktopWindow = mod.openDesktopWindow
    closeDesktopWindow = mod.closeDesktopWindow
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('performs session exchange, injects cookie, and loads view URL', async () => {
    mockPostDesktopSession.mockResolvedValueOnce({
      ok: true,
      hostRef: 'chatllm',
      setCookie: [
        'clerum_desktop_session=abc123; Path=/api/v1/desktop/chatllm; HttpOnly; SameSite=Strict; Max-Age=3600',
      ],
    })

    await openDesktopWindow({
      hostRef: 'chatllm',
      jwt: 'test-jwt',
      rpcProxyUrl: 'http://localhost:8094',
    })

    expect(mockPostDesktopSession).toHaveBeenCalledWith('test-jwt', 'chatllm')
    expect(mockFromPartition).toHaveBeenCalledWith('persist:desktop-chatllm')
    expect(mockSetCookie).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:8094/api/v1/desktop/chatllm',
        name: 'clerum_desktop_session',
        value: 'abc123',
        path: '/api/v1/desktop/chatllm',
        httpOnly: true,
        sameSite: 'strict',
      })
    )
    expect(mockLoadURL).toHaveBeenCalledWith('http://localhost:8094/api/v1/desktop/chatllm/view/')
  })

  it('reuses existing window on second call for same hostRef (focus instead of creating new)', async () => {
    mockPostDesktopSession.mockResolvedValue({
      ok: true,
      hostRef: 'chatllm',
      setCookie:
        'clerum_desktop_session=abc; Path=/api/v1/desktop/chatllm; HttpOnly; SameSite=Strict; Max-Age=3600',
    })

    await openDesktopWindow({ hostRef: 'chatllm', jwt: 'j1', rpcProxyUrl: 'http://localhost:8094' })
    await openDesktopWindow({ hostRef: 'chatllm', jwt: 'j2', rpcProxyUrl: 'http://localhost:8094' })

    expect(mockBrowserWindow).toHaveBeenCalledTimes(1)
    expect(mockFocus).toHaveBeenCalledTimes(1)
  })

  it('creates a second window for a different hostRef', async () => {
    mockPostDesktopSession.mockResolvedValue({
      ok: true,
      hostRef: 'chatllm',
      setCookie: 'clerum_desktop_session=abc; Path=/x; HttpOnly; SameSite=Strict; Max-Age=3600',
    })

    await openDesktopWindow({ hostRef: 'chatllm', jwt: 'j1', rpcProxyUrl: 'http://localhost:8094' })
    await openDesktopWindow({ hostRef: 'agent2', jwt: 'j2', rpcProxyUrl: 'http://localhost:8094' })

    expect(mockBrowserWindow).toHaveBeenCalledTimes(2)
  })

  it('closeDesktopWindow closes and clears the singleton', async () => {
    mockPostDesktopSession.mockResolvedValueOnce({
      ok: true,
      hostRef: 'chatllm',
      setCookie: 'clerum_desktop_session=abc; Path=/x; HttpOnly; SameSite=Strict; Max-Age=3600',
    })
    await openDesktopWindow({ hostRef: 'chatllm', jwt: 'j1', rpcProxyUrl: 'http://localhost:8094' })
    closeDesktopWindow('chatllm')
    expect(mockClose).toHaveBeenCalled()
  })

  it('throws when session exchange fails', async () => {
    mockPostDesktopSession.mockRejectedValueOnce(new Error('503 Desktop not running'))
    await expect(
      openDesktopWindow({ hostRef: 'chatllm', jwt: 'j', rpcProxyUrl: 'http://localhost:8094' })
    ).rejects.toThrow('503 Desktop not running')
    expect(mockBrowserWindow).not.toHaveBeenCalled()
  })

  it('throws when Set-Cookie has no value for session cookie name', async () => {
    mockPostDesktopSession.mockResolvedValueOnce({
      ok: true,
      hostRef: 'chatllm',
      setCookie: 'some-other-cookie=x; Path=/',
    })
    await expect(
      openDesktopWindow({ hostRef: 'chatllm', jwt: 'j', rpcProxyUrl: 'http://localhost:8094' })
    ).rejects.toThrow(/session cookie/i)
  })

  it("invokes onClose callback when BrowserWindow emits 'closed'", async () => {
    const onClose = vi.fn()
    mockPostDesktopSession.mockResolvedValueOnce({
      ok: true,
      hostRef: 'chatllm',
      setCookie:
        'clerum_desktop_session=abc; Path=/api/v1/desktop/chatllm; HttpOnly; SameSite=Strict; Max-Age=3600',
    })

    await openDesktopWindow({
      hostRef: 'chatllm',
      jwt: 'j',
      rpcProxyUrl: 'http://localhost:8094',
      onClose,
    })

    const closedHandler = mockOn.mock.calls.find((call: any[]) => call[0] === 'closed')?.[1]
    expect(closedHandler).toBeDefined()
    closedHandler?.()

    expect(onClose).toHaveBeenCalledWith('chatllm')
  })
})
