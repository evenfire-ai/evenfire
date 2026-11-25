// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import {
  installChromiumFocusShim,
  uninstallChromiumFocusShim,
} from './__fixtures__/chromiumFocusShim'

function mount(html: string) {
  document.body.innerHTML = `<button id="before">before</button>${html}`
  const before = document.getElementById('before') as HTMLButtonElement
  before.focus()
  return before
}

afterEach(() => {
  uninstallChromiumFocusShim()
  document.body.innerHTML = ''
})

describe('chromiumFocusShim', () => {
  it.each([
    [
      'visibility: hidden on an ancestor',
      '<div style="visibility: hidden"><button id="t"></button></div>',
      'visibility-hidden',
    ],
    [
      'visibility: hidden on the element',
      '<button id="t" style="visibility: hidden"></button>',
      'visibility-hidden',
    ],
    [
      'display: none on an ancestor',
      '<div style="display: none"><button id="t"></button></div>',
      'display-none',
    ],
    ['an inert ancestor', '<div inert><button id="t"></button></div>', 'inert'],
  ])('refuses focus with %s, as Chromium does', (_name, html, reason) => {
    const before = mount(html)
    const shim = installChromiumFocusShim()
    document.getElementById('t')!.focus()
    expect(document.activeElement).toBe(before)
    expect(shim.calls.map(call => call.rejected)).toEqual([reason])
  })

  it('refuses focus on a detached element', () => {
    const before = mount('')
    const shim = installChromiumFocusShim()
    document.createElement('button').focus()
    expect(document.activeElement).toBe(before)
    expect(shim.calls.map(call => call.rejected)).toEqual(['disconnected'])
  })

  it('delegates a visible element to the real focus and records where the call came from', () => {
    mount('<button id="t"></button>')
    const shim = installChromiumFocusShim()
    const target = document.getElementById('t')!
    target.focus()
    expect(document.activeElement).toBe(target)
    expect(shim.calls).toHaveLength(1)
    expect(shim.calls[0]!.rejected).toBeNull()
    expect(shim.callsFrom('chromiumFocusShim.test')).toHaveLength(1)
  })

  it('restores jsdom focus on uninstall', () => {
    const before = mount('<div style="visibility: hidden"><button id="t"></button></div>')
    installChromiumFocusShim().uninstall()
    document.getElementById('t')!.focus()
    expect(document.activeElement).not.toBe(before)
  })

  // Last in the file: user-event patches `focus` once per document, so this
  // must be the file's first `userEvent.setup()`.
  it("leaves user-event's focus wrapper in place, and a later install still applies", () => {
    const shim = installChromiumFocusShim()
    const shimFocus = HTMLElement.prototype.focus
    userEvent.setup()
    const wrapper = HTMLElement.prototype.focus
    expect(wrapper).not.toBe(shimFocus)

    shim.uninstall()
    expect(HTMLElement.prototype.focus).toBe(wrapper)
    mount('<div style="visibility: hidden"><button id="t"></button></div>')
    document.getElementById('t')!.focus()
    expect(document.activeElement).toBe(document.getElementById('t'))

    const before = mount('<div style="visibility: hidden"><button id="t"></button></div>')
    const again = installChromiumFocusShim()
    document.getElementById('t')!.focus()
    expect(document.activeElement).toBe(before)
    expect(again.calls.map(call => call.rejected)).toEqual(['visibility-hidden'])
  })
})
