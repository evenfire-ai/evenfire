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

    expect(screen.getByText('business')).toHaveClass('cu-expandable-row__name')
    expect(screen.getByText('Business context')).toHaveClass('cu-registry-description')
    expect(container.querySelectorAll('thead th')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'business' })).not.toBeInTheDocument()
  })

  it('does not open a context from row action buttons', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit context business' }))
    expect(onEdit).toHaveBeenCalledWith({ name: 'business' })
    expect(onView).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete context business' }))
    expect(onDelete).toHaveBeenCalledWith({ name: 'business' })
    expect(onView).not.toHaveBeenCalled()
  })
})
