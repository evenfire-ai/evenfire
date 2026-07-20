import { BrowserWindow, session } from 'electron'
import { RpcProxyClient } from './rpcProxyClient.js'

export type OpenDesktopWindowArgs = {
  hostRef: string
  jwt: string
  rpcProxyUrl: string
  onClose?: (hostRef: string) => void
}

type WindowEntry = { window: BrowserWindow; hostRef: string }
const windows = new Map<string, WindowEntry>()

const client = new RpcProxyClient()

/**
 * Parses one or more Set-Cookie header values and extracts the session cookie value.
 * Accepts either a single string or an array (as returned by getSetCookie()).
 * Returns null if the named cookie isn't present.
 */
export function extractSessionCookie(setCookies: string | string[], name: string): string | null {
  const list = Array.isArray(setCookies) ? setCookies : [setCookies]
  const prefix = `${name}=`
  for (const header of list) {
    if (header.startsWith(prefix)) {
      const rest = header.slice(prefix.length)
      const end = rest.indexOf(';')
      return end === -1 ? rest : rest.slice(0, end)
    }
  }
  return null
}

const SESSION_COOKIE_NAME = 'clerum_desktop_session'

export async function openDesktopWindow(args: OpenDesktopWindowArgs): Promise<void> {
  const { hostRef, jwt, rpcProxyUrl, onClose } = args

  // If a window for this hostRef already exists, focus it instead of creating a new one.
  const existing = windows.get(hostRef)
  if (existing && !existing.window.isDestroyed()) {
    existing.window.focus()
    return
  }

  // 1. Session exchange (Node-side fetch; no cookie-jar problem)
  const { setCookie } = await client.postDesktopSession(jwt, hostRef)
  const cookieValue = extractSessionCookie(setCookie, SESSION_COOKIE_NAME)
  if (!cookieValue) {
    throw new Error(`Desktop response did not contain ${SESSION_COOKIE_NAME} session cookie`)
  }

  // 2. Inject the cookie into the BrowserWindow's session partition
  const partition = `persist:desktop-${hostRef}`
  const ses = session.fromPartition(partition)
  await ses.cookies.set({
    url: `${rpcProxyUrl}/api/v1/desktop/${hostRef}`,
    name: SESSION_COOKIE_NAME,
    value: cookieValue,
    path: `/api/v1/desktop/${hostRef}`,
    httpOnly: true,
    sameSite: 'strict',
  })

  // 3. Create the BrowserWindow with that session partition
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: `Evenfire — ${hostRef}`,
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  window.on('closed', () => {
    windows.delete(hostRef)
    onClose?.(hostRef)
  })

  windows.set(hostRef, { window, hostRef })

  // 4. Load the view URL
  window.once('ready-to-show', () => {
    window.maximize()
    window.show()
  })
  await window.loadURL(`${rpcProxyUrl}/api/v1/desktop/${hostRef}/view/`)
  if (!window.isVisible()) {
    window.maximize()
    window.show()
  }
}

export function closeDesktopWindow(hostRef: string): void {
  const entry = windows.get(hostRef)
  if (entry && !entry.window.isDestroyed()) {
    entry.window.close()
  }
  // Map cleanup happens in the 'closed' event handler installed in openDesktopWindow
}

export function isDesktopWindowOpen(hostRef: string): boolean {
  const entry = windows.get(hostRef)
  return !!entry && !entry.window.isDestroyed()
}
