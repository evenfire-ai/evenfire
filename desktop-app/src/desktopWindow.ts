import { BrowserWindow, session } from 'electron'
import { desktopRuntimeLog } from './desktopRuntimeLog.js'
import { RpcProxyClient } from './rpcProxyClient.js'

export type OpenDesktopWindowArgs = {
  hostRef: string
  jwt: string
  rpcProxyUrl: string
  requestOwnerContext: unknown
  sessionRequestContextsMatchOwner: (left: unknown, right: unknown) => boolean
  assertRequestOwnerCurrent: () => void
  onClose?: (hostRef: string) => void
}

type WindowEntry = {
  window: BrowserWindow
  hostRef: string
  requestOwnerContext: unknown
  sessionRequestContextsMatchOwner: (left: unknown, right: unknown) => boolean
  assertRequestOwnerCurrent: () => void
  onClose?: (hostRef: string) => void
  retire: () => Promise<void>
}
const windows = new Map<string, WindowEntry>()
const pendingWindowOpens = new Map<string, Promise<void>>()
const pendingCookieMutations = new Map<string, Promise<void>>()
const partitionCookieOwners = new Map<string, unknown>()

function withPartitionCookieMutation<T>(hostRef: string, operation: () => Promise<T>): Promise<T> {
  const prior = pendingCookieMutations.get(hostRef) ?? Promise.resolve()
  const result = prior.catch(() => undefined).then(operation)
  const completion = result.then(
    () => undefined,
    () => undefined
  )
  pendingCookieMutations.set(hostRef, completion)
  void completion.finally(() => {
    if (pendingCookieMutations.get(hostRef) === completion) {
      pendingCookieMutations.delete(hostRef)
    }
  })
  return result
}

function removePartitionCookieIfOwnedBy(input: {
  hostRef: string
  requestOwnerContext: unknown
  sessionRequestContextsMatchOwner: (left: unknown, right: unknown) => boolean
  remove: () => Promise<unknown>
}): Promise<void> {
  return withPartitionCookieMutation(input.hostRef, async () => {
    const installedOwner = partitionCookieOwners.get(input.hostRef)
    if (
      installedOwner === undefined ||
      !input.sessionRequestContextsMatchOwner(installedOwner, input.requestOwnerContext)
    )
      return
    await input.remove().catch(() => undefined)
    if (partitionCookieOwners.get(input.hostRef) === installedOwner) {
      partitionCookieOwners.delete(input.hostRef)
    }
  })
}

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
  const prior = pendingWindowOpens.get(args.hostRef) ?? Promise.resolve()
  const operation = prior.catch(() => undefined).then(() => openDesktopWindowOnce(args))
  pendingWindowOpens.set(args.hostRef, operation)
  try {
    await operation
  } finally {
    if (pendingWindowOpens.get(args.hostRef) === operation) {
      pendingWindowOpens.delete(args.hostRef)
    }
  }
}

