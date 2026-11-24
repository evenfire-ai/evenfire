import { act, createEvent, fireEvent } from '@testing-library/react'

/**
 * One mouse for a jsdom test, emitting the event sequences headless Chromium
 * produces (recorded by
 * `desktop-app/test/e2e-playwright/chromium-focus-boundary.spec.ts`; change a
 * sequence here only together with that probe).
 *
 * The driver remembers what is under the pointer, so every command starts from
 * there. user-event is not used for the pointer: its own pointer state never
 * sees these events, and `user.click` adds a move that a click in place does
 * not have. Every event goes through `fireEvent(element, event)` rather than
 * the named helpers, because `fireEvent.mouseEnter` and friends also fire
 * `mouseover`/`pointerover`, which would double the boundary.
 */
export type PointerDriver = {
  /** The element under the pointer. */
  readonly at: Element
  /**
   * A real move from the current element to `target`. The first step of a
   * move is still inside its origin, then the boundary, then a move on the
   * target.
   */
  moveTo(target: Element): void
  /** A move of a pixel or so that stays over the same element. */
  microMove(): void
  /**
   * The element under a still pointer changes because the layout did (a panel
   * that appears, a scroll, a resize, or the element under it is removed):
   * boundary events only, no pointermove.
   */
  layoutShiftTo(target: Element): void
  /** A click in place. Chromium focuses the pressed control on mousedown. */
  click(): void
  /** A right-click in place: the pressed control takes focus before `contextmenu`. */
  contextClick(): void
}

const MOUSE: PointerEventInit = { pointerId: 1, pointerType: 'mouse', isPrimary: true }

const FOCUSABLE_ON_PRESS = 'button, a[href], input, select, textarea, [tabindex]'

function dispatch(
  factory: (node: Element, init?: object) => Event,
  node: Element,
  init: object = {}
) {
  return fireEvent(node, factory(node, { ...MOUSE, ...init }))
}

function boundary(from: Element, to: Element) {
  // A removed element gets no out/leave; the one revealed below it is entered
  // with the removed element as relatedTarget.
  if (!from.isConnected) {
    dispatch(createEvent.pointerOver, to, { relatedTarget: from })
    dispatch(createEvent.pointerEnter, to, { relatedTarget: from })
    dispatch(createEvent.mouseOver, to, { relatedTarget: from })
    dispatch(createEvent.mouseEnter, to, { relatedTarget: from })
    return
  }
  // Pointer boundaries for both elements first, then the mouse ones: the
  // order Chromium uses for a move and for a still-pointer layout change.
  dispatch(createEvent.pointerOut, from, { relatedTarget: to })
  dispatch(createEvent.pointerLeave, from, { relatedTarget: to })
  dispatch(createEvent.pointerOver, to, { relatedTarget: from })
  dispatch(createEvent.pointerEnter, to, { relatedTarget: from })
  dispatch(createEvent.mouseOut, from, { relatedTarget: to })
  dispatch(createEvent.mouseLeave, from, { relatedTarget: to })
  dispatch(createEvent.mouseOver, to, { relatedTarget: from })
  dispatch(createEvent.mouseEnter, to, { relatedTarget: from })
}

/** Chromium focuses the pressed control on mousedown, or drops focus to <body>. */
function focusOnPress(node: Element) {
  const control = node.closest<HTMLElement>(FOCUSABLE_ON_PRESS)
  act(() => {
    if (control && !(control as HTMLButtonElement).disabled) control.focus()
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
}

function requireConnected(node: Element) {
  // A move starts on what is under the pointer. Once that element is gone the
  // test must say what the pointer now rests on (`layoutShiftTo`).
  if (!node.isConnected) throw new Error('the element under the pointer was removed')
}

function move(node: Element) {
  dispatch(createEvent.pointerMove, node)
  dispatch(createEvent.mouseMove, node)
}

export function createPointerDriver(initial: Element): PointerDriver {
  let at = initial
  return {
    get at() {
      return at
    },
    moveTo(target) {
      requireConnected(at)
      move(at)
      if (target !== at) boundary(at, target)
      at = target
      move(at)
    },
    microMove() {
      requireConnected(at)
      move(at)
    },
    layoutShiftTo(target) {
      if (target !== at) boundary(at, target)
      at = target
    },
    click() {
      requireConnected(at)
      dispatch(createEvent.pointerDown, at, { buttons: 1 })
      if (dispatch(createEvent.mouseDown, at, { buttons: 1 })) focusOnPress(at)
      dispatch(createEvent.pointerUp, at)
      dispatch(createEvent.mouseUp, at)
      dispatch(createEvent.click, at)
    },
    contextClick() {
      requireConnected(at)
      const right = { button: 2, buttons: 2, clientX: 20, clientY: 20 }
      dispatch(createEvent.pointerDown, at, right)
      if (dispatch(createEvent.mouseDown, at, right)) focusOnPress(at)
      dispatch(createEvent.contextMenu, at, right)
      dispatch(createEvent.pointerUp, at, { button: 2 })
      dispatch(createEvent.mouseUp, at, { button: 2 })
      fireEvent(
        at,
        new MouseEvent('auxclick', { bubbles: true, cancelable: true, composed: true, button: 2 })
      )
    },
  }
}
