import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GfsSubjectPicker } from '../GfsSubjectPicker'

const options = [
  { value: 'user:ada', label: 'Ada Lovelace', badge: 'User' },
  { value: 'team:research', label: 'Research', badge: 'Team' },
  { value: 'host:first-party', label: 'First-party agent runtime', badge: 'Agent' },
]

function ControlledSubjectPicker() {
  const [value, setValue] = useState<string[]>([])
  return <GfsSubjectPicker onChange={setValue} options={options} value={value} />
}

describe('GfsSubjectPicker', () => {
  it('returns focus to the combobox after each keyboard selection in a multi-select flow', async () => {
    const user = userEvent.setup({ delay: null })
    render(<ControlledSubjectPicker />)

    const combobox = screen.getByRole('combobox', {
      name: 'Add people, teams, agents, or workflows',
    })
    await user.tab()
    expect(combobox).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('option', { name: 'Ada Lovelace' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(combobox).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeTruthy()

    await user.tab()
    expect(screen.getByRole('option', { name: 'Research' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(combobox).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Remove Research' })).toBeTruthy()
  })
})
