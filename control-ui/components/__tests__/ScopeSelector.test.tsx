import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ScopeSelector } from '../TokenBudgetForm/ScopeSelector'
import type { ScopeDimensionConfig } from '../TokenBudgetForm/types'

const dimensions: ScopeDimensionConfig[] = [
  { key: 'provider', label: 'Provider', options: [{ value: 'openai', label: 'OpenAI' }] },
  { key: 'model', label: 'Model', options: null, placeholder: 'model name' },
]

function renderSelector(value: Record<string, string[]> = {}) {
  const onChange = vi.fn()
  render(<ScopeSelector dimensions={dimensions} value={value} onChange={onChange} />)
  return { onChange }
}

describe('ScopeSelector', () => {
  it('adds a finite-option value via the select control', () => {
    const { onChange } = renderSelector()
    fireEvent.change(screen.getByLabelText('Add Provider to scope'), {
      target: { value: 'openai' },
    })
    expect(onChange).toHaveBeenCalledWith({ provider: ['openai'] })
  })

  it('adds a free-text value via the Add button', () => {
    const { onChange } = renderSelector()
    fireEvent.change(screen.getByLabelText('Add Model to scope'), {
      target: { value: 'gpt-4o' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenCalledWith({ model: ['gpt-4o'] })
  })

  it('does not add a duplicate value', () => {
    const { onChange } = renderSelector({ model: ['gpt-4o'] })
    fireEvent.change(screen.getByLabelText('Add Model to scope'), {
      target: { value: 'gpt-4o' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes the dimension key entirely when its last value is removed', () => {
    const { onChange } = renderSelector({ model: ['gpt-4o'] })
    fireEvent.click(screen.getByRole('button', { name: /remove gpt-4o/i }))
    expect(onChange).toHaveBeenCalledWith({})
  })
})
