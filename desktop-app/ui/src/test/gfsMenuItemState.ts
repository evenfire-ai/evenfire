import { expect } from 'vitest'

/**
 * An EvenDrive menu item that is offered but cannot run: focusable, marked
 * `aria-disabled` and explaining why in its tooltip.
 */
export function expectUnavailable(item: HTMLElement | null, reason: string) {
  expect(item).not.toBeNull()
  expect(item?.getAttribute('aria-disabled')).toBe('true')
  expect((item as HTMLButtonElement).disabled).toBe(false)
  expect(item?.getAttribute('title')).toBe(reason)
}

/**
 * Held back only by an in-flight change: as focusable and `aria-disabled` as
 * an unavailable item, but with no reason to show.
 */
export function expectInert(item: HTMLElement | null) {
  expect(item).not.toBeNull()
  expect(item?.getAttribute('aria-disabled')).toBe('true')
  expect((item as HTMLButtonElement).disabled).toBe(false)
  expect(item?.hasAttribute('title')).toBe(false)
}

/** Offered and runnable: present, and neither natively disabled nor `aria-disabled`. */
export function isMenuItemEnabled(item: HTMLElement | null): boolean {
  if (!item) return false
  return !(item as HTMLButtonElement).disabled && item.getAttribute('aria-disabled') !== 'true'
}
