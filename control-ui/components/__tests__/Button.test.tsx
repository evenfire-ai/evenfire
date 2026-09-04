import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Button } from '../ui'

afterEach(cleanup)

describe('Button', () => {
  it('maps the icon and toolbar props onto their modifier classes', () => {
    render(
      <Button icon toolbar>
        <span aria-hidden="true" />
      </Button>
    )

    const button = screen.getByRole('button')
    expect(button).toHaveClass('cu-btn', 'cu-btn--icon', 'cu-btn--toolbar')
  })

  it('renders ghost-danger as a ghost button tinted danger', () => {
    render(<Button variant="ghost-danger">Remove</Button>)

    expect(screen.getByRole('button')).toHaveClass('cu-btn--ghost', 'cu-btn--ghost-danger')
  })

  it('reuses the danger-icon treatment for a ghost-danger icon button', () => {
    render(
      <Button icon variant="ghost-danger" aria-label="Delete">
        <span aria-hidden="true" />
      </Button>
    )

    // cu-btn--icon.cu-btn--toolbar would win the colour cascade over
    // cu-btn--ghost-danger, so the combination maps onto the class that
    // already renders a transparent, danger-tinted glyph.
    const button = screen.getByRole('button', { name: 'Delete' })
    expect(button).toHaveClass('cu-btn--icon', 'cu-btn--danger-icon')
    expect(button).not.toHaveClass('cu-btn--ghost-danger')
  })

  it('shows a spinner and blocks interaction while loading', () => {
    const view = render(<Button loading>Save</Button>)

    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(view.container.querySelector('.cu-btn__spinner')).toBeInTheDocument()
  })
})
