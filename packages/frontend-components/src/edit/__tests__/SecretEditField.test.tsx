import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SecretEditField } from '../SecretEditField'
import type { SecretEditState } from '../types'

afterEach(cleanup)

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
    expect(field).toHaveAccessibleDescription(
      'A value is stored. Leave this field blank to keep it.'
    )
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

  it('restores a never-stored secret to untouched when a new draft is cleared', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    function SecretHarness() {
      const [state, setState] = useState<SecretEditState>({ status: 'untouched' })
      return (
        <SecretEditField
          existingValue={false}
          id="new-secret"
          label="New secret"
          onStateChange={next => {
            onStateChange(next)
            setState(next)
          }}
          state={state}
        />
      )
    }
    render(<SecretHarness />)
    const field = screen.getByLabelText('New secret')
    await user.type(field, 'draft-value')
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'replaced', value: 'draft-value' })
    await user.clear(field)
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'untouched' })
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

  it('keeps an absent secret untouched when Clear value removes a draft', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    function SecretHarness() {
      const [state, setState] = useState<SecretEditState>({ status: 'untouched' })
      return (
        <SecretEditField
          existingValue={false}
          id="new-secret"
          label="New secret"
          onStateChange={next => {
            onStateChange(next)
            setState(next)
          }}
          state={state}
        />
      )
    }

    render(<SecretHarness />)
    const field = screen.getByLabelText('New secret')
    await user.type(field, 'draft-value')
    const clear = screen.getByRole('button', { name: 'Clear value' })
    expect(clear).toBeEnabled()
    await user.click(clear)

    expect(field).toHaveValue('')
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'untouched' })
  })
})
