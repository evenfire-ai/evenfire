import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../api'
import { isPublisherEnabled, usePublishScope } from '../usePublishScope'

vi.mock('../../api', async orig => {
  const actual = await orig<typeof import('../../api')>()
  return { ...actual, getPublishScope: vi.fn() }
})

function Probe() {
  const { scope, loading, error } = usePublishScope()
  return (
    <div>
      {loading ? 'loading' : error ? 'error' : isPublisherEnabled(scope) ? 'enabled' : 'disabled'}
    </div>
  )
}

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('usePublishScope / isPublisherEnabled', () => {
  it('isPublisherEnabled: org-bound non-curator → true', () => {
    expect(isPublisherEnabled({ scope: 'acme', curator: false, orgName: 'Acme' })).toBe(true)
  })
  it('isPublisherEnabled: curator → false', () => {
    expect(isPublisherEnabled({ scope: null, curator: true, orgName: null })).toBe(false)
  })
  it('isPublisherEnabled: unbound (scope null) → false', () => {
    expect(isPublisherEnabled({ scope: null, curator: false, orgName: null })).toBe(false)
  })
  it('isPublisherEnabled: null scope object → false', () => {
    expect(isPublisherEnabled(null)).toBe(false)
  })

  it('isPublisherEnabled: org-bound non-curator, publisherUiEnabled explicitly false → false', () => {
    expect(
      isPublisherEnabled({
        scope: 'acme',
        curator: false,
        orgName: 'Acme',
        publisherUiEnabled: false,
      })
    ).toBe(false)
  })

  it('isPublisherEnabled: org-bound non-curator, publisherUiEnabled explicitly true → true', () => {
    expect(
      isPublisherEnabled({
        scope: 'acme',
        curator: false,
        orgName: 'Acme',
        publisherUiEnabled: true,
      })
    ).toBe(true)
  })

  it('isPublisherEnabled: org-bound non-curator, publisherUiEnabled absent (backward compat) → true', () => {
    expect(isPublisherEnabled({ scope: 'acme', curator: false, orgName: 'Acme' })).toBe(true)
  })

  it('resolves to enabled for an org-bound scope', async () => {
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: 'acme',
      curator: false,
      orgName: 'Acme',
    })
    render(<Probe />)
    expect(await screen.findByText('enabled')).toBeInTheDocument()
  })

  it('fails closed (disabled) on error', async () => {
    vi.mocked(api.getPublishScope).mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 })
    )
    render(<Probe />)
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument())
  })
})
