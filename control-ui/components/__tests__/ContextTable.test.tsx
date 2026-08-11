import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ContextResource } from '../../lib/api'
import { ContextTable } from '../ContextTable'

const contexts: ContextResource[] = [
  {
    metadata: { name: 'business' },
    spec: {
      contextId: 'business',
      description: 'Business context',
      mcpServers: ['server-a', 'server-b'],
    },
  },
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

  it('renders the identifier (metadata.name) when displayName is blank/whitespace (R4-M1 / R1-L4)', () => {
    // A displayName written out-of-band as whitespace ('   ') must fall back to
    // the identifier, not render a blank label. Assert the observable rendered
    // text (T4), not the intermediate spec value.
    render(
      <ContextTable
        items={[
          {
            metadata: { name: 'business' },
            spec: {
              contextId: 'business',
              displayName: '   ',
              description: '',
              mcpServers: [],
            },
          },
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

    // The primary name link renders the identifier, not a blank/whitespace label.
    expect(screen.getByRole('button', { name: 'business' })).toBeInTheDocument()
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
