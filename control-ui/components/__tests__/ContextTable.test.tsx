import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { buildContextResource } from '../../test/fixtures/contextResource'
import { ContextTable } from '../ContextTable'

const contexts = [
  buildContextResource({
    metadata: { name: 'business' },
    spec: { description: 'Business context', mcpServers: ['server-a', 'server-b'] },
  }),
]

describe('ContextTable', () => {
  it('opens a context from the whole row', () => {
    const onView = vi.fn()
    render(
      <ContextTable
        items={contexts}
        onView={onView}
        onEdit={vi.fn()}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        deletingKey={null}
        onRefresh={vi.fn()}
        onCreate={vi.fn()}
        refreshing={false}
      />
    )

    const row = screen.getByLabelText('Open context business')

    fireEvent.click(row)
    expect(onView).toHaveBeenCalledWith({ name: 'business' })

    onView.mockClear()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onView).toHaveBeenCalledWith({ name: 'business' })
  })

  it('stacks a non-link context name and its description in one cell', () => {
    const { container } = render(
      <ContextTable
        items={contexts}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        deletingKey={null}
        onRefresh={vi.fn()}
        onCreate={vi.fn()}
        refreshing={false}
      />
    )

    expect(screen.getAllByText('business')[0]).toHaveClass('cu-expandable-row__name')
    expect(screen.getByText('Business context')).toHaveClass('cu-registry-description')
    expect(container.querySelectorAll('thead th')).toHaveLength(5)
    expect(screen.queryByRole('button', { name: 'business' })).not.toBeInTheDocument()
  })

  it('renders the identifier (metadata.name) when displayName is blank/whitespace (R4-M1 / R1-L4)', () => {
    // A displayName written out-of-band as whitespace ('   ') must fall back to
    // the identifier, not render a blank label. dev restructured the cell to a
    // non-link span (cu-expandable-row__name), so assert the observable rendered
    // name text (T4), not a button role and not the intermediate spec value.
    render(
      <ContextTable
        items={[
          buildContextResource({
            metadata: { name: 'business' },
            spec: { displayName: '   ', description: '', mcpServers: [] },
          }),
        ]}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        deletingKey={null}
        onRefresh={vi.fn()}
        onCreate={vi.fn()}
        refreshing={false}
      />
    )

    // The visible name span renders the identifier, not a blank/whitespace label.
    expect(screen.getAllByText('business')[0]).toHaveClass('cu-expandable-row__name')
  })

  it('does not open a context from the row actions kebab', () => {
    const onView = vi.fn()
    const onEdit = vi.fn()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <ContextTable
        items={contexts}
        onView={onView}
        onEdit={onEdit}
        onDelete={onDelete}
        deletingKey={null}
        onRefresh={vi.fn()}
        onCreate={vi.fn()}
        refreshing={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for context business' }))

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledWith({ name: 'business' })
    expect(onView).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Actions for context business' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith({ name: 'business' })
    expect(onView).not.toHaveBeenCalled()
  })

  it('disables only the Delete item while deleting and renames it to Deleting…', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <ContextTable
        items={contexts}
        onView={vi.fn()}
        onEdit={onEdit}
        onDelete={onDelete}
        deletingKey="business"
        onRefresh={vi.fn()}
        onCreate={vi.fn()}
        refreshing={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for context business' }))

    const editItem = screen.getByRole('menuitem', { name: 'Edit' })
    const deletingItem = screen.getByRole('menuitem', { name: 'Deleting…' })

    expect(editItem).not.toBeDisabled()
    expect(deletingItem).toBeDisabled()
  })
})
