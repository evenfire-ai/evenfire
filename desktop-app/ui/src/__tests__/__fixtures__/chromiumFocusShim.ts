/**
 * Chromium's focus boundary, which jsdom does not enforce.
 *
 * jsdom moves focus to any focusable element, including one that is hidden,
 * inside `display: none`, inside `[inert]` or detached. Chromium (and so
 * Electron) refuses all four and leaves `document.activeElement` where it was.
 * A renderer test that asserts focus after an effect focused a still-hidden
 * element passes in jsdom and fails in the app. Each rejection below is
 * confirmed in headless Chromium by
 * `desktop-app/test/e2e-playwright/chromium-focus-boundary.spec.ts`; change one
 * only together with that probe.
 *
 * The shim also records every call so a test can bound how often a component
 * applies focus. Each record names its origin: the first stack frame outside
 * this file.
 */

export type FocusRejection = 'disconnected' | 'visibility-hidden' | 'display-none' | 'inert'

export type FocusCall = {
  element: HTMLElement
  /** `null` when the call was delegated to the real `focus()`. */
  rejected: FocusRejection | null
  /** First stack frame outside the shim, e.g. `.../GfsResourceMenu/index.tsx:331:20`. */
  origin: string
}

export type ChromiumFocusShim = {
  readonly calls: readonly FocusCall[]
  /** Calls whose origin frame contains `fragment` (a file path or module name). */
  callsFrom(fragment: string): FocusCall[]
  reset(): void
  uninstall(): void
}

let installed: {
  descriptor: PropertyDescriptor
  shim: HTMLElement['focus']
} | null = null

export function chromiumFocusRejection(element: HTMLElement): FocusRejection | null {
  if (!element.isConnected) return 'disconnected'
  if (element.closest('[inert]')) return 'inert'
  const view = element.ownerDocument.defaultView
  if (!view) return 'disconnected'
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (view.getComputedStyle(node).display === 'none') return 'display-none'
  }
  // jsdom resolves inherited `visibility`, so the element's own computed value
  // already reflects a hidden ancestor.
  if (view.getComputedStyle(element).visibility === 'hidden') return 'visibility-hidden'
  return null
}

// user-event wraps `focus` the first time a test calls `userEvent.setup()`, so
// its wrapper can sit between the caller and the shim.
const NOT_AN_ORIGIN = ['__fixtures__/chromiumFocusShim', '@testing-library/user-event']

function callerOrigin(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1)
  const outside = frames.find(frame => !NOT_AN_ORIGIN.some(fragment => frame.includes(fragment)))
  return outside?.trim() ?? 'unknown'
}

export function installChromiumFocusShim(): ChromiumFocusShim {
  if (installed) throw new Error('the Chromium focus shim is already installed')
  // user-event replaces `focus` with a getter-only accessor, so the property
  // is swapped and restored through its descriptor, not by assignment.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')
  if (!descriptor) throw new Error('HTMLElement.prototype.focus is not defined')
  const original = HTMLElement.prototype.focus
  const calls: FocusCall[] = []
  const shim = function focus(this: HTMLElement, options?: FocusOptions) {
    // A wrapper installed over the shim (user-event's) keeps calling it after
    // uninstall; from then on it only delegates.
    if (installed?.shim !== shim) return original.call(this, options)
    const rejected = chromiumFocusRejection(this)
    calls.push({ element: this, rejected, origin: callerOrigin() })
    if (rejected) return
    original.call(this, options)
  }
  installed = { descriptor, shim }
  Object.defineProperty(HTMLElement.prototype, 'focus', {
    configurable: true,
    writable: true,
    value: shim,
  })
  return {
    calls,
    callsFrom: fragment => calls.filter(call => call.origin.includes(fragment)),
    reset: () => {
      calls.length = 0
    },
    uninstall: uninstallChromiumFocusShim,
  }
}

export function uninstallChromiumFocusShim() {
  if (!installed) return
  // user-event patches `focus` once per document and marks it as patched, so
  // overwriting its wrapper here would leave it unpatched for every later
  // test. When something wrapped the shim, the wrapper stays and the shim
  // turns into a pass-through.
  if (HTMLElement.prototype.focus === installed.shim) {
    Object.defineProperty(HTMLElement.prototype, 'focus', installed.descriptor)
  }
  installed = null
}
