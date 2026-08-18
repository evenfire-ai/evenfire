import { useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
})
