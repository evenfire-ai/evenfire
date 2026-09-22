import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MultiSelectActionDialog } from '../MultiSelectActionDialog'
import { SecretEditField } from '../SecretEditField'
import { SimpleEditDialog } from '../SimpleEditDialog'
import { SingleValueEditDialog } from '../SingleValueEditDialog'
import type { SecretEditState } from '../types'

afterEach(cleanup)

describe('SingleValueEditDialog', () => {
  it('keeps one value atomic, disables unchanged/invalid saves, and saves the edited value', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onDismiss = vi.fn()
    function Harness() {
      const [value, setValue] = useState('original')
      return (
        <SingleValueEditDialog
          initialValue="original"
          isValid={value.length > 2}
          onDismiss={onDismiss}
          onSave={onSave}
          open
          renderEditor={({ value: draft, onChange, disabled }) => (
            <label>
              Value
              <input
                disabled={disabled}
                onChange={event => {
                  onChange(event.currentTarget.value)
                  setValue(event.currentTarget.value)
                }}
                value={draft}
              />
            </label>
          )}
          title="Edit value"
        />
      )
    }
    render(<Harness />)
    const dialog = await screen.findByRole('dialog', { name: 'Edit value' })
    const save = within(dialog).getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    const input = within(dialog).getByLabelText('Value')
    await user.clear(input)
    await user.type(input, 'x')
    expect(save).toBeDisabled()
    await user.clear(input)
    await user.type(input, 'changed')
    expect(save).toBeEnabled()
    await user.type(input, '{Enter}')
    expect(onSave).toHaveBeenCalledWith('changed')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('discards the local draft through the cancel callback', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <SingleValueEditDialog
        initialValue={4}
        onDismiss={onDismiss}
        onSave={vi.fn()}
        open
        renderEditor={({ value }) => <output>{value}</output>}
        title="Edit count"
      />
    )
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDismiss).toHaveBeenCalledWith('cancel')
  })
})

describe('SimpleEditDialog', () => {
  it('keeps form validity, dirty state, and pending state at the action boundary', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <SimpleEditDialog
        isDirty={false}
        isValid
        onCancel={onCancel}
        onSave={onSave}
        open
        title="Edit profile"
      >
        <label>
          Name
          <input defaultValue="Ada" />
        </label>
      </SimpleEditDialog>
    )
    const dialog = await screen.findByRole('dialog', { name: 'Edit profile' })
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    rerender(
      <SimpleEditDialog
        isDirty
        isValid
        pending
        onCancel={onCancel}
        onSave={onSave}
        open
        title="Edit profile"
      >
        <label>
          Name
          <input defaultValue="Ada" />
        </label>
      </SimpleEditDialog>
    )
    expect(within(dialog).getByRole('button', { name: 'Saving…' })).toBeDisabled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('supports keyboard-only submission from the bounded form', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <SimpleEditDialog isDirty isValid onCancel={vi.fn()} onSave={onSave} open title="Add label">
        <label>
          Label
          <input defaultValue="Platform" />
        </label>
      </SimpleEditDialog>
    )
    const input = await screen.findByLabelText('Label')
    input.focus()
    await user.keyboard('{Enter}')
    expect(onSave).toHaveBeenCalledOnce()
  })
})

describe('SecretEditField', () => {
  it('never reads an existing secret, exposes write-only operations, and emits explicit tagged state', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    function SecretHarness() {
      const [state, setState] = useState<SecretEditState>({ status: 'untouched' })
      return (
        <SecretEditField
          existingValue
          id="credential"
          label="Credential"
          onStateChange={next => {
            onStateChange(next)
            setState(next)
          }}
          state={state}
        />
      )
    }
    render(<SecretHarness />)
    const field = screen.getByLabelText('Credential')
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveValue('')
    expect(
      screen.getByText('A value is stored. Leave this field blank to keep it.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
    await user.type(field, 'new-secret')
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'replaced', value: 'new-secret' })
    await user.clear(field)
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'cleared' })
    await user.type(field, 'replacement')
    await user.click(screen.getByRole('button', { name: 'Clear value' }))
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'cleared' })
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'restored' })
    expect(document.body).not.toHaveTextContent('new-secret')
  })

  it('does not offer restore when no stored value exists', () => {
    render(
      <SecretEditField
        existingValue={false}
        id="new-secret"
        label="New secret"
        onStateChange={vi.fn()}
        state={{ status: 'untouched' }}
      />
    )
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
  })

  it('restores the empty original state after drafting a new secret', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    render(
      <SecretEditField
        existingValue={false}
        id="new-secret"
        label="New secret"
        onStateChange={onStateChange}
        state={{ status: 'replaced', value: 'draft-value' }}
      />
    )
    const restore = screen.getByRole('button', { name: 'Restore' })
    expect(restore).toBeEnabled()
    await user.click(restore)
    expect(onStateChange).toHaveBeenCalledWith({ status: 'untouched' })
  })
})

describe('MultiSelectActionDialog', () => {
  const items = [
    { id: 'alpha', label: 'Alpha', description: 'First option', searchText: 'first alpha' },
    { id: 'beta', label: 'Beta', searchText: 'second beta', disabled: true },
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
})
