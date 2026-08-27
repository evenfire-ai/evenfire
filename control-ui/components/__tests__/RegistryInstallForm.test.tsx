import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { RegistryInstallForm } from '../RegistryInstallForm'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  apiSend: vi.fn().mockResolvedValue({}),
  getRegistryCredentialSchema: vi.fn().mockResolvedValue({
    required: false,
    authType: 'none',
    keys: [],
  }),
  installFromRegistry: vi.fn().mockResolvedValue({
    serverName: 'brave-search',
    namespace: 'mcp-server',
    contextRef: 'brave-search-00000',
    contextUpdated: true,
    registryEntry: 'brave-search',
    registryVersion: '1.0.0',
    correlationId: 'test-corr-id',
  }),
}))

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

async function waitForContinue(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled(), {
    timeout: 10_000,
  })
}

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

    await waitForContinue()
    fireEvent.click(screen.getByText('Configuration'))
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    // Package → Credentials: a single Continue now that the Context step is gone.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByText(/Leave all credential fields empty to install now/i)
    ).toBeInTheDocument()
    expect(screen.getByLabelText('API Key')).toHaveAttribute('placeholder', 'API Key')
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

describe('RegistryInstallForm -- server name default', () => {
  it('defaults the Server name to a K8s-valid derivation of a scoped registry name', async () => {
    const scopedEntry = { ...MOCK_ENTRY, name: '@test-oss-jose/helloo' }
    render(<RegistryInstallForm entry={scopedEntry} onCancel={vi.fn()} onInstalled={vi.fn()} />)

    // Configuration is deliberately collapsed on the Package step.
    await waitForContinue()
    fireEvent.click(screen.getByText('Configuration'))

    const nameInput = (await screen.findByLabelText('Server name')) as HTMLInputElement
    // `@test-oss-jose/helloo` sanitized to a valid RFC 1123 label — no manual fix.
    expect(nameInput.value).toBe('test-oss-jose-helloo')
    expect(screen.queryByText(/Must be a valid K8s name/i)).toBeNull()
  })

  it('keeps configuration collapsed and shows Package, Credentials, and Install flow steps', async () => {
    const { container } = render(
      <RegistryInstallForm entry={MOCK_ENTRY} onCancel={vi.fn()} onInstalled={vi.fn()} />
    )

    await waitForContinue()

    const configuration = container.querySelector('details.cu-registry-install-configuration')
    expect(configuration).not.toBeNull()
    expect(configuration).not.toHaveAttribute('open')
    expect(screen.getByRole('button', { name: /Package/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Credentials/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Install/ })).toBeInTheDocument()
    // The Context step no longer exists in the flow.
    expect(screen.queryByRole('button', { name: /Context/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Network/ })).not.toBeInTheDocument()
    expect(screen.queryByText('high')).not.toBeInTheDocument()
  })

  it('shows the install details as a stacked summary without a Context row', async () => {
    render(<RegistryInstallForm entry={MOCK_ENTRY} onCancel={vi.fn()} onInstalled={vi.fn()} />)

    await waitForContinue()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const summary = screen.getByLabelText('Install summary')
    expect(summary).toHaveTextContent('Connector')
    expect(summary).toHaveTextContent('brave-search')
    expect(summary).toHaveTextContent('Marketplace package')
    expect(summary).toHaveTextContent('Version')
    expect(summary).not.toHaveTextContent('Context')

    const access = screen.getByRole('region', { name: 'Connector access' })
    expect(access).toHaveTextContent(
      /After installing, choose which agents can use this connector from the Installed Connectors list\./
    )
    expect(
      screen.queryByRole('region', { name: 'Connector access principals' })
    ).not.toBeInTheDocument()
  })
})

describe('RegistryInstallForm -- install', () => {
  it('installs into a generated private scope and passes it as the install contextRef', async () => {
    render(<RegistryInstallForm entry={MOCK_ENTRY} onCancel={vi.fn()} onInstalled={vi.fn()} />)

    await waitForContinue()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    // The private access scope is created before the install request.
    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalledWith('POST', '/api/v1/admin/contexts', expect.any(Object))
    })
    const scopeCall = vi
      .mocked(api.apiSend)
      .mock.calls.find(call => call[0] === 'POST' && call[1] === '/api/v1/admin/contexts')
    expect(scopeCall).toBeDefined()
    const scopeBody = scopeCall![2] as {
      metadata: { name: string }
      spec: { contextId: string; description: string; mcpServers: string[] }
    }
    expect(scopeBody.metadata.name).toMatch(/^brave-search-[0-9]{5}$/)
    expect(scopeBody.spec.contextId).toBe(scopeBody.metadata.name)
    expect(scopeBody.spec.description).toBe('Connector access scope for brave-search')
    expect(scopeBody.spec.mcpServers).toEqual([])

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })
    const installCall = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(installCall.serverName).toBe('brave-search')
    expect(installCall.contextRef).toBe(scopeBody.metadata.name)
    expect(installCall.contextRef).toMatch(/^brave-search-[0-9]{5}$/)
    expect(installCall.registryEntryName).toBe('brave-search')
    expect(installCall.registryEntryVersion).toBe('1.0.0')
  })

  it('shows a success card and lets the user open Connectors after installation', async () => {
    const onViewConnectors = vi.fn()
    render(
      <RegistryInstallForm
        entry={MOCK_ENTRY}
        onCancel={vi.fn()}
        onInstalled={vi.fn()}
        onViewConnectors={onViewConnectors}
      />
    )

    await waitForContinue()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(
      await screen.findByRole('heading', { name: "Congratulations — you're ready to go" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/is installed\. Give agents access from the Installed Connectors list/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/was installed and added to context/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Go to Connectors' }))
    expect(onViewConnectors).toHaveBeenCalledOnce()
  })
})
