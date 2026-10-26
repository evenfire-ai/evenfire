import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HostLocaleDialog } from '../HostLocaleDialog'

afterEach(cleanup)

function renderDialog(onSave = vi.fn()) {
  render(
    <HostLocaleDialog
      open
      locale={{ language: 'es-MX', timeZone: '' }}
      pending={false}
      onCancel={vi.fn()}
      onSave={onSave}
    />
  )
  return onSave
}

describe('HostLocaleDialog', () => {
  it('shows the stored values and saves only after a change', () => {
    const onSave = renderDialog()
    const language = screen.getByLabelText('Language') as HTMLSelectElement
    const timeZone = screen.getByLabelText('Time zone') as HTMLSelectElement
    expect(language.value).toBe('es-MX')
    expect(timeZone.value).toBe('')
    const save = screen.getByRole('button', { name: 'Save language and time zone' })
    expect(save).toHaveProperty('disabled', true)

    fireEvent.change(timeZone, { target: { value: 'America/Mexico_City' } })
    expect(save).toHaveProperty('disabled', false)
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith({ language: 'es-MX', timeZone: 'America/Mexico_City' })
  })

  it('can clear a value back to not set', () => {
    const onSave = renderDialog()
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save language and time zone' }))
    expect(onSave).toHaveBeenCalledWith({ language: '', timeZone: '' })
  })
})
