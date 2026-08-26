import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FormSection } from '../ui'

afterEach(cleanup)

describe('FormSection', () => {
  it('renders its content directly when it is not collapsible', () => {
    render(
      <FormSection title="Execution" description="How this hook is ordered and fails.">
        <p>order field</p>
      </FormSection>
    )
    expect(screen.getByText('order field')).toBeInTheDocument()
    expect(screen.getByText('How this hook is ordered and fails.')).toBeInTheDocument()
    // No disclosure is introduced for the default form section.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('collapses to the title alone, and the toggle reveals the content', () => {
    render(
      <FormSection title="Advanced details" description="Rarely changed." collapsible>
        <p>order field</p>
      </FormSection>
    )

    const toggle = screen.getByRole('button', { name: 'Advanced details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // Collapsed costs one line: neither the body nor the description renders.
    expect(screen.queryByText('order field')).toBeNull()
    expect(screen.queryByText('Rarely changed.')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('order field')).toBeInTheDocument()
    expect(screen.getByText('Rarely changed.')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('order field')).toBeNull()
  })

  it('follows the owner when open is controlled, and points the toggle at its content', () => {
    render(
      <FormSection title="Advanced details" collapsible open onOpenChange={() => undefined}>
        <p>order field</p>
      </FormSection>
    )
    const toggle = screen.getByRole('button', { name: 'Advanced details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('order field')).toBeInTheDocument()
    // aria-controls has to resolve to the element actually holding the content.
    const controlled = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(controlled).not.toBeNull()
    expect(controlled).toHaveTextContent('order field')
  })

  it('reports a toggle to its owner rather than acting on it when controlled', () => {
    // The owner holds the state so it survives the section being unmounted; the
    // section must not open itself behind the owner's back.
    const onOpenChange = vi.fn()
    render(
      <FormSection title="Advanced details" collapsible open={false} onOpenChange={onOpenChange}>
        <p>order field</p>
      </FormSection>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Advanced details' }))
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(screen.queryByText('order field')).toBeNull()
  })
})
