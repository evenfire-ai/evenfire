import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { BodyLoadingSkeleton, FormSectionsSkeleton } from '../BodyLoadingSkeleton'

vi.mock('../DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

afterEach(cleanup)

describe('BodyLoadingSkeleton', () => {
  it('keeps page chrome visible and disables actions while body sections load', () => {
    const view = render(
      <BodyLoadingSkeleton
        backLabel="Back to models"
        icon={<span>icon</span>}
        primaryActionLabel="Save model"
        sections={3}
        subtitle="Update the model configuration."
        title="Edit allowed model"
      />
    )

    expect(screen.getByRole('heading', { name: 'Edit allowed model' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to models' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save model' })).toBeDisabled()
    expect(screen.getByRole('status', { name: 'Edit allowed model loading' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    expect(view.container.querySelectorAll('.cu-body-loading-skeleton__section')).toHaveLength(3)
  })

  it('renders content-only form skeletons without replacing the page header', () => {
    const view = render(
      <FormSectionsSkeleton label="Connector" primaryActionLabel="Save egress" sections={2} />
    )

    expect(screen.getByRole('button', { name: 'Save egress' })).toBeDisabled()
    expect(view.container.querySelectorAll('.cu-body-loading-skeleton__section')).toHaveLength(2)
  })
})
