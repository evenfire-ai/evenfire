import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoadingScreen } from '../LoadingScreen'

describe('LoadingScreen', () => {
  it('renders the centered branded Control UI loading state', () => {
    const { container } = render(<LoadingScreen />)

    expect(screen.getByRole('status', { name: 'Loading Control UI' })).toBeInTheDocument()
    expect(screen.getByText('Evenfire')).toBeInTheDocument()
    expect(screen.getByText('Control UI')).toBeInTheDocument()
    expect(screen.getByText('Loading session…')).toBeInTheDocument()
    expect(container.querySelector('.cu-loading-screen__mark')).toHaveAttribute(
      'src',
      '/brand/logo.svg'
    )
  })
})
