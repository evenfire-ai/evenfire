import { describe, expect, it } from 'vitest'
import { selectUnauthenticatedView } from '../unauthenticatedView'

const input = (overrides: Partial<Parameters<typeof selectUnauthenticatedView>[0]> = {}) => ({
  hasDependencyOutage: false,
  runtimeConfigMissing: false,
  isAuthenticated: false,
  ...overrides,
})

describe('selectUnauthenticatedView', () => {
  it('renders sign-in for a configured environment', () => {
    expect(selectUnauthenticatedView(input())).toBe('auth')
  })

  it('renders onboarding when no environment is configured', () => {
    expect(selectUnauthenticatedView(input({ runtimeConfigMissing: true }))).toBe('onboarding')
  })

  it('renders the outage page ahead of onboarding', () => {
    expect(
      selectUnauthenticatedView(input({ hasDependencyOutage: true, runtimeConfigMissing: true }))
    ).toBe('outage')
  })

  it('never renders onboarding to a signed-in user', () => {
    expect(
      selectUnauthenticatedView(input({ runtimeConfigMissing: true, isAuthenticated: true }))
    ).toBe('auth')
  })
})
