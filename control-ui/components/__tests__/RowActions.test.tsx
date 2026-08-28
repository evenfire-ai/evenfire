import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RowActions } from '../RowActions'
import type { RowAction, RowActionKind } from '../RowActions/types'

afterEach(cleanup)

function action(key: string, kind: RowActionKind, label: string): RowAction {
  return { key, kind, label, icon: <span aria-hidden="true" />, onSelect: vi.fn() }
}

function labels() {
  return screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))
}

describe('RowActions', () => {
  it('orders actions by kind, not by array order', () => {
    render(
      <RowActions
        overflowAfter={4}
        actions={[
          action('open', 'inspect', 'Open'),
          action('delete', 'destructive', 'Delete'),
          action('copy', 'utility', 'Copy'),
          action('edit', 'edit', 'Edit'),
        ]}
      />
    )

    expect(labels()).toEqual(['Copy', 'Edit', 'Delete', 'Open'])
  })

  it('omits hidden actions so a row can drop an affordance it cannot support', () => {
    render(
      <RowActions
        actions={[
          action('edit', 'edit', 'Edit'),
          { ...action('delete', 'destructive', 'Delete'), hidden: true },
        ]}
      />
    )

    expect(labels()).toEqual(['Edit'])
  })

  it('collapses all but destructive and inspect once past the overflow threshold', () => {
    render(
      <RowActions
        overflowAfter={3}
        actions={[
          action('copy', 'utility', 'Copy'),
          action('download', 'utility', 'Download'),
          action('edit', 'edit', 'Edit'),
          action('delete', 'destructive', 'Delete'),
          action('open', 'inspect', 'Open'),
        ]}
      />
    )

    // Delete stays reachable in one click; the rest move behind the kebab.
    expect(labels()).toEqual(['More actions', 'Delete', 'Open'])
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute(
      'aria-haspopup',
      'menu'
    )
  })

  it('keeps every action inline when it fits within the threshold', () => {
    render(
      <RowActions
        overflowAfter={3}
        actions={[
          action('copy', 'utility', 'Copy'),
          action('edit', 'edit', 'Edit'),
          action('delete', 'destructive', 'Delete'),
        ]}
      />
    )

    expect(labels()).toEqual(['Copy', 'Edit', 'Delete'])
  })

  it('supplies the chevron for inspect so every table opens details the same way', () => {
    render(
      <RowActions actions={[{ key: 'open', kind: 'inspect', label: 'Open', onSelect: vi.fn() }]} />
    )

    expect(screen.getByRole('button', { name: 'Open' }).querySelector('svg')).toBeInTheDocument()
  })
})
