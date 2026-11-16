// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { shouldDeferCompactSidebarEscape } from '../index'

describe('compact sidebar Escape arbitration', () => {
  it('yields for a mounted sidebar menu or its exact current-owner admission gap', () => {
    expect(
      shouldDeferCompactSidebarEscape(null, {
        phase: 'open',
        menuOpen: true,
        admissionPending: false,
      })
    ).toBe(true)
    expect(
      shouldDeferCompactSidebarEscape(null, {
        phase: 'open',
        menuOpen: false,
        admissionPending: true,
      })
    ).toBe(true)
  })

  it('does not retain compact navigation for a closed menu or Replace owner', () => {
    expect(
      shouldDeferCompactSidebarEscape(null, {
        phase: 'open',
        menuOpen: false,
        admissionPending: false,
      })
    ).toBe(false)
    expect(
      shouldDeferCompactSidebarEscape(null, {
        phase: 'replace',
        menuOpen: false,
        admissionPending: false,
      })
    ).toBe(false)
  })

  it('recognizes a marked portaled Share panel independently of event target ancestry', () => {
    const flyout = document.createElement('div')
    flyout.dataset.presentation = 'sidebar-context'
    const child = document.createElement('button')
    flyout.append(child)
    expect(shouldDeferCompactSidebarEscape(child, null)).toBe(true)
  })
})
