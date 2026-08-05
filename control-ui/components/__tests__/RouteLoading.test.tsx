import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import Loading from '../../app/loading'

describe('Control UI root loading boundary', () => {
  it('renders an accessible body skeleton without replacing the persistent shell', () => {
    const view = render(<Loading />)

    expect(screen.getByRole('status', { name: /loading control ui section/i })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    expect(view.container.querySelector('.cu-section-loading-skeleton')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.cu-section-loading-skeleton__row')).toHaveLength(4)
    expect(view.container.querySelector('main')).not.toBeInTheDocument()
    expect(view.container.querySelector('.cu-app--auth')).not.toBeInTheDocument()
    expect(view.container.querySelector('.cu-loading-screen')).not.toBeInTheDocument()
  })
})
