import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TableHeaderRow } from '../TableHeaderRow'

afterEach(cleanup)

describe('TableHeaderRow', () => {
  it('does not compact a wide action column unless the column opts in', () => {
    render(
      <table>
        <thead>
          <TableHeaderRow
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'actions', label: 'Actions', width: '7rem', align: 'right' },
            ]}
          />
        </thead>
      </table>
    )

    const actions = screen.getByRole('columnheader', { name: 'Actions' })
    expect(actions).toHaveClass('eft-table__header--text')
    expect(actions).not.toHaveClass('eft-table__header--actions')
    expect(actions).toHaveStyle({ width: '7rem' })
  })

  it('uses compact action styling when a table declares an action-menu column', () => {
    render(
      <table>
        <thead>
          <TableHeaderRow
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'menu', label: 'Actions', kind: 'actions', width: '3.5rem' },
            ]}
          />
        </thead>
      </table>
    )

    expect(screen.getByRole('columnheader', { name: 'Actions' })).toHaveClass(
      'eft-table__header--actions'
    )
  })
})