async function openDesktopWindowOnce(args: OpenDesktopWindowArgs): Promise<void> {
  const { hostRef, jwt, rpcProxyUrl, onClose } = args

  // Reuse only a window created by the same accepted session owner. Host refs
  // can survive logout, so a matching hostRef alone does not establish ownership.
  const existing = windows.get(hostRef)
  if (existing && existing.window.isDestroyed()) {
    if (windows.get(hostRef) === existing) windows.delete(hostRef)
  } else if (existing) {
    args.assertRequestOwnerCurrent()
    if (
      args.sessionRequestContextsMatchOwner(existing.requestOwnerContext, args.requestOwnerContext)
    ) {
      existing.requestOwnerContext = args.requestOwnerContext
      existing.sessionRequestContextsMatchOwner = args.sessionRequestContextsMatchOwner
      existing.assertRequestOwnerCurrent = args.assertRequestOwnerCurrent
      existing.onClose = args.onClose
      existing.window.focus()
      return
    }
    await existing.retire()
    args.assertRequestOwnerCurrent()
  }

  // 1. Session exchange (Node-side fetch; no cookie-jar problem)
  args.assertRequestOwnerCurrent()
  const client = new RpcProxyClient(() => rpcProxyUrl)
  const { setCookie } = await client.postDesktopSession(jwt, hostRef)
  args.assertRequestOwnerCurrent()
  const cookieValue = extractSessionCookie(setCookie, SESSION_COOKIE_NAME)
  if (!cookieValue) {
    throw new Error(`Desktop response did not contain ${SESSION_COOKIE_NAME} session cookie`)
  }

  // 2. Inject the cookie into the BrowserWindow's session partition
  const partition = `persist:desktop-${hostRef}`
  const ses = session.fromPartition(partition)
  const desktopUrl = `${rpcProxyUrl}/api/v1/desktop/${hostRef}`
  args.assertRequestOwnerCurrent()
  await withPartitionCookieMutation(hostRef, async () => {
    args.assertRequestOwnerCurrent()
    await ses.cookies.set({
      url: desktopUrl,
      name: SESSION_COOKIE_NAME,
      value: cookieValue,
      path: `/api/v1/desktop/${hostRef}`,
      httpOnly: true,
      sameSite: 'strict',
    })
    partitionCookieOwners.set(hostRef, args.requestOwnerContext)
  })
  try {
    args.assertRequestOwnerCurrent()
  } catch (error) {
    await removePartitionCookieIfOwnedBy({
      hostRef,
      requestOwnerContext: args.requestOwnerContext,
      sessionRequestContextsMatchOwner: args.sessionRequestContextsMatchOwner,
      remove: () => ses.cookies.remove(desktopUrl, SESSION_COOKIE_NAME),
    })
    throw error
  }

  // 3. Create the BrowserWindow with that session partition
  args.assertRequestOwnerCurrent()
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

  const entry: WindowEntry = {
    window,
    hostRef,
    requestOwnerContext: args.requestOwnerContext,
    sessionRequestContextsMatchOwner: args.sessionRequestContextsMatchOwner,
    assertRequestOwnerCurrent: args.assertRequestOwnerCurrent,
    onClose,
    retire: () => Promise.resolve(),
  }
  let closeNotified = false
  const notifyWindowClosed = () => {
    if (closeNotified) return
    closeNotified = true
    try {
      entry.onClose?.(hostRef)
    } catch (error) {
      // Renderer notification is best-effort and must not interrupt owner cleanup.
      desktopRuntimeLog.warn(
        '[Desktop] Could not notify the renderer that a host window closed:',
        error
      )
    }
  }

  window.on('closed', () => {
    const ownsCurrentWindow = windows.get(hostRef) === entry
    if (ownsCurrentWindow) windows.delete(hostRef)
    if (!ownsCurrentWindow) return
    notifyWindowClosed()
    try {
      entry.assertRequestOwnerCurrent()
    } catch {
      return
    }
  })

  let staleWindowCleanup: Promise<void> | undefined
  const closeStaleWindow = (notifyOwnerRetirement: boolean): Promise<void> => {
    if (staleWindowCleanup) return staleWindowCleanup
    const currentEntry = windows.get(hostRef)
    const newerWindowOwnsHost = currentEntry !== undefined && currentEntry !== entry
    const retiresCurrentWindow = currentEntry === entry
    if (retiresCurrentWindow) windows.delete(hostRef)
    if (!window.isDestroyed()) window.destroy()
    if (retiresCurrentWindow && notifyOwnerRetirement) notifyWindowClosed()
    staleWindowCleanup = newerWindowOwnsHost
      ? Promise.resolve()
      : removePartitionCookieIfOwnedBy({
          hostRef,
          requestOwnerContext: entry.requestOwnerContext,
          sessionRequestContextsMatchOwner: entry.sessionRequestContextsMatchOwner,
          remove: () => ses.cookies.remove(desktopUrl, SESSION_COOKIE_NAME),
        })
    return staleWindowCleanup
  }
  entry.retire = () => closeStaleWindow(true)
  windows.set(hostRef, entry)

  // 4. Load the view URL
  window.once('ready-to-show', () => {
    try {
      entry.assertRequestOwnerCurrent()
    } catch {
      void closeStaleWindow(false)
      return
    }
    if (window.isDestroyed()) return
    window.maximize()
    window.show()
  })
  try {
    await window.loadURL(`${desktopUrl}/view/`)
    entry.assertRequestOwnerCurrent()
    if (!window.isVisible()) {
      window.maximize()
      window.show()
    }
  } catch (error) {
    await closeStaleWindow(false)
    throw error
  }
}

export function closeDesktopWindow(hostRef: string): void {
  const entry = windows.get(hostRef)
  if (entry && !entry.window.isDestroyed()) {
    entry.window.close()
  }
  // Map cleanup happens in the 'closed' event handler installed in openDesktopWindow
}

export async function closeAllDesktopWindows(): Promise<void> {
  const retirements = [...windows.values()].map(async entry => entry.retire())
  const results = await Promise.allSettled(retirements)
  const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not retire every desktop host window')
  }
}

export function isDesktopWindowOpen(hostRef: string): boolean {
  const entry = windows.get(hostRef)
  return !!entry && !entry.window.isDestroyed()
}
