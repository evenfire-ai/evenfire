// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The notification Inbox popover / global-search dropdowns live in `.top-bar`
// (AppHeader) inside the same content-panel stacking context as the fixed
// `.chat-drawer`. When the chat drawer is open the header must paint ABOVE it so
// the bell popover surfaces instead of being trapped behind the drawer column.
// jsdom does not resolve `var()`, so we assert the declared layer each element
// lands on and confirm the numeric ordering of those layers from tokens.css.

const tokensCss = readFileSync(
  path.join(process.cwd(), 'ui', 'src', 'styles', 'tokens.css'),
  'utf8'
)
const stylesCss = readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')

function layer(name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)`).exec(tokensCss)
  if (!match) throw new Error(`token --${name} not found`)
  return Number(match[1])
}

// The `.toast-stack` sits on a raw z-index literal (not a token) in styles.css.
// Read it from the real rule so a change there is reflected here instead of the
// assertion passing against a phantom constant (T4).
function toastStackZIndex(): number {
  const match = /\.toast-stack\s*\{[^}]*z-index:\s*(\d+)/.exec(stylesCss)
  if (!match) throw new Error('.toast-stack z-index not found')
  return Number(match[1])
}

beforeEach(() => {
  const style = document.createElement('style')
  style.dataset.testStyles = 'header-stacking'
  style.textContent = `${tokensCss}\n${stylesCss}`
  document.head.append(style)
})

afterEach(() => {
  document.querySelector('[data-test-styles="header-stacking"]')?.remove()
  document.body.innerHTML = ''
})

describe('chat drawer header stacking', () => {
  it('lifts the header above the chat drawer while the drawer is open', () => {
    document.body.innerHTML =
      '<section class="content-panel content-panel--chat-drawer-open">' +
      '<header class="top-bar"></header><aside class="chat-drawer"></aside></section>'
    const topBar = document.querySelector('.top-bar') as HTMLElement
    const drawer = document.querySelector('.chat-drawer') as HTMLElement

    // Header is raised to the dropdown layer; the drawer stays at chat-overlay.
    expect(getComputedStyle(topBar).zIndex).toBe('var(--layer-dropdown)')
    expect(getComputedStyle(drawer).zIndex).toBe('var(--layer-chat-overlay)')
    // The dropdown layer paints ABOVE the chat-overlay layer, so the notification
    // Inbox popover surfaces over the drawer instead of behind it.
    expect(layer('layer-dropdown')).toBeGreaterThan(layer('layer-chat-overlay'))
    // Toasts still sit above the raised header (no occlusion of the toast stack).
    expect(toastStackZIndex()).toBeGreaterThan(layer('layer-dropdown'))
  })

  it('anchors the top-bar to the left of the drawer column while the drawer is open', () => {
    // jsdom does not resolve `calc(var(...))`, so assert the declared rule text:
    // with the drawer open the top-bar's `right` is offset by the drawer width so
    // its right-aligned box lives in the embed column instead of over the drawer,
    // while the z-lift to the dropdown layer (593d7f5c) is preserved.
    const rule = /\.content-panel--chat-drawer-open \.top-bar\s*\{([^}]*)\}/.exec(stylesCss)
    expect(rule).not.toBeNull()
    const body = rule![1] ?? ''
    const right = /right:\s*([^;]+);/.exec(body)
    expect(right).not.toBeNull()
    expect(right![1]).toContain('--chat-drawer-width')
    expect(body).toContain('z-index: var(--layer-dropdown)')
  })

  it('reserves mounted-header space for the relocated top-bar so app actions do not flow under it', () => {
    // Regression guard: when the top-bar moves into the embed column, the sandbox-ui
    // mounted header must reserve its footprint (search + gap + bell) on the right,
    // not 0 — otherwise the app action buttons render under the global search box.
    const rule = /\.content-panel--chat-drawer-open \.sandbox-ui-mounted-header\s*\{([^}]*)\}/.exec(
      stylesCss
    )
    expect(rule).not.toBeNull()
    const padding = /padding-right:\s*([^;]+);/.exec(rule![1] ?? '')
    expect(padding).not.toBeNull()
    expect(padding![1].trim()).not.toBe('0')
    expect(padding![1]).toContain('--app-notification-drawer-width')
  })

  it('documents the baseline: the header layer is below the drawer when it is not open', () => {
    document.body.innerHTML =
      '<section class="content-panel"><header class="top-bar"></header></section>'
    const topBar = document.querySelector('.top-bar') as HTMLElement
    expect(getComputedStyle(topBar).zIndex).toBe('var(--layer-header)')
    // This is exactly why the un-lifted header would hide behind the chat drawer.
    expect(layer('layer-header')).toBeLessThan(layer('layer-chat-overlay'))
  })
})
