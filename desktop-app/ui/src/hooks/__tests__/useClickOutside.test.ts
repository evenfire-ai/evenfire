// @vitest-environment jsdom
import { createElement, useRef } from 'react'
import type { RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useClickOutside } from '../useClickOutside'

afterEach(cleanup)

// Renders `count` boxes (each carrying a ref) plus an outside box, wires the
// hook to the requested refs, and hands the boxes back for firing events.
function renderHarness(refCount: 1 | 2, onOutside: () => void) {
  function Harness() {
    const a = useRef<HTMLDivElement | null>(null)
    const b = useRef<HTMLDivElement | null>(null)
    const refs: RefObject<HTMLDivElement | null> | Array<RefObject<HTMLDivElement | null>> =
      refCount === 1 ? a : [a, b]
    useClickOutside(refs, true, onOutside)
    return createElement(
      'div',
      null,
      createElement('div', { ref: a, 'data-testid': 'a' }, 'a'),
      createElement('div', { ref: b, 'data-testid': 'b' }, 'b'),
      createElement('div', { 'data-testid': 'outside' }, 'outside')
    )
  }
  return render(createElement(Harness))
}

describe('useClickOutside', () => {
  it('single ref: fires only for clicks outside that ref (unchanged behavior)', () => {
    const onOutside = vi.fn()
    const { getByTestId } = renderHarness(1, onOutside)

    fireEvent.mouseDown(getByTestId('a'))
    expect(onOutside).not.toHaveBeenCalled()

    fireEvent.mouseDown(getByTestId('outside'))
    expect(onOutside).toHaveBeenCalledTimes(1)
  })

  it('multi ref: a click inside ANY provided ref does not count as outside', () => {
    const onOutside = vi.fn()
    const { getByTestId } = renderHarness(2, onOutside)

    // This is the portaled-submenu case: the click lands in the second ref
    // (outside the first), and must not close the menu.
    fireEvent.mouseDown(getByTestId('b'))
    expect(onOutside).not.toHaveBeenCalled()

    fireEvent.mouseDown(getByTestId('a'))
    expect(onOutside).not.toHaveBeenCalled()

    fireEvent.mouseDown(getByTestId('outside'))
    expect(onOutside).toHaveBeenCalledTimes(1)
  })
})
