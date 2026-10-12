import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setCookie: vi.fn(),
  loadURL: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./config.js', () => ({
  config: { rpcProxyBaseUrl: 'https://durable-rpc.example.test', requestTimeoutMs: 1000 },
}))
vi.mock('electron', () => ({
  session: { fromPartition: () => ({ cookies: { set: mocks.setCookie } }) },
  BrowserWindow: class {
    webContents = { session: { cookies: { set: mocks.setCookie } } }
    loadURL = mocks.loadURL
    on = vi.fn()
    once = vi.fn()
    show = vi.fn()
    maximize = vi.fn()
    isDestroyed = () => false
    isVisible = () => true
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('exchanges, installs cookies and navigates through the same effective RPC URL', async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, hostRef: 'transport-host' }),
    headers: {
      get: (name: string) =>
        name === 'set-cookie'
          ? 'clerum_desktop_session=fixture-cookie; Path=/api/v1/desktop/transport-host; HttpOnly'
          : null,
    },
  })
  vi.stubGlobal('fetch', fetch)
  const { openDesktopWindow } = await import('./desktopWindow.js')
  await openDesktopWindow({
    hostRef: 'transport-host',
    jwt: 'synthetic-rpc-token',
    rpcProxyUrl: 'https://effective-rpc.example.test',
  })
  expect(fetch).toHaveBeenCalledWith(
    'https://effective-rpc.example.test/api/v1/desktop/transport-host/session',
    expect.objectContaining({ method: 'POST' })
  )
  expect(mocks.setCookie).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://effective-rpc.example.test/api/v1/desktop/transport-host',
    })
  )
  expect(mocks.loadURL).toHaveBeenCalledWith(
    'https://effective-rpc.example.test/api/v1/desktop/transport-host/view/'
  )
})
