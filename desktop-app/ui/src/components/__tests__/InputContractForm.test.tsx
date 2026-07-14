// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InputContractForm, buildInitialInputValues } from '../InputContractForm'

afterEach(cleanup)

describe('buildInitialInputValues', () => {
  it('returns an empty object when schema is undefined', () => {
    expect(buildInitialInputValues(undefined)).toEqual({})
  })

  it('returns empty object when properties is undefined', () => {
    expect(buildInitialInputValues({})).toEqual({})
  })

  it('uses declared defaults when provided', () => {
    const values = buildInitialInputValues({
      properties: {
        industry: { type: 'string', default: 'fintech' },
        rows: { type: 'integer', default: 5 },
        active: { type: 'boolean', default: true },
        empty: { type: 'string', default: '' },
        disabled: { type: 'boolean', default: false },
        zero: { type: 'number', default: 0 },
      },
    })
    expect(values).toEqual({
      industry: 'fintech',
      rows: 5,
      active: true,
      empty: '',
      disabled: false,
      zero: 0,
    })
  })

  it('falls back to zero values for each type when no default', () => {
    const values = buildInitialInputValues({
      properties: {
        a: { type: 'string' },
        b: { type: 'integer' },
        c: { type: 'number' },
        d: { type: 'boolean' },
      },
    })
    expect(values).toEqual({ a: '', b: 0, c: 0, d: false })
  })
})

describe('InputContractForm', () => {
  const baseSchema = {
    properties: {
      industry: {
        type: 'string' as const,
        default: 'enterprise AI',
        description: 'Sector to research',
      },
      rows: {
        type: 'integer' as const,
        default: 3,
      },
    },
  }

  it('returns null when schema has no properties', () => {
    const { container } = render(<InputContractForm schema={{}} values={{}} onChange={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a field per property with declared defaults', () => {
    render(
      <InputContractForm
        schema={baseSchema}
        values={{ industry: 'enterprise AI', rows: 3 }}
        onChange={vi.fn()}
      />
    )
    const industry = screen.getByLabelText('industry') as HTMLInputElement
    const rows = screen.getByLabelText('rows') as HTMLInputElement
    expect(industry.value).toBe('enterprise AI')
    expect(industry.type).toBe('text')
    expect(rows.value).toBe('3')
    expect(rows.type).toBe('number')
    expect(screen.getByText('Sector to research')).toBeTruthy()
  })

  it('propagates onChange with coerced numeric values', () => {
    const onChange = vi.fn()
    render(
      <InputContractForm
        schema={baseSchema}
        values={{ industry: 'enterprise AI', rows: 3 }}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('rows'), { target: { value: '7' } })
    expect(onChange).toHaveBeenCalledWith({ industry: 'enterprise AI', rows: 7 })
  })

  it('propagates onChange with raw string values for text fields', () => {
    const onChange = vi.fn()
    render(
      <InputContractForm
        schema={baseSchema}
        values={{ industry: 'enterprise AI', rows: 3 }}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('industry'), {
      target: { value: 'health tech' },
    })
    expect(onChange).toHaveBeenCalledWith({ industry: 'health tech', rows: 3 })
  })

  it('marks required fields with an asterisk in the label', () => {
    render(
      <InputContractForm
        schema={{ ...baseSchema, required: ['industry'] }}
        values={{ industry: '', rows: 0 }}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('industry *')).toBeTruthy()
    expect(screen.getByText('rows')).toBeTruthy()
  })

  it('renders a select for enum fields', () => {
    const onChange = vi.fn()
    render(
      <InputContractForm
        schema={{
          properties: {
            tier: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
          },
        }}
        values={{ tier: 'free' }}
        onChange={onChange}
      />
    )
    const select = screen.getByLabelText('tier') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.options).toHaveLength(3)
    fireEvent.change(select, { target: { value: 'pro' } })
    expect(onChange).toHaveBeenCalledWith({ tier: 'pro' })
  })

  it('renders and updates boolean fields as checkboxes', () => {
    const onChange = vi.fn()
    render(
      <InputContractForm
        schema={{ properties: { includeSources: { type: 'boolean', default: true } } }}
        values={{}}
        onChange={onChange}
      />
    )

    const checkbox = screen.getByLabelText('includeSources') as HTMLInputElement
    expect(checkbox.type).toBe('checkbox')
    expect(checkbox.checked).toBe(true)

    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledWith({ includeSources: false })
  })

  it('preserves raw strings for invalid numeric edits', () => {
    const onChange = vi.fn()
    render(
      <InputContractForm
        schema={{ properties: { rows: { type: 'integer' } } }}
        values={{ rows: 3 }}
        onChange={onChange}
      />
    )

    fireEvent.change(screen.getByLabelText('rows'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ rows: '' })
  })

  it('disables all fields when disabled prop is true', () => {
    render(
      <InputContractForm
        schema={baseSchema}
        values={{ industry: 'enterprise AI', rows: 3 }}
        onChange={vi.fn()}
        disabled
      />
    )
    expect((screen.getByLabelText('industry') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('rows') as HTMLInputElement).disabled).toBe(true)
  })
})
