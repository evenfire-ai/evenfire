// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GfsInheritedAccessDialog } from '../GfsInheritedAccessDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GfsInheritedAccessDialog', () => {
  const changeRequest = {
    mode: 'change-role' as const,
    memberLabel: 'Test Two',
    fileName: 'report.txt',
    folders: [{ name: 'Team folder', currentRole: 'editor' as const }],
    fileCurrentRole: 'editor' as const,
    nextRole: 'read' as const,
  }

  it('renders the before/after list for a role change', () => {
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

  // R1-H1 — removal lists EVERY affected folder plus the file, each dropping
  // to Remove, with Drive's exact wording.
  it('lists every affected folder for a removal', () => {
    render(
      <GfsInheritedAccessDialog
        request={{
          mode: 'remove',
          memberLabel: 'Test Two',
          fileName: 'report.txt',
          folders: [
            { name: 'Campaigns', currentRole: 'editor' },
            { name: 'Marketing', currentRole: 'read' },
          ],
          fileCurrentRole: 'editor',
        }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('Remove from parent folder?')).toBeTruthy()
    expect(
      within(dialog).getByText(
        /Removing Test Two from this item will also remove them from a parent folder\. Alternatively, create a folder with limited access\./
      )
    ).toBeTruthy()
    // Each affected folder keeps its own current role and drops to Remove…
    expect(within(dialog).getByText('Campaigns')).toBeTruthy()
    expect(within(dialog).getByText('Marketing')).toBeTruthy()
    // …and so does the file (effective role -> Remove).
    expect(within(dialog).getByText('report.txt')).toBeTruthy()
    expect(within(dialog).getAllByText('Editor')).toHaveLength(2)
    expect(within(dialog).getAllByText('Read')).toHaveLength(1)
    // Three transitions to Remove: both folders plus the file (the fourth
    // "Remove" text is the confirm button).
    expect(
      within(dialog).getAllByText('Remove', {
        selector: '.da-gfs-parent-update-dialog__role--next',
      })
    ).toHaveLength(3)
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

  // R1-L2 — the dialog describes itself and restores focus on close, matching
  // the control-ui counterpart.
  it('is described by its body and restores focus to the opener on close', async () => {
    function Harness({ request }: { request: typeof changeRequest | null }) {
      return (
        <div>
          <button type="button">Open share dialog</button>
          <GfsInheritedAccessDialog
            busy={false}
            request={request}
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
          />
        </div>
      )
    }

    const { rerender } = render(<Harness request={null} />)
    const opener = screen.getByRole('button', { name: 'Open share dialog' })
    opener.focus()
    expect(document.activeElement).toBe(opener)

    rerender(<Harness request={changeRequest} />)
    const dialog = screen.getByRole('alertdialog')
    // The body copy is programmatically associated with the dialog…
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const describedBody = document.getElementById(describedBy ?? '')
    expect(describedBody?.textContent).toContain('will also change permissions on a parent folder')
    // …focus lands on the safe cancel action while open…
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'))

    // …and returns to the invoking element once the request clears.
    rerender(<Harness request={null} />)
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})
