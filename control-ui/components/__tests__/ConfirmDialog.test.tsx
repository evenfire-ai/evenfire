import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useConfirmDialog } from '../ConfirmDialog'
import type { ConfirmDialogOptions } from '../ConfirmDialog/types'

afterEach(cleanup)

// Drives the real hook: opens a confirm with the given options on mount and
// renders the dialog element it returns, so the test exercises the same
// aria wiring the surfaces use.
function ConfirmHarness({ options }: { options: ConfirmDialogOptions }) {
  const { confirm, confirmDialog } = useConfirmDialog()
  useEffect(() => {
    void confirm(options)
  }, [confirm, options])
  return confirmDialog
}

function DismissHarness() {
  const { confirm, confirmDialog } = useConfirmDialog()
  const [outcome, setOutcome] = useState('pending')
  useEffect(() => {
    void confirm({ message: 'Discard this change?', title: 'Discard changes' }).then(result => {
      setOutcome(result ? 'confirmed' : 'dismissed')
    })
  }, [confirm])
  return (
    <>
      <output>{outcome}</output>
      {confirmDialog}
    </>
  )
}

function ChooseOutcomeHarness() {
  const { choose, confirmDialog } = useConfirmDialog()
  const [outcome, setOutcome] = useState('pending')
  useEffect(() => {
    void choose({ message: 'Save or discard?', title: 'Unsaved changes' }).then(setOutcome)
  }, [choose])
  return (
    <>
      <output>{outcome}</output>
      {confirmDialog}
    </>
  )
}

describe('ConfirmDialog accessibility', () => {
  it('names the details block in the alertdialog accessible description', () => {
    render(
      <ConfirmHarness
        options={{
          title: 'Model still in use',
          message: 'Disabling this model would strand its references.',
          details: <span>Impacted: team-a/reader, team-b/writer</span>,
          confirmLabel: 'Disable anyway',
          tone: 'danger',
        }}
      />
    )

    // Observable result (T4): what a screen reader announces as the dialog's
    // description must include the impact details the operator must see before
    // confirming a destructive action — not just the lead message.
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription(
      /Disabling this model would strand its references\.[\s\S]*Impacted: team-a\/reader, team-b\/writer/
    )
  })

  it('leaves the description at the message alone when there are no details', () => {
    render(<ConfirmHarness options={{ title: 'Confirm', message: 'Proceed with the change?' }} />)

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription('Proceed with the change?')
  })

  it('treats a backdrop click as dismissal instead of confirmation', async () => {
    render(<DismissHarness />)

    fireEvent.mouseDown(document.querySelector('.cu-modal-backdrop') as HTMLElement)

    await waitFor(() => expect(screen.getByText('dismissed')).toBeInTheDocument())
  })

  it('normalizes Escape to the same cancel outcome as the Cancel button', async () => {
    render(<ChooseOutcomeHarness />)

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.getByText('cancel')).toBeInTheDocument())
  })

  it('normalizes backdrop dismissal to the same cancel outcome as the Cancel button', async () => {
    render(<ChooseOutcomeHarness />)

    fireEvent.mouseDown(document.querySelector('.cu-modal-backdrop') as HTMLElement)

    await waitFor(() => expect(screen.getByText('cancel')).toBeInTheDocument())
  })
})
