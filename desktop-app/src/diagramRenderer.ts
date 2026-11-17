import { BrowserWindow, type Session, session } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DiagramDrawRequest, DiagramDrawResult } from './types.js'

/**
 * Draws the chat's Mermaid diagrams in a hidden window of their own.
 *
 * Mermaid lays a diagram out on the main thread of the page that draws it, and
 * some code keeps it busy for minutes; in the UI renderer that would freeze the
 * app with no way to stop it. Here each diagram is drawn in a separate renderer
 * process: a sandboxed hidden window with no preload, an in-memory session that
 * refuses every request outside the app's own files, and a strict policy in its
 * page. The main process sends one diagram at a time and, when one takes too
 * long, kills that process; the next diagram starts a new one.
 */

/** The main process's own copies of the chat's limits. */
export const DIAGRAM_MAX_CODE_CHARS = 20_000
export const DIAGRAM_MIN_WIDTH_PX = 100
export const DIAGRAM_MAX_WIDTH_PX = 4_000
export const DIAGRAM_MAX_IMAGE_URL_CHARS = 4 * 1024 * 1024
export const DIAGRAM_MAX_IMAGE_SIDE_PX = 100_000

export const DIAGRAM_START_TIMEOUT_MS = 20_000
export const DIAGRAM_DRAW_TIMEOUT_MS = 10_000
export const DIAGRAM_IDLE_CLOSE_MS = 120_000
export const DIAGRAM_MAX_WAITING = 64

const DIAGRAM_PARTITION = 'diagram-renderer'
const DIAGRAM_PAGE = 'diagram.html'
const IMAGE_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,'
const FONT_FAMILY_PATTERN = /^[\w\s"',.-]{1,200}$/
const MAX_REMEMBERED_TIMEOUTS = 64
const MAX_REASON_CHARS = 200
const MAX_LABEL_CHARS = 300

const INVALID: DiagramDrawResult = { ok: false, reason: 'The diagram request is not valid' }
const TIMED_OUT: DiagramDrawResult = { ok: false, reason: 'Drawing it took too long' }
// Retryable: the same code may draw once the renderer is back.
const NOT_STARTED: DiagramDrawResult = {
  ok: false,
  reason: 'The diagram renderer did not start',
  retryable: true,
}
const STOPPED: DiagramDrawResult = {
  ok: false,
  reason: 'The diagram renderer stopped',
  retryable: true,
}
const BUSY: DiagramDrawResult = {
  ok: false,
  reason: 'Too many diagrams are waiting',
  retryable: true,
}
const UNREADABLE: DiagramDrawResult = { ok: false, reason: 'The drawing could not be read' }

const TIMEOUT = Symbol('timeout')
const ENDED = Symbol('ended')

/** The page a diagram is drawn in, as the renderer that draws it sees it. */
export type DiagramSurface = {
  /** Resolves once the page can draw. */
  ready(): Promise<void>
  /** The page's answer for one diagram, not yet checked. */
  draw(request: DiagramDrawRequest): Promise<unknown>
  /** Ends the page's renderer process and closes it; safe to call again. */
  destroy(): void
  /** Runs when the page or its process goes away, closed or crashed. */
  onGone(listener: () => void): void
}

type OpenSurface = {
  surface: DiagramSurface
  ready: Promise<void>
  /**
   * Resolves when the surface is closed or goes away. A page whose process
   * died never answers, so whatever it was doing ends here instead.
   */
  ended: Promise<typeof ENDED>
  end: () => void
}

export type DiagramRendererOptions = {
  createSurface: () => DiagramSurface
  startTimeoutMs: number
  drawTimeoutMs: number
  idleCloseMs: number
  maxWaiting: number
}

function within<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** A draw request from the UI renderer, or null when any field is out of bounds. */
export function parseDiagramDrawRequest(input: unknown): DiagramDrawRequest | null {
  if (!input || typeof input !== 'object') return null
  const { code, theme, fontFamily, width } = input as Record<string, unknown>
  if (typeof code !== 'string' || !code.trim() || code.length > DIAGRAM_MAX_CODE_CHARS) return null
  if (theme !== 'dark' && theme !== 'light') return null
  if (typeof width !== 'number' || !Number.isInteger(width)) return null
  if (width < DIAGRAM_MIN_WIDTH_PX || width > DIAGRAM_MAX_WIDTH_PX) return null
  const font =
    typeof fontFamily === 'string' && FONT_FAMILY_PATTERN.test(fontFamily)
      ? fontFamily
      : 'sans-serif'
  return { code, theme, fontFamily: font, width }
}

function isSide(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= DIAGRAM_MAX_IMAGE_SIDE_PX
  )
}

