import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { PluginsEmptyState } from '../PluginsEmptyState'

vi.mock('../../lib/api', () => ({ listRegistryApiKeys: vi.fn() }))

const DOCS_URL =
  'https://github.com/evenfire-ai/evenfire/blob/main/docs/how-to/publish-plugin-to-registry.md'

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('PluginsEmptyState', () => {
  it('always explains what a plugin is, with its trigger/workload capabilities', async () => {
    vi.mocked(api.listRegistryApiKeys).mockRejectedValue(
      Object.assign(new Error('x'), { status: 409, code: 'no_org' })
    )
    render(<PluginsEmptyState />)
    expect(screen.getByText(/packaged, versioned workflows/i)).toBeInTheDocument()
    expect(screen.getByText(/recurring jobs/i)).toBeInTheDocument()
    expect(screen.getByText(/webhook/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /learn more about plugins/i })).toHaveAttribute(
      'href',
      DOCS_URL
    )
  })

  it('no org (409) → onboarding path: name the org + create a key', async () => {
    vi.mocked(api.listRegistryApiKeys).mockRejectedValue(
      Object.assign(new Error('x'), { status: 409, code: 'no_org' })
    )
    render(<PluginsEmptyState />)
    await waitFor(() =>
      expect(screen.getByText(/private to your organization/i)).toBeInTheDocument()
    )
    expect(screen.getByRole('link', { name: /connecting/i })).toHaveAttribute(
      'href',
      '/marketplace/connect'
    )
    expect(screen.getByRole('link', { name: /org API key/i })).toHaveAttribute(
      'href',
      '/marketplace/keys'
    )
  })

  it('connected with keys → points out it is already set up, no onboarding steps', async () => {
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({
      org: 'acme',
      keys: [{ id: 'k1' }],
    } as unknown as Awaited<ReturnType<typeof api.listRegistryApiKeys>>)
    render(<PluginsEmptyState />)
    expect(await screen.findByText(/already has API keys/i)).toBeInTheDocument()
    // Org name appears once (no longer repeated) and links to the Entries tab.
    expect(screen.getAllByText('@acme')).toHaveLength(1)
    expect(screen.getByRole('link', { name: '@acme' })).toHaveAttribute(
      'href',
      '/marketplace/org/entries'
    )
    // "Install Plugin" is a link to the org area.
    expect(screen.getByRole('link', { name: 'Install Plugin' })).toHaveAttribute(
      'href',
      '/marketplace/org'
    )
    // No setup walkthrough for an already-configured org.
    expect(screen.queryByText(/name your organization/i)).toBeNull()
    expect(screen.queryByText(/To publish from CI or scripts/i)).toBeNull()
  })

  it('connected without keys → prompts to create an org API key', async () => {
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({ org: 'acme', keys: [] })
    render(<PluginsEmptyState />)
    expect(await screen.findByText(/is connected/i)).toBeInTheDocument()
    expect(screen.getByText(/To publish from CI or scripts/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /org API key/i })).toHaveAttribute(
      'href',
      '/marketplace/keys'
    )
    expect(screen.queryByText(/already has API keys/i)).toBeNull()
  })

  it('connected but not an owner (403) → connected copy without a keys prompt', async () => {
    vi.mocked(api.listRegistryApiKeys).mockRejectedValue(
      Object.assign(new Error('x'), { status: 403, org: 'acme' })
    )
    render(<PluginsEmptyState />)
    await waitFor(() => expect(screen.getByText(/is connected/i)).toBeInTheDocument())
    expect(screen.getAllByText('@acme').length).toBeGreaterThan(0)
    // Keys are unknown for a non-owner — don't prompt to create one, don't claim they exist.
    expect(screen.queryByText(/To publish from CI or scripts/i)).toBeNull()
    expect(screen.queryByText(/already has API keys/i)).toBeNull()
  })
})
