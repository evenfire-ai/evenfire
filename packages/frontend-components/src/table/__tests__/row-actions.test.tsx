import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RowActionMenu } from '../row-actions'

afterEach(cleanup)

function renderActionCell({ hasLink = false }: { hasLink?: boolean } = {}) {
  const onNavigate = vi.fn()
  const onSelect = vi.fn()
  const view = render(
    <table>
      <tbody>
        <tr onClick={onNavigate}>
          <td data-testid="actions-cell">
            {hasLink ? <a href="/details">Details</a> : null}
            <RowActionMenu
              actions={[{ key: 'open', label: 'Open record', onSelect }]}
              ariaLabel="Row actions"
            />
          </td>
        </tr>
      </tbody>
    </table>
  )
  return { ...view, onNavigate, onSelect }
}

describe('RowActionMenu table-cell interaction', () => {
  it('opens from the empty actions cell without adding a cell tab stop or navigating the row', async () => {
    const user = userEvent.setup()
    const { onNavigate, onSelect } = renderActionCell()
    const cell = screen.getByTestId('actions-cell')

    fireEvent.click(cell)

    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Open record' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Row actions' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(cell).not.toHaveAttribute('tabindex')
    expect(onNavigate).not.toHaveBeenCalled()

    await user.click(within(menu).getByRole('menuitem', { name: 'Open record' }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does not widen a mixed-control cell but keeps its real menu trigger operable', async () => {
    const user = userEvent.setup()
    const { onNavigate } = renderActionCell({ hasLink: true })
    const cell = screen.getByTestId('actions-cell')

    fireEvent.click(cell)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onNavigate).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Row actions' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })
})
