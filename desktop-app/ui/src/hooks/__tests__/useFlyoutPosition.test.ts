// @vitest-environment jsdom
import type { RefObject } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useFlyoutPosition } from '../useFlyoutPosition'

// jsdom performs no layout, so every getBoundingClientRect is 0. Stub it
// per-element to give the hook the geometry it reads.
function stubRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
): void {
  el.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect
}

function ref<T extends HTMLElement>(el: T): RefObject<T | null> {
  return { current: el }
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('useFlyoutPosition — portaled anchor bounds wiring', () => {
  it('resolves bounds from boundsAnchorRef when the position anchor is portaled outside the drawer', () => {
    // Real widths: jsdom reports 0, and a zero-width bounds rect makes the hook
    // fall back to the viewport, which would hide the very bug under test. Give
    // the drawer a real rect docked to the right of a 1200px viewport.
    window.innerWidth = 1200
    window.innerHeight = 1000

    // The confining ancestor and its in-tree trigger (the boundsAnchor).
    const drawer = document.createElement('div')
    drawer.className = 'chat-drawer'
    stubRect(drawer, { left: 400, top: 0, width: 300, height: 800 })
    const trigger = document.createElement('button')
    drawer.appendChild(trigger)
    document.body.appendChild(drawer)

    // The position anchor (row-dots button) is portaled to body, OUTSIDE the
    // drawer — so anchor.closest('.chat-drawer') is null.
    const anchor = document.createElement('button')
    stubRect(anchor, { left: 650, top: 100, width: 20, height: 20 })
    document.body.appendChild(anchor)

    const flyout = document.createElement('span')
    stubRect(flyout, { left: 0, top: 0, width: 210, height: 300 })
    document.body.appendChild(flyout)

    // Stable ref identities across renders: the hook keys its effect/callback
    // off ref identity, so recreating them each render would loop forever.
    const anchorRef = ref(anchor)
    const flyoutRef = ref(flyout)
    const boundsAnchorRef = ref(trigger)

    const { result } = renderHook(() =>
      useFlyoutPosition({
        anchorRef,
        flyoutRef,
        boundsAnchorRef,
        boundsSelector: '.chat-drawer',
        open: true,
        placement: 'right-of',
      })
    )

    // Observable result: the submenu is confined to the DRAWER, not the
    // viewport. Anchor hugs the drawer's right edge, so 'right-of' would
    // overflow area.right (692) and flips to the anchor's left:
    //   candidateLeft = anchor.left - width - gap = 650 - 210 - 6 = 434
    //   clamp(434, [408, 482]) = 434
    // Without boundsAnchorRef the anchor can't reach the drawer, bounds become
    // the viewport, no flip fires and left = anchor.right + gap = 676. Pinning
    // 434 is what fails against the parent (which lacks boundsAnchorRef).
    expect(result.current).toEqual({ left: 434, top: 100 })
  })
})
