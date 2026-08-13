import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '../../../components/Toast'
import * as api from '../../../lib/api'
import ContextDetailsPage from '../[name]/page'

const replaceMock = vi.fn()
const pushMock = vi.fn()
let mockParams: { name: string; tab?: string } = { name: 'prod-ctx' }

vi.mock('next/navigation', () => ({
  useParams: () => mockParams,
  usePathname: () => '/contexts/prod-ctx',
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}))

// Render the frame as a passthrough so the form is the unit under test.
vi.mock('../../../components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../../lib/api', () => ({
  apiSend: vi.fn().mockResolvedValue({}),
  createContext: vi.fn().mockResolvedValue({}),
  deleteContext: vi.fn().mockResolvedValue({}),
  getAdminTeamContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
  getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
  getAdminUserContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
  getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
  getContext: vi.fn(),
  getContextTeams: vi.fn().mockResolvedValue({ items: [] }),
  getContextUsers: vi.fn().mockResolvedValue({ items: [] }),
  getHosts: vi.fn().mockResolvedValue({ items: [] }),
  getMcpServers: vi.fn().mockResolvedValue({ items: [] }),
  getSharedFileSystems: vi.fn().mockResolvedValue({ items: [] }),
  updateAdminTeamContexts: vi.fn().mockResolvedValue({}),
  updateAdminUserContexts: vi.fn().mockResolvedValue({}),
  updateContext: vi.fn().mockResolvedValue({}),
}))

type TestContext = {
  metadata: { name: string; resourceVersion?: string }
  spec: Record<string, unknown>
}

function mockContext(ctx: TestContext) {
  // dev's contexts page now uses optimistic concurrency: buildContextUpdatePayload
  // requires the loaded resourceVersion, so the load fixture must carry one or
  // every save throws "Context version is unavailable" before the PUT.
  const withVersion = {
    ...ctx,
    metadata: { resourceVersion: 'rv-context-read', ...ctx.metadata },
  }
  ;(api.getContext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(withVersion)
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

async function openEditModal() {
  fireEvent.click(await screen.findByRole('button', { name: 'Context actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit context' }))
}

afterEach(() => {
  cleanup()
})

describe('ContextDetailsPage display name (UT-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'prod-ctx' }
  })

  it('shows a readonly identifier and edits the display name via a single PUT (no cascade)', async () => {
    mockContext({
      metadata: { name: 'prod-ctx' },
      spec: {
        contextId: 'prod-ctx',
        description: 'Original description',
        mcpServers: ['srv-a'],
        displayName: 'Prod Ctx',
      },
    })

    render(<ContextDetailsPage />)

    // The visible name (display) is shown in the header.
    expect(await screen.findByText('Prod Ctx')).toBeInTheDocument()

    await openEditModal()

    // Identifier is present but readonly, with a hint.
    const nameField = screen.getByLabelText('Name')
    expect(nameField).toHaveAttribute('readonly')
    expect(nameField).toHaveValue('prod-ctx')
    expect(screen.getByText(/identifier, not editable/i)).toBeInTheDocument()

    // The display name is the editable field, seeded from spec.displayName.
    const displayField = screen.getByLabelText('Display name')
    expect(displayField).toHaveValue('Prod Ctx')
    fireEvent.change(displayField, { target: { value: 'Prod Ctx 2' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.updateContext).toHaveBeenCalled())
    const [name, payload] = (api.updateContext as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { spec: Record<string, unknown> }]
    // Identifier / contextId untouched; the PUT targets the same slug.
    expect(name).toBe('prod-ctx')
    expect(payload.spec.contextId).toBe('prod-ctx')
    // Full-replace safety: the spec echoes its other fields, not just displayName.
    expect(payload.spec.displayName).toBe('Prod Ctx 2')
    expect(payload.spec.mcpServers).toEqual(['srv-a'])

    // No cascade: hosts are never re-written to chase a rename.
    expect(api.apiSend).not.toHaveBeenCalledWith(
      'PUT',
      expect.stringContaining('/api/v1/admin/hosts/'),
      expect.anything()
    )
    expect(await screen.findByText('Context saved.')).toBeInTheDocument()
  })

  it('still saves the description through the same PUT', async () => {
    mockContext({
      metadata: { name: 'prod-ctx' },
      spec: {
        contextId: 'prod-ctx',
        description: 'Original description',
        mcpServers: [],
        displayName: 'Prod Ctx',
      },
    })

    render(<ContextDetailsPage />)
    await screen.findByText('Prod Ctx')
    await openEditModal()

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Updated description' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.updateContext).toHaveBeenCalled())
    const [, payload] = (api.updateContext as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { spec: Record<string, unknown> }]
    expect(payload.spec.description).toBe('Updated description')
    expect(payload.spec.contextId).toBe('prod-ctx')
  })

  it('falls back to metadata.name when spec.displayName is absent (the only fallback)', async () => {
    mockContext({
      metadata: { name: 'prod-ctx' },
      spec: {
        contextId: 'prod-ctx',
        description: '',
        mcpServers: [],
        // no displayName
      },
    })

    render(<ContextDetailsPage />)

    // With no display name, the identifier is shown as the visible name.
    expect(await screen.findByText('prod-ctx')).toBeInTheDocument()

    await openEditModal()
    // The display name field is empty (ready to be filled), not the slug.
    expect(screen.getByLabelText('Display name')).toHaveValue('')
  })
})
