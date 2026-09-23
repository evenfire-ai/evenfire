import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MultiSelectActionDialog } from '../MultiSelectActionDialog'

afterEach(cleanup)

describe('MultiSelectActionDialog', () => {
  const items = [
    { id: 'alpha', label: 'Alpha', description: 'First option', searchText: 'first alpha' },
    { id: 'beta', label: 'Beta', searchText: 'second beta', disabled: true },
    { id: 'gamma', label: 'Gamma' },
  ] as const

  it('filters accessible options, keeps disabled items immutable, and acts only on selected IDs', async () => {
    const user = userEvent.setup()
    const onSelectedIdsChange = vi.fn()
    const onAction = vi.fn()
    const { rerender } = render(
      <MultiSelectActionDialog
        actionLabel="Apply to selected"
        items={items}
        onAction={onAction}
        onDismiss={vi.fn()}
        onSelectedIdsChange={onSelectedIdsChange}
        open
        selectedIds={[]}
        title="Choose records"
      />
    )
    const dialog = await screen.findByRole('dialog', { name: 'Choose records' })
    const action = within(dialog).getByRole('button', { name: 'Apply to selected' })
    expect(action).toBeDisabled()
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search items' }), 'alpha')
    expect(within(dialog).getByRole('checkbox', { name: /Alpha/ })).toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox', { name: /Beta/ })).not.toBeInTheDocument()
    await user.clear(within(dialog).getByRole('searchbox', { name: 'Search items' }))
    expect(within(dialog).getByRole('checkbox', { name: /Beta/ })).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox', { name: /Alpha/ }))
    expect(onSelectedIdsChange).toHaveBeenCalledWith(['alpha'])
    rerender(
      <MultiSelectActionDialog
        actionLabel="Apply to selected"
        items={items}
        onAction={onAction}
        onDismiss={vi.fn()}
        onSelectedIdsChange={onSelectedIdsChange}
        open
        selectedIds={['alpha']}
        title="Choose records"
      />
    )
    await user.click(within(dialog).getByRole('button', { name: 'Apply to selected' }))
    expect(onAction).toHaveBeenCalledWith(['alpha'])
  })

  it('announces loading, empty results, and no matches while suppressing actions', async () => {
    const { rerender } = render(
      <MultiSelectActionDialog
        actionLabel="Run"
        items={[]}
        loading
        onAction={vi.fn()}
        onDismiss={vi.fn()}
        onSelectedIdsChange={vi.fn()}
        open
        selectedIds={['stale']}
        title="Batch action"
      />
    )
    const dialog = await screen.findByRole('dialog', { name: 'Batch action' })
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading items…')
    expect(within(dialog).getByRole('button', { name: 'Run' })).toBeDisabled()
    rerender(
      <MultiSelectActionDialog
        actionLabel="Run"
        items={[]}
        onAction={vi.fn()}
        onDismiss={vi.fn()}
        onSelectedIdsChange={vi.fn()}
        open
        selectedIds={[]}
        title="Batch action"
      />
    )
    expect(within(dialog).getByText('No items available.')).toBeInTheDocument()
    rerender(
      <MultiSelectActionDialog
        actionLabel="Run"
        items={items}
        onAction={vi.fn()}
        onDismiss={vi.fn()}
        onSelectedIdsChange={vi.fn()}
        open
        selectedIds={[]}
        title="Batch action"
      />
    )
    await userEvent
      .setup()
      .type(within(dialog).getByRole('searchbox', { name: 'Search items' }), 'missing')
    expect(within(dialog).getByText('No matching items.')).toBeInTheDocument()
  })

  it('does not act on a controlled selection containing only unavailable IDs', async () => {
    const onAction = vi.fn()
    render(
      <MultiSelectActionDialog
        actionLabel="Apply"
        items={[{ id: 'locked', label: 'Locked item', disabled: true }]}
        onAction={onAction}
        onDismiss={vi.fn()}
        onSelectedIdsChange={vi.fn()}
        open
        selectedIds={['locked', 'missing']}
        title="Choose records"
      />
    )
    const dialog = await screen.findByRole('dialog', { name: 'Choose records' })
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('searches a plain text label when an explicit search adapter is omitted', async () => {
    const user = userEvent.setup()
    render(
      <MultiSelectActionDialog
        actionLabel="Apply"
        items={[{ id: 'gamma', label: 'Gamma' }]}
        onAction={vi.fn()}
        onDismiss={vi.fn()}
        onSelectedIdsChange={vi.fn()}
        open
        selectedIds={[]}
        title="Choose records"
      />
    )
    const dialog = await screen.findByRole('dialog', { name: 'Choose records' })
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search items' }), 'Gamma')
    expect(within(dialog).getByRole('checkbox', { name: 'Gamma' })).toBeInTheDocument()
  })
})
