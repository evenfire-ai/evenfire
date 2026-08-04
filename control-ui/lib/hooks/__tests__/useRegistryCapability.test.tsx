import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../api'
import {
  __resetRegistryCapabilityCacheForTests,
  invalidateRegistryCapabilityCache,
  useRegistryCapability,
} from '../useRegistryCapability'

vi.mock('../../api', async orig => {
  const actual = await orig<typeof import('../../api')>()
  return { ...actual, getPublishScope: vi.fn(), getRegistryConnection: vi.fn() }
})

function Probe() {
  const { capability, loading, error } = useRegistryCapability()
  if (loading) return <div>loading</div>
  if (error) return <div>error</div>
  if (!capability) return <div>none</div>
  return (
    <div>
      <span data-testid="mode">{capability.mode}</span>
      <span data-testid="org">{capability.orgName ?? '-'}</span>
      <span data-testid="curator">{String(capability.isCurator)}</span>
      <span data-testid="auth">{String(capability.authEnabled)}</span>
      <span data-testid="manage">{String(capability.canManageOrg)}</span>
    </div>
  )
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  __resetRegistryCapabilityCacheForTests()
})

describe('useRegistryCapability', () => {
  it('self-hosted, org-bound, auth active → canManageOrg true', async () => {
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: '@acme',
      curator: false,
      orgName: 'acme',
    })
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connected',
      authEnabled: true,
    })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('self-hosted'))
    expect(screen.getByTestId('org').textContent).toBe('acme')
    expect(screen.getByTestId('auth').textContent).toBe('true')
    expect(screen.getByTestId('manage').textContent).toBe('true')
  })

  it('self-hosted, org-bound, but auth NOT active → canManageOrg false', async () => {
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: '@acme',
      curator: false,
      orgName: 'acme',
    })
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'disconnected',
      authEnabled: false,
    })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('manage').textContent).toBe('false'))
    expect(screen.getByTestId('mode').textContent).toBe('self-hosted')
  })

  it('managed deploy (not_self_hosted) with org scope → mode managed, canManageOrg true without authEnabled', async () => {
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: '@acme',
      curator: false,
      orgName: 'acme',
    })
    vi.mocked(api.getRegistryConnection).mockRejectedValue(
      Object.assign(new Error('nope'), { status: 409, code: 'not_self_hosted' })
    )
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('managed'))
    expect(screen.getByTestId('manage').textContent).toBe('true')
  })

  it('curator → canManageOrg false (catalog is their admin surface)', async () => {
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: null,
      curator: true,
      orgName: null,
    })
    vi.mocked(api.getRegistryConnection).mockRejectedValue(
      Object.assign(new Error('nope'), { status: 409, code: 'not_self_hosted' })
    )
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('curator').textContent).toBe('true'))
    expect(screen.getByTestId('manage').textContent).toBe('false')
  })

  it('connection probe failing (non-managed) leaves mode unknown but identity intact', async () => {
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: '@acme',
      curator: false,
      orgName: 'acme',
    })
    vi.mocked(api.getRegistryConnection).mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 })
    )
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('unknown'))
    expect(screen.getByTestId('org').textContent).toBe('acme')
    // unknown mode is not managed and has no authEnabled → cannot manage
    expect(screen.getByTestId('manage').textContent).toBe('false')
  })

  it('publish-scope failing (transient) → error surface for Retry', async () => {
    vi.mocked(api.getPublishScope).mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 })
    )
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connected',
      authEnabled: true,
    })
    render(<Probe />)
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument())
  })

  it('silent auth error → stops loading without surfacing an error (global handler navigates away)', async () => {
    vi.mocked(api.getPublishScope).mockRejectedValue(
      Object.assign(new Error('unauthorized'), { silent: true })
    )
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connected',
      authEnabled: true,
    })
    render(<Probe />)
    // Must not get stuck on "loading", and must not surface the Retry error.
    await waitFor(() => expect(screen.getByText('none')).toBeInTheDocument())
    expect(screen.queryByText('loading')).toBeNull()
    expect(screen.queryByText('error')).toBeNull()
  })

  it('invalidateRegistryCapabilityCache clears the cached identity so the next mount refetches', async () => {
    vi.mocked(api.getRegistryConnection).mockResolvedValue({
      state: 'connected',
      authEnabled: true,
    })
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: '@acme',
      curator: false,
      orgName: 'acme',
    })
    const first = render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('org').textContent).toBe('acme'))
    first.unmount()

    // Logout clears the cache; a different user then logs in.
    invalidateRegistryCapabilityCache()
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: '@beta',
      curator: false,
      orgName: 'beta',
    })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('org').textContent).toBe('beta'))
  })
})
