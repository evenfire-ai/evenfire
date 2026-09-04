import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DataTable,
  RowActionMenu,
  TableHeaderCell,
  TableRow,
  TableStateRow,
  TableViewport,
  TruncatedText,
  stableSortRows,
} from '@clerum/frontend-components'

function cssRule(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  expect(match, `Expected CSS rule for ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('shared frontend components', () => {
  it('owns the canonical viewport class and preserves semantic modifiers', () => {
    render(
      <TableViewport aria-label="Embedded results" className="cu-table-wrap" embedded>
        Results
      </TableViewport>
    )

    expect(screen.getByLabelText('Embedded results')).toHaveClass(
      'eft-table-viewport',
      'eft-table-viewport--embedded',
      'cu-table-wrap'
    )
  })

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

  it('defaults empty table copy and exposes full truncated text', () => {
    const longDescription =
      'This description is deliberately long enough to exceed the shared default bounded text length for table descriptions.'

    render(
      <DataTable>
        <tbody>
          <TableStateRow colSpan={2} />
          <tr>
            <td>
              <TruncatedText value={longDescription} />
            </td>
          </tr>
        </tbody>
      </DataTable>
    )

    expect(screen.getByText('No data')).toBeInTheDocument()
    expect(screen.getByText(/default bounde\.\.\./)).toBeInTheDocument()
    expect(screen.getByRole('tooltip')).toHaveTextContent(longDescription)
  })

  it('keeps table paint contracts compatible with supported browsers', async () => {
    const frontendStyles = readFileSync(
      resolve(process.cwd(), '../packages/frontend-components/styles.css'),
      'utf8'
    )
    const controlStyles = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')
    const tableHeaderRule = cssRule(frontendStyles, '.eft-table thead th')
    const tableHeaderPaintRule = cssRule(frontendStyles, '.eft-table thead th::before')
    const descriptionCellRule = cssRule(controlStyles, 'td.cu-registry-description')

    expect(frontendStyles).not.toContain(':has(')
    expect(tableHeaderRule).toContain('background-clip: border-box;')
    expect(tableHeaderRule).toContain('top: -1px;')
    expect(tableHeaderPaintRule).toContain('height: 2px;')
    expect(descriptionCellRule).toContain('display: table-cell;')
    expect(descriptionCellRule).toContain('overflow: visible;')
    expect(descriptionCellRule).toContain('-webkit-line-clamp: unset;')
    expect(descriptionCellRule).toContain('line-clamp: unset;')

    const seamShadow = '0 -0.375rem 0 var(--eft-surface-muted), inset 0 -1px 0 var(--eft-border)'
    const { unmount } = render(
      <DataTable>
        <thead>
          <tr>
            <TableHeaderCell label="Unwrapped seam" />
          </tr>
        </thead>
      </DataTable>
    )

    expect(screen.getByRole('columnheader', { name: 'Unwrapped seam' })).not.toHaveStyle({
      boxShadow: seamShadow,
    })
    unmount()

    render(
      <TableViewport>
        <DataTable>
          <thead>
            <tr>
              <TableHeaderCell label="Paint seam" />
              <th>Raw seam</th>
            </tr>
          </thead>
        </DataTable>
      </TableViewport>
    )

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: 'Paint seam' })).toHaveStyle({
        boxShadow: seamShadow,
      })
      expect(screen.getByRole('columnheader', { name: 'Raw seam' })).toHaveStyle({
        boxShadow: seamShadow,
      })
    })
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
