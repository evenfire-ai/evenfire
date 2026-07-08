import type { KeyboardEvent } from 'react'

export type ClickableRowProps = {
  role: 'button'
  tabIndex: 0
  onClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  'aria-label'?: string
  'aria-pressed'?: boolean
}

/**
 * Returns the props needed to make any element behave like a clickable row:
 * mouse click + Enter/Space activation + button semantics.
 *
 * This is a plain helper, not a React hook — it doesn't track state, so it
 * can be called inside loops (e.g. .map() over rows) without breaking the
 * rules of hooks.
 *
 * Usage:
 *   <tr
 *     className="da-table__row--clickable"
 *     {...clickableRowProps(() => onSelect(row.id), {
 *       ariaLabel: `Open ${row.name}`,
 *       selected: row.id === selectedId,
 *     })}
 *   >
 *
 * Pair with `.da-table__row--clickable` (or any equivalent) for the matching
 * cursor + :focus-visible styles.
 *
 * Note: real <button> elements already provide all this behaviour natively —
 * don't use this helper there. Use it on <tr>, <li>, <div> rows that can't be
 * a <button> (e.g. inside a <table>).
 */
export function clickableRowProps(
  onActivate: () => void,
  options: { ariaLabel?: string; selected?: boolean } = {}
): ClickableRowProps {
  const { ariaLabel, selected } = options
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onActivate()
      }
    },
    ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
    ...(selected ? { 'aria-pressed': true as const } : {}),
  }
}
