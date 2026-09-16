// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GfsInheritedAccessDialog } from '../GfsInheritedAccessDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GfsInheritedAccessDialog', () => {
  const changeRequest = {
    mode: 'change-role' as const,
    memberLabel: 'Test Two',
    parentFolderName: 'Team folder',
    fileName: 'report.txt',
    parentCurrentRole: 'editor' as const,
    fileCurrentRole: 'editor' as const,
    nextRole: 'read' as const,
  }

  it('renders the two-column before/after for a role change', () => {
    render(
      <GfsInheritedAccessDialog request={changeRequest} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('Update role on parent folder?')).toBeTruthy()
    expect(
      within(dialog).getByText(
        "Changing Test Two's permissions on this item will also change permissions on a parent folder. Alternatively, create a folder with limited access."
      )
    ).toBeTruthy()
    expect(within(dialog).getByText('Team folder')).toBeTruthy()
    expect(within(dialog).getByText('report.txt')).toBeTruthy()
    expect(within(dialog).getAllByText('Editor')).toHaveLength(2)
    expect(within(dialog).getAllByText('Read')).toHaveLength(2)
  })

  it('adapts to removal with the surviving direct role on the file column', () => {
    render(
      <GfsInheritedAccessDialog
        request={{
          mode: 'remove',
          memberLabel: 'Test Two',
          parentFolderName: 'Team folder',
          fileName: 'report.txt',
          parentCurrentRole: 'editor',
          fileCurrentRole: 'editor',
          fileRemainingRole: 'read',
        }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('Remove access on parent folder?')).toBeTruthy()
    // Parent column drops to No access; the file keeps its direct-only role.
    expect(within(dialog).getAllByText('No access')).toHaveLength(1)
    expect(within(dialog).getAllByText('Read')).toHaveLength(1)
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeTruthy()
  })

  it('opens the help panel from Learn more and returns to the confirmation', () => {
    render(
      <GfsInheritedAccessDialog request={changeRequest} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )

    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn more' }))
    expect(within(dialog).getByText('How sharing works in EvenDrive')).toBeTruthy()
    expect(
      within(dialog).getByText(
        "You can't give someone less access on a single file than they have on its parent folder."
      )
    ).toBeTruthy()
    expect(within(dialog).getByText(/create a folder with limited access/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(within(dialog).getByText('Update role on parent folder?')).toBeTruthy()
  })

  it('reports cancel and confirm to the caller', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <GfsInheritedAccessDialog request={changeRequest} onCancel={onCancel} onConfirm={onConfirm} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    rerender(
      <GfsInheritedAccessDialog request={changeRequest} onCancel={onCancel} onConfirm={onConfirm} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update role' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('renders nothing without a request', () => {
    const { container } = render(
      <GfsInheritedAccessDialog request={null} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )
    expect(container.firstElementChild).toBeNull()
  })
})