/** The page's answer, kept only when it is the image or the reason it should be. */
export function readDiagramDrawAnswer(answer: unknown): DiagramDrawResult {
  if (!answer || typeof answer !== 'object') return UNREADABLE
  const value = answer as Record<string, unknown>
  if (value.ok === false) {
    const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
    return {
      ok: false,
      reason: reason.slice(0, MAX_REASON_CHARS) || 'Mermaid could not read the code',
    }
  }
  if (value.ok !== true || !value.image || typeof value.image !== 'object') return UNREADABLE
  const { src, width, height, label } = value.image as Record<string, unknown>
  if (typeof src !== 'string' || !src.startsWith(IMAGE_URL_PREFIX)) return UNREADABLE
  if (src.length > DIAGRAM_MAX_IMAGE_URL_CHARS || !isSide(width) || !isSide(height)) {
    return UNREADABLE
  }
  const text = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL_CHARS) : ''
  return { ok: true, image: { src, width, height, label: text || 'Diagram' } }
}

export class DiagramRenderer {
  private open: OpenSurface | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private waiting = 0
  // Moves on at every close(): what was asked for before opens no new window.
  private generation = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  // Code that never finished: refused at once for the rest of the session.
  private readonly timedOut: string[] = []

  constructor(private readonly options: DiagramRendererOptions) {}

  draw(input: unknown): Promise<DiagramDrawResult> {
    const request = parseDiagramDrawRequest(input)
    if (!request) return Promise.resolve(INVALID)
    if (this.timedOut.includes(request.code)) return Promise.resolve(TIMED_OUT)
    if (this.waiting >= this.options.maxWaiting) return Promise.resolve(BUSY)
    this.waiting += 1
    const generation = this.generation
    // Never rejects, so one failed drawing cannot stop the ones queued after it.
    const result = this.queue
      .then(() => this.drawNow(request, generation))
      .catch((): DiagramDrawResult => STOPPED)
    this.queue = result
    return result.finally(() => {
      this.waiting -= 1
    })
  }

  /**
   * Closes the drawing window, if any. Diagrams still waiting end without
   * opening another, so no window outlives the app's; the next diagram asked
   * for opens a new one.
   */
  close(): void {
    this.generation += 1
    this.cancelIdleClose()
    this.closeSurface()
  }

  private async drawNow(
    request: DiagramDrawRequest,
    generation: number
  ): Promise<DiagramDrawResult> {
    if (generation !== this.generation) return STOPPED
    this.cancelIdleClose()
    try {
      let open: OpenSurface
      try {
        open = this.openSurface()
        await open.ready
      } catch {
        this.closeSurface()
        return NOT_STARTED
      }
      // Closed or gone while it started.
      if (this.open !== open) return STOPPED
      let answer: unknown
      try {
        answer = await within(
          Promise.race([open.surface.draw(request), open.ended]),
          this.options.drawTimeoutMs
        )
      } catch {
        this.closeSurface(open)
        return STOPPED
      }
      // The window was closed or its process died: the code is not to blame.
      if (answer === ENDED) return STOPPED
      if (answer === TIMEOUT) {
        // A busy page never answers; ending its process is the only way to stop it.
        this.closeSurface(open)
        this.timedOut.push(request.code)
        if (this.timedOut.length > MAX_REMEMBERED_TIMEOUTS) this.timedOut.shift()
        return TIMED_OUT
      }
      return readDiagramDrawAnswer(answer)
    } finally {
      if (generation === this.generation) this.scheduleIdleClose()
    }
  }

  private openSurface(): OpenSurface {
    if (this.open) return this.open
    const surface = this.options.createSurface()
    let end = () => {}
    const ended = new Promise<typeof ENDED>(resolve => {
      end = () => resolve(ENDED)
    })
    // Started once the surface is registered below, so one that fails at once is still closed.
    const started = Promise.resolve().then(() => surface.ready())
    const ready = within(Promise.race([started, ended]), this.options.startTimeoutMs).then(
      outcome => {
        if (outcome === TIMEOUT || outcome === ENDED) {
          throw new Error('The diagram renderer did not start')
        }
      }
    )
    const open: OpenSurface = { surface, ready, ended, end }
    this.open = open
    surface.onGone(() => {
      if (this.open === open) this.open = null
      end()
      // A window whose process died stays open, and an open window keeps the
      // app running; close it once the event that reported it is over.
      setImmediate(() => surface.destroy())
    })
    return open
  }

