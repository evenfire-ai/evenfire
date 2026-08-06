import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RowActionsMenu } from '../RowActionsMenu'

afterEach(cleanup)

describe('RowActionsMenu', () => {
  it('renders its open menu in a document portal so scroll containers cannot clip it', () => {
    render(
      <div style={{ overflow: 'auto' }}>
        <RowActionsMenu
          ariaLabel="Entry actions"
          actions={[{ key: 'edit', label: 'Edit', onClick: vi.fn() }]}
        />
      </div>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Entry actions' }))

    const menu = screen.getByRole('menu')
    expect(menu).toHaveClass('cu-kebab__menu--portal')
    expect(menu.parentElement).toBe(document.body)
  })
})
