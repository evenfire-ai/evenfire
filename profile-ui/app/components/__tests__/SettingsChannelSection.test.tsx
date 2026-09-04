import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { SettingsChannelSection } from '../../settings/SettingsChannelSection'

const section = {
  key: 'emails' as const,
  title: 'Email addresses',
  description: 'Addresses used for profile notifications.',
  placeholder: 'user@example.com',
  addLabel: 'Add email',
}

afterEach(cleanup)

describe('SettingsChannelSection list semantics', () => {
  it('keeps empty and add controls outside the RecordList', () => {
    render(
      <SettingsChannelSection
        section={section}
        rows={[]}
        disabled={false}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        onAdd={vi.fn()}
      />
    )

    expect(screen.getByText('No values added.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add email' })).toBeInTheDocument()
  })

  it('renders only row children inside the RecordList when values exist', () => {
    render(
      <SettingsChannelSection
        section={section}
        rows={[{ id: 'email-1', value: 'user@example.com' }]}
        readonlyValues={[
          {
            id: 'readonly-1',
            value: 'managed@example.com',
            caption: 'Managed by the organization.',
          },
        ]}
        disabled={false}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        onAdd={vi.fn()}
      />
    )

    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).queryByRole('button', { name: 'Add email' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add email' })).toBeInTheDocument()
  })
})
