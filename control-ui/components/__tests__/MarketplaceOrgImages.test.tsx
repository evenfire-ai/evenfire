import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import * as api from '../../lib/api'
import { MarketplaceOrgImages } from '../MarketplaceOrgImages'

vi.mock('../../lib/api', () => ({ listOrgImages: vi.fn() }))

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('MarketplaceOrgImages', () => {
  it('lists real image repos + tags with their full coordinate (read-only)', async () => {
    vi.mocked(api.listOrgImages).mockResolvedValue({
      org: 'acme',
      images: [
        { name: 'orchestrator', visibility: 'private', createdAt: 'x', tags: ['0.1.0', 'latest'] },
        { name: 'api', visibility: 'private', createdAt: 'x', tags: ['0.1.0'] },
      ],
    })
    render(<MarketplaceOrgImages orgScope="@acme" />)

    // One row per (repo, tag); coordinate is generated.
    const orchRow = (
      await screen.findByText('registry.evenfire.ai/acme/orchestrator:0.1.0')
    ).closest('tr')!
    expect(within(orchRow).getByText('orchestrator')).toBeInTheDocument()
    expect(screen.getByText('registry.evenfire.ai/acme/orchestrator:latest')).toBeInTheDocument()
    expect(screen.getByText('registry.evenfire.ai/acme/api:0.1.0')).toBeInTheDocument()

    // No Push CTA / generated commands.
    expect(screen.queryByRole('button', { name: /push/i })).toBeNull()
    expect(screen.queryByText(/docker push/i)).toBeNull()
  })

  it('renders a tag-less repo with a <tag> placeholder coordinate', async () => {
    vi.mocked(api.listOrgImages).mockResolvedValue({
      org: 'acme',
      images: [{ name: 'analyzer', visibility: 'private', createdAt: 'x', tags: [] }],
    })
    render(<MarketplaceOrgImages orgScope="@acme" />)
    const row = (await screen.findByText('analyzer')).closest('tr')!
    expect(within(row).getByText('registry.evenfire.ai/acme/analyzer:<tag>')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /push/i })).toBeNull()
  })

  it('empty state when the org has no image repos', async () => {
    vi.mocked(api.listOrgImages).mockResolvedValue({ org: 'acme', images: [] })
    render(<MarketplaceOrgImages orgScope="@acme" />)
    expect(await screen.findByText(/No images yet/i)).toBeInTheDocument()
  })

  it('shows an "unavailable" notice when the registry endpoint is not deployed (404)', async () => {
    vi.mocked(api.listOrgImages).mockRejectedValue(Object.assign(new Error('x'), { status: 404 }))
    render(<MarketplaceOrgImages orgScope="@acme" />)
    expect(
      await screen.findByText(
        'Image listing isn’t available on this registry yet. Your pushed images still work, and the list will appear here once the registry exposes it.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('shows a retry banner on a transient load failure', async () => {
    vi.mocked(api.listOrgImages).mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 })
    )
    render(<MarketplaceOrgImages orgScope="@acme" />)
    expect(await screen.findByText(/Could not load your images/i)).toBeInTheDocument()
  })

  it('states the deferred push failures (permission / quota) honestly', async () => {
    vi.mocked(api.listOrgImages).mockResolvedValue({
      org: 'acme',
      images: [{ name: 'c', visibility: 'private', createdAt: 'x', tags: ['1.0.0'] }],
    })
    render(<MarketplaceOrgImages orgScope="@acme" />)
    await screen.findByText('c')
    expect(
      screen.getByText(/publish permission or the org has reached its image quota/i)
    ).toBeInTheDocument()
  })
})
