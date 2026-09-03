import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TableEmptyRow } from '../TableEmptyRow'

afterEach(cleanup)

function renderInTable(node: React.ReactNode) {
  return render(
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Context</th>
        </tr>
      </thead>
      <tbody>{node}</tbody>
    </table>
  )
}

describe('TableEmptyRow', () => {
  it('keeps the column headers visible and spans them with the message', () => {
    const view = renderInTable(<TableEmptyRow colSpan={2} message="No agents match this search." />)

    // The header row is the point: an empty result must not unmount the table.
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByText('No agents match this search.')).toBeInTheDocument()
    expect(view.container.querySelector('td')).toHaveAttribute('colspan', '2')
  })

  it('offers a way out when the empty state came from a filter', async () => {
    const onSelect = vi.fn()
    renderInTable(
      <TableEmptyRow
        colSpan={2}
        message="No agents match this search."
        action={{ label: 'Clear search', onSelect }}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(onSelect).toHaveBeenCalledOnce()
  })
})