  /** Ends the open surface; given one, only if it is still the open one. */
  private closeSurface(which: OpenSurface | null = this.open): void {
    const open = this.open
    if (!open || open !== which) return
    this.open = null
    open.end()
    open.surface.destroy()
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.closeSurface()
    }, this.options.idleCloseMs)
    this.idleTimer.unref?.()
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

/**
 * True for a file URL of a file inside the directory. Compared as paths, so a
 * URL that spells the same path differently, such as another drive letter case
 * on Windows, is still the app's own file.
 */
function isFileInside(requestUrl: string, directory: string, windows: boolean): boolean {
  if (!requestUrl.startsWith('file:')) return false
  let filePath: string
  try {
    filePath = fileURLToPath(requestUrl, { windows })
  } catch {
    return false
  }
  const paths = windows ? path.win32 : path.posix
  const relative = paths.relative(directory, filePath)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relative)
  )
}

/** The drawing page and the only requests its session lets through. */
export function diagramPageFor(input: { devUrl: string; uiDistDir: string; windows?: boolean }): {
  url: string
  allows: (requestUrl: string) => boolean
} {
  if (input.devUrl) {
    const base = input.devUrl.endsWith('/') ? input.devUrl : `${input.devUrl}/`
    const origin = new URL(base).origin
    return {
      url: new URL(DIAGRAM_PAGE, base).href,
      allows: requestUrl => requestUrl.startsWith(`${origin}/`) || requestUrl.startsWith('data:'),
    }
  }
  const windows = input.windows ?? process.platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  return {
    url: pathToFileURL(paths.join(input.uiDistDir, DIAGRAM_PAGE), { windows }).href,
    allows: requestUrl =>
      requestUrl.startsWith('data:') || isFileInside(requestUrl, input.uiDistDir, windows),
  }
}

const hardenedSessions = new WeakSet<Session>()

/** No permission, no download, and no request outside the drawing page's files. */
function applyDiagramSessionPolicies(ses: Session, allows: (requestUrl: string) => boolean): void {
  if (hardenedSessions.has(ses)) return
  hardenedSessions.add(ses)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', event => event.preventDefault())
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allows(details.url) })
  })
}

/** The production surface: a sandboxed hidden window that loads the drawing page. */
export function createHiddenDiagramSurface(page: {
  url: string
  allows: (requestUrl: string) => boolean
}): DiagramSurface {
  const partitionSession = session.fromPartition(DIAGRAM_PARTITION, { cache: false })
  applyDiagramSessionPolicies(partitionSession, page.allows)
  const window = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1600,
    height: 1200,
    webPreferences: {
      partition: DIAGRAM_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Hidden pages are throttled by default; drawing must not wait on that.
      backgroundThrottling: false,
      spellcheck: false,
      webgl: false,
      navigateOnDragDrop: false,
      disableDialogs: true,
      devTools: false,
    },
  })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', event => event.preventDefault())
  contents.on('will-redirect', event => event.preventDefault())
  contents.on('will-attach-webview', event => event.preventDefault())
  const goneListeners: Array<() => void> = []
  let gone = false
  const markGone = () => {
    if (gone) return
    gone = true
    for (const listener of goneListeners) listener()
  }
  contents.on('render-process-gone', markGone)
  window.on('closed', markGone)
  return {
    async ready() {
      await window.loadURL(page.url)
      const ready = await contents.executeJavaScript("typeof window.__drawDiagram === 'function'")
      if (ready !== true) throw new Error('The diagram page did not load')
    },
    draw: request => contents.executeJavaScript(`window.__drawDiagram(${JSON.stringify(request)})`),
    destroy() {
      if (window.isDestroyed()) return
      // A page stuck in a loop never answers a close: end its process first.
      if (!contents.isDestroyed()) contents.forcefullyCrashRenderer()
      window.destroy()
    },
    onGone: listener => {
      goneListeners.push(listener)
    },
  }
}
