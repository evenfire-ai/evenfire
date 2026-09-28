import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SelectionDropdown } from '../SelectionDropdown'

describe('SelectionDropdown accessible option names', () => {
  it('uses the label when no badge is present', () => {
    render(
      <SelectionDropdown
        inline
        multiple={false}
        onChange={vi.fn()}
        options={[{ label: 'Alpha', value: 'alpha' }]}
        placeholder="Choose"
        searchable={false}
        value={[]}
      />
    )

    expect(screen.getByRole('option', { name: 'Alpha', exact: true })).toBeInTheDocument()
  })

  it('includes a distinct identifier badge in the accessible name', () => {
    render(
      <SelectionDropdown
        inline
        multiple={false}
        onChange={vi.fn()}
        options={[{ label: 'admin', badge: 'control-admin-1', value: 'admin' }]}
        placeholder="Choose"
        searchable={false}
        value={[]}
      />
    )

    expect(
      screen.getByRole('option', { name: 'admin, control-admin-1', exact: true })
    ).toBeInTheDocument()
  })

  it('includes a distinct status badge in the accessible name', () => {
    render(
      <SelectionDropdown
        inline
        multiple={false}
        onChange={vi.fn()}
        options={[{ label: 'gpt-5.4', badge: 'out of allowlist', value: 'gpt-5.4' }]}
        placeholder="Choose"
        searchable={false}
        value={[]}
      />
    )

    expect(
      screen.getByRole('option', { name: 'gpt-5.4, out of allowlist', exact: true })
    ).toBeInTheDocument()
  })

  it('does not repeat a badge that matches the label', () => {
    render(
      <SelectionDropdown
        inline
        multiple={false}
        onChange={vi.fn()}
        options={[
          {
            label: 'user-from-shared-url',
            badge: 'user-from-shared-url',
            value: 'user-from-shared-url',
          },
        ]}
        placeholder="Choose"
        searchable={false}
        value={[]}
      />
    )

    expect(
      screen.getByRole('option', { name: 'user-from-shared-url', exact: true })
    ).toBeInTheDocument()
  })
})
