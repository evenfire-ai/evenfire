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

  it('focuses the first enabled item and supports arrow-key navigation', () => {
    render(
      <RowActionsMenu
        ariaLabel="Entry actions"
        actions={[
          { key: 'disabled', label: 'Disabled', disabled: true, onClick: vi.fn() },
          { key: 'edit', label: 'Edit', onClick: vi.fn() },
          { key: 'delete', label: 'Delete', onClick: vi.fn() },
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Entry actions' }))

    const edit = screen.getByRole('menuitem', { name: 'Edit' })
    const deleteAction = screen.getByRole('menuitem', { name: 'Delete' })
    expect(edit).toHaveFocus()

    fireEvent.keyDown(edit, { key: 'ArrowDown' })
    expect(deleteAction).toHaveFocus()

    fireEvent.keyDown(deleteAction, { key: 'ArrowDown' })
    expect(edit).toHaveFocus()

    fireEvent.keyDown(edit, { key: 'ArrowUp' })
    expect(deleteAction).toHaveFocus()
  })

  it('opens on ArrowUp at the last item and restores trigger focus on Escape', () => {
    render(
      <RowActionsMenu
        ariaLabel="Entry actions"
        actions={[
          { key: 'edit', label: 'Edit', onClick: vi.fn() },
          { key: 'delete', label: 'Delete', onClick: vi.fn() },
        ]}
      />
    )

    const trigger = screen.getByRole('button', { name: 'Entry actions' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })

    const deleteAction = screen.getByRole('menuitem', { name: 'Delete' })
    expect(deleteAction).toHaveFocus()

    fireEvent.keyDown(deleteAction, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
