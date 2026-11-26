import { expect } from 'vitest'

/**
 * An EvenDrive menu item that is offered but cannot run: focusable, marked
 * `aria-disabled` and explaining why in its tooltip. An item held back only by
 * an in-flight change is natively disabled instead and has no reason.
 */
export function expectUnavailable(item: HTMLElement | null, reason: string) {
  expect(item).not.toBeNull()
  expect(item?.getAttribute('aria-disabled')).toBe('true')
  expect((item as HTMLButtonElement).disabled).toBe(false)
  expect(item?.getAttribute('title')).toBe(reason)
}

/** Offered and runnable: present, and neither natively nor `aria-disabled`. */
export function isMenuItemEnabled(item: HTMLElement | null): boolean {
  if (!item) return false
  return !(item as HTMLButtonElement).disabled && item.getAttribute('aria-disabled') !== 'true'
}
