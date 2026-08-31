import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import {
  DataTable,
  RowActionMenu,
  TableHeaderCell,
  TableRow,
  stableSortRows,
} from '@clerum/frontend-table-system'

describe('shared frontend table system', () => {
  it('exposes sortable header state and a keyboard sort control', () => {
    const onSort = vi.fn()
    render(
      <DataTable>
        <thead>
          <tr>
            <TableHeaderCell activeDirection="asc" label="Name" onSort={onSort} />
          </tr>
        </thead>
      </DataTable>
    )

    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Name descending' }))
    expect(onSort).toHaveBeenCalledOnce()
  })

  it('uses stable explicit values and a deterministic identity tie-breaker', () => {
    const rows = [
      { id: 'b', name: 'Same' },
      { id: 'a', name: 'Same' },
      { id: 'c', name: null },
    ]

    expect(
      stableSortRows(
        rows,
        row => row.name,
        'asc',
        row => row.id
      ).map(row => row.id)
    ).toEqual(['a', 'b', 'c'])
    expect(
      stableSortRows(
        rows,
        row => row.name,
        'desc',
        row => row.id
      ).map(row => row.id)
    ).toEqual(['a', 'b', 'c'])
  })

  it('supports pointer and keyboard row navigation without hijacking child actions', () => {
    const onNavigate = vi.fn()
    const onChild = vi.fn()
    render(
      <DataTable>
        <tbody>
          <TableRow onNavigate={onNavigate}>
            <td>Record</td>
            <td>
              <button onClick={onChild}>Child action</button>
              <a href="/elsewhere">Child link</a>
              <input aria-label="Child selection" type="checkbox" />
            </td>
          </TableRow>
        </tbody>
      </DataTable>
    )

    const row = screen.getByRole('row')
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Child action' }))
    expect(onChild).toHaveBeenCalledOnce()
    expect(onNavigate).toHaveBeenCalledTimes(2)

    for (const child of [
      screen.getByRole('button', { name: 'Child action' }),
      screen.getByRole('link', { name: 'Child link' }),
      screen.getByRole('checkbox', { name: 'Child selection' }),
    ]) {
      fireEvent.keyDown(child, { key: 'Enter' })
      fireEvent.keyDown(child, { key: ' ' })
    }
    expect(onNavigate).toHaveBeenCalledTimes(2)
  })

  it('opens one accessible action menu and executes its destructive action', () => {
    const onDelete = vi.fn()
    render(
      <RowActionMenu
        ariaLabel="Actions for Alpha"
        actions={[{ key: 'delete', label: 'Delete', danger: true, onSelect: onDelete }]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Alpha' }))
    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
