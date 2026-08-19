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
    expect(4000).toBeGreaterThan(layer('layer-dropdown'))
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
