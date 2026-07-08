import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { RegistryInstallForm } from '../RegistryInstallForm'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', async () => {
  const mod: Record<string, unknown> = {}
  mod.getRegistryCredentialSchema = vi.fn().mockResolvedValue({
    required: false,
    authType: 'none',
    keys: [],
  })
  mod.getContexts = vi.fn().mockResolvedValue({
    items: [{ metadata: { name: 'context1' } }],
  })
  mod.installFromRegistry = vi.fn().mockResolvedValue({
    serverName: 'brave-search',
    namespace: 'mcp-server',
    contextRef: 'context1',
    contextUpdated: true,
    registryEntry: 'brave-search',
    registryVersion: '1.0.0',
    correlationId: 'test-corr-id',
  })
  return mod
})

const MOCK_ENTRY: api.RegistryEntry = {
  id: '1',
  name: 'brave-search',
  version: '1.0.0',
  entry_type: 'mcp-server',
  description: 'Brave web search',
  author: 'test',
  origin: 'human-authored',
  category: 'search',
  tags: ['search'],
  trust_level: 'high',
  quality_tier: 'verified',
  status: 'published',
  server_mode: 'local',
  transport: 'streamableHttp',
  recipe_type: null,
  mcp_server_meta: { imageRef: 'brave-search:1.0', port: 3000 },
  recipe_meta: null,
  artifact_refs: null,
  downloads: 42,
  installs: 10,
  created_at: '2026-01-01T00:00:00Z',
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RegistryInstallForm -- pending connector credentials', () => {
  it('allows empty required credentials and blocks partial values with clear guidance', async () => {
    vi.mocked(api.getRegistryCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [
        {
          name: 'API_KEY',
          label: 'API Key',
          kind: 'api-key',
          semanticType: 'api-key',
          description: 'Your API key',
        },
        {
          name: 'CLIENT_SECRET',
          label: 'Client Secret',
          kind: 'password',
          semanticType: 'api-key',
          description: 'Your client secret',
        },
      ],
    } as api.CredentialSchema)

    render(<RegistryInstallForm entry={MOCK_ENTRY} onCancel={vi.fn()} onInstalled={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByText(/Leave all credential fields empty to install now/i)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test-123' } })

    expect(
      screen.getByText(
        'Complete all credential fields or clear them all to install pending. Missing: Client Secret.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })
})
