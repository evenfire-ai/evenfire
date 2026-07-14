import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { RegistryInstallModal } from '../RegistryInstallModal'
import { ToastProvider } from '../Toast'

// vi.mock is hoisted before imports, factory runs lazily
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
    namespace: 'sandbox-recipes',
    contextRef: 'context1',
    contextUpdated: true,
    registryEntry: 'brave-search',
    registryVersion: '1.0.0',
    correlationId: 'test-corr-id',
  })
  mod.createMcpSecret = vi.fn().mockResolvedValue({ name: 'test-credentials' })
  mod.createMcpServer = vi.fn().mockResolvedValue({ metadata: { name: 'test-server' } })
  mod.getContext = vi.fn().mockResolvedValue({
    spec: { contextId: 'context1', mcpServers: [] },
  })
  mod.updateContext = vi.fn().mockResolvedValue({})
  mod.reportRegistryInstall = vi.fn().mockResolvedValue({ acknowledged: true, stored: true })
  mod.installRecipeFromRegistry = vi.fn().mockResolvedValue({
    recipeName: 'test-recipe',
    registryEntry: 'test',
    registryVersion: '1.0.0',
    correlationId: 'c2',
  })
  // addServerToContextAllowlist calls the mocked getContext + updateContext
  mod.addServerToContextAllowlist = vi.fn(async (serverName: string, contextRef: string) => {
    const ctx = await (mod.getContext as Function)(contextRef)
    const existing: string[] = ctx.spec?.mcpServers ?? []
    if (existing.includes(serverName)) return false
    await (mod.updateContext as Function)(contextRef, {
      spec: {
        contextId: ctx.spec?.contextId ?? contextRef,
        description: ctx.spec?.description,
        mcpServers: [...existing, serverName],
      },
    })
    return true
  })
  return mod
})

const MOCK_ENTRY: api.RegistryEntry = {
  id: '1',
  name: 'brave-search',
  version: '1.0.0',
  entry_type: 'mcp-server' as const,
  description: 'Brave web search',
  author: 'test',
  origin: 'human-authored',
  category: 'search',
  tags: ['search'],
  trust_level: 'high' as const,
  quality_tier: 'verified' as const,
  status: 'published',
  server_mode: 'local' as const,
  transport: 'streamableHttp',
  recipe_type: null,
  mcp_server_meta: { imageRef: 'brave-search:1.0', port: 3000 },
  recipe_meta: null,
  artifact_refs: null,
  downloads: 42,
  installs: 10,
  created_at: '2026-01-01T00:00:00Z',
}

const MOCK_LOCAL_EGRESS_ENTRY: api.RegistryEntry = {
  ...MOCK_ENTRY,
  name: 'airtable-mcp',
  description: 'Airtable MCP with outbound API access',
  mcp_server_meta: {
    imageRef: 'airtable-mcp:1.0',
    port: 3000,
    egressSummary: {
      domains: ['api.airtable.com'],
      ports: [443],
      wideCidr: false,
    },
  },
}

const MOCK_TOO_MANY_EGRESS_ENTRY: api.RegistryEntry = {
  ...MOCK_ENTRY,
  name: 'mcp-whois',
  description: 'WHOIS MCP with too many exact-host targets',
  mcp_server_meta: {
    imageRef: 'mcp-whois:1.0',
    port: 3000,
    egressSummary: {
      domains: [
        'whois.iana.org',
        'whois.verisign-grs.com',
        'whois.nic.io',
        'whois.nic.ai',
        'whois.nic.co',
        'whois.nic.xyz',
        'whois.publicinterestregistry.org',
      ],
      ports: [43, 80, 443],
      wideCidr: false,
    },
  },
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RegistryInstallModal -- render', () => {
  it('renders entry details when open', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(screen.getByText('brave-search')).toBeInTheDocument()
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    expect(screen.getByText('Brave web search')).toBeInTheDocument()
  })

  it('pre-fills server name from entry', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const nameInput = screen.getByLabelText('Server Name') as HTMLInputElement
    expect(nameInput.value).toBe('brave-search')
  })

  it('shows context selector with loaded contexts', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const contextSelect = screen.getByLabelText('Context') as HTMLSelectElement
    expect(contextSelect).toBeInTheDocument()

    const options = contextSelect.querySelectorAll('option')
    const optionTexts = Array.from(options).map(o => o.textContent)
    expect(optionTexts).toContain('context1')
  })

  it('hides credential form when not required', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('shows credential form when required', async () => {
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
      ],
    } as api.CredentialSchema)

    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(screen.getByRole('group')).toBeInTheDocument()
    expect(screen.getByText(/Credentials/)).toBeInTheDocument()
    expect(screen.getByLabelText('API Key')).toBeInTheDocument()
  })

  it('shows credential form when optional (required=false) but keys exist, and allows submit without filling it', async () => {
    vi.mocked(api.getRegistryCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'api-key',
      keys: [
        {
          name: 'GLASSNODE_API_KEY',
          label: 'Glassnode API Key',
          kind: 'api-key',
          semanticType: 'plain-string',
          description: 'Optional for free tier',
        },
      ],
    } as api.CredentialSchema)

    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(screen.getByRole('group')).toBeInTheDocument()
    expect(screen.getByText(/optional/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Glassnode API Key')).toBeInTheDocument()

    const installButton = screen.getByRole('button', { name: 'Install' })
    await waitFor(() => expect(installButton).not.toBeDisabled())

    fireEvent.click(installButton)
    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })
    const payload = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(payload.credentials).toBeUndefined()
  })
})

describe('RegistryInstallModal -- validation', () => {
  it('Install button disabled when context not selected', async () => {
    vi.mocked(api.getContexts).mockResolvedValueOnce({ items: [] })

    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).toBeDisabled()
  })
})

describe('RegistryInstallModal -- install flow', () => {
  it('full install flow calls APIs in order', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    // Context should be auto-selected to "context1" (the first available)
    const contextSelect = screen.getByLabelText('Context') as HTMLSelectElement
    expect(contextSelect.value).toBe('context1')

    // Click Install
    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).not.toBeDisabled()
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })

    // Verify installFromRegistry payload
    const payload = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(payload.serverName).toBe('brave-search')
    expect(payload.contextRef).toBe('context1')
    expect(payload.registryEntryName).toBe('brave-search')
    expect(payload.registryEntryVersion).toBe('1.0.0')
  })

  it('shows success toast on completion', async () => {
    const onInstalled = vi.fn()
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={onInstalled}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const installButton = screen.getByRole('button', { name: 'Install' })
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(screen.getByText(/was installed and added to context/)).toBeInTheDocument()
    })

    expect(onInstalled).toHaveBeenCalledTimes(1)
  })

  it('shows error when installFromRegistry fails', async () => {
    vi.mocked(api.installFromRegistry).mockRejectedValueOnce(
      new Error('409 Conflict: server already exists')
    )

    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const installButton = screen.getByRole('button', { name: 'Install' })
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(screen.getByText('409 Conflict: server already exists')).toBeInTheDocument()
    })

    // Should NOT show success toast
    expect(screen.queryByText('Connector Installed')).not.toBeInTheDocument()
    expect(screen.queryByText(/was installed and added to context/)).not.toBeInTheDocument()
  })

  it('ignores duplicate submits while an install is already in flight', async () => {
    const installDeferred = deferredPromise<api.InstallFromRegistryResponse>()
    vi.mocked(api.installFromRegistry).mockReturnValueOnce(installDeferred.promise)

    const onInstalled = vi.fn()
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={onInstalled}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const installButton = screen.getByRole('button', { name: 'Install' })
    fireEvent.click(installButton)
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })

    installDeferred.resolve({
      installed: true,
      serverName: 'brave-search',
      namespace: 'sandbox-recipes',
      contextRef: 'context1',
      contextUpdated: true,
      registryEntry: 'brave-search',
      registryVersion: '1.0.0',
    })

    await waitFor(() => {
      expect(screen.getByText(/was installed and added to context/)).toBeInTheDocument()
    })
    expect(onInstalled).toHaveBeenCalledTimes(1)
  })
})

describe('RegistryInstallModal -- visibility', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={false}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(screen.queryByText('Install Connector from Marketplace')).not.toBeInTheDocument()
  })
})

// ── Remote server_mode flow ──────────────────────────────────────────────────

const MOCK_REMOTE_ENTRY: api.RegistryEntry = {
  id: '2',
  name: 'sentry-mcp',
  version: '1.0.0',
  entry_type: 'mcp-server' as const,
  description: 'Sentry MCP for remote monitoring',
  author: 'test',
  origin: 'human-authored',
  category: 'monitoring',
  tags: ['monitoring'],
  trust_level: 'mid' as const,
  quality_tier: 'verified' as const,
  status: 'published',
  server_mode: 'remote' as const,
  transport: 'streamableHttp',
  recipe_type: null,
  mcp_server_meta: {
    imageRef: 'clerum/nginx-egress-proxy:0.1.0',
    port: 3000,
    remoteEndpoints: [
      { url: 'https://mcp.sentry.io/sse', region: 'us', description: 'US endpoint' },
    ],
  },
  recipe_meta: null,
  artifact_refs: null,
  downloads: 20,
  installs: 5,
  created_at: '2026-01-01T00:00:00Z',
}

const MOCK_WIDE_CIDR_ENTRY: api.RegistryEntry = {
  ...MOCK_ENTRY,
  name: 'wide-egress-mcp',
  description: 'connector requiring blanket outbound reachability',
  mcp_server_meta: {
    imageRef: 'wide-egress-mcp:1.0',
    port: 3000,
    egressSummary: {
      domains: [],
      ports: [443],
      wideCidr: true,
    },
  },
}

describe('RegistryInstallModal -- remote server flow', () => {
  it('test_registryInstallModal_remoteEntry_showsWarningBanner', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_REMOTE_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/Remote connector/)
    expect(alert).toHaveTextContent(/explicitly authorizes outbound egress/i)
    expect(alert).toHaveTextContent(/NetworkPolicy/i)
    expect(alert).toHaveTextContent('mcp.sentry.io')
    expect(alert).toHaveTextContent('443')
    expect(alert).toHaveTextContent(/egress proxy/)
    expect(alert).toHaveTextContent(/nginx/)
  })

  it('test_registryInstallModal_remoteEntry_payloadIncludesRemoteAndEgress', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_REMOTE_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).not.toBeDisabled()
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })

    // Server-side endpoint handles spec building — verify correct entry info is sent
    const payload = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(payload.serverName).toBe('sentry-mcp')
    expect(payload.registryEntryName).toBe('sentry-mcp')
    expect(payload.registryEntryVersion).toBe('1.0.0')
    expect(payload.contextRef).toBe('context1')
    expect(payload.egressBindings).toEqual([{ dns: 'mcp.sentry.io', port: 443, protocol: 'TCP' }])
  })

  it('blocks remote MCP install if the operator clears required vendor egress', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_REMOTE_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    fireEvent.change(screen.getByDisplayValue('Exact-host egress'), {
      target: { value: 'none' },
    })

    expect(screen.getByText(/Remote connectors must keep exact-host egress/i)).toBeInTheDocument()
    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).toBeDisabled()
  })

  it('test_registryInstallModal_remoteEntry_sendsCorrectEntryInfo', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_REMOTE_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const installButton = screen.getByRole('button', { name: 'Install' })
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })

    const payload = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    // Verify registry entry details are passed to server-side endpoint
    expect(payload.registryEntryName).toBe('sentry-mcp')
    expect(payload.registryEntryVersion).toBe('1.0.0')
  })

  it('test_registryInstallModal_localEntry_noWarningBanner', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(screen.queryByText(/external connector/)).not.toBeInTheDocument()
  })
})

describe('RegistryInstallModal -- external egress notice', () => {
  it('shows a stronger warning when the registry entry requests public-web egress', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_WIDE_CIDR_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(screen.getByText(/Public web egress required/i)).toBeInTheDocument()
    expect(
      screen.getAllByText((_, node) => node?.textContent?.includes('TCP ports 80, 443') ?? false)
        .length
    ).toBeGreaterThan(0)
    expect(screen.getAllByText(/Private, metadata, cluster-internal/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/wide CIDR/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/0\.0\.0\.0\/0/)).not.toBeInTheDocument()
  })
})

describe('RegistryInstallModal -- external egress notice', () => {
  it('shows explicit NetworkPolicy egress authorization for local entries with external APIs', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_LOCAL_EGRESS_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/External API access required/)
    expect(alert).toHaveTextContent(/explicitly authorizes outbound egress/i)
    expect(alert).toHaveTextContent(/NetworkPolicy/i)
    expect(alert).toHaveTextContent('api.airtable.com')
    expect(alert).toHaveTextContent('443')
  })

  it('blocks install when exact-host metadata expands beyond the CRD maximum', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_TOO_MANY_EGRESS_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(screen.getAllByText(/expands to 21 egress bindings/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/7 domain\(s\) x 3 port\(s\) = 21 binding\(s\)/i)).toBeInTheDocument()
    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).toBeDisabled()
  })

  it('sends an explicit empty egress override when the operator clears registry egress', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_LOCAL_EGRESS_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    fireEvent.change(screen.getByDisplayValue('Exact-host egress'), {
      target: { value: 'none' },
    })

    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).not.toBeDisabled()
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(api.installFromRegistry).mock.calls[0][0].egressBindings).toEqual([])
  })
})

describe('RegistryInstallModal -- credential filling', () => {
  it('test_registryInstallModal_credFilled_createsSecretBeforeServer', async () => {
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
      ],
    } as api.CredentialSchema)

    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    // Fill in the credential
    const apiKeyInput = screen.getByLabelText('API Key')
    fireEvent.change(apiKeyInput, { target: { value: 'sk-test-123' } })

    // Install
    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).not.toBeDisabled()
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })

    // Credentials should be passed to server-side install endpoint
    const payload = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(payload.credentials).toBeDefined()
    expect(payload.credentials!.API_KEY).toBe('sk-test-123')
  })

  it('accepts pasted API keys in credential fields', async () => {
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
      ],
    } as api.CredentialSchema)

    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const apiKeyInput = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.paste(apiKeyInput, {
      clipboardData: {
        getData: () => 'sk-pasted-123',
      },
    })

    expect(apiKeyInput).toHaveValue('sk-pasted-123')
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })
    const payload = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(payload.credentials!.API_KEY).toBe('sk-pasted-123')
  })

  it('falls back to embedded credential schema when schema endpoint fails', async () => {
    vi.mocked(api.getRegistryCredentialSchema).mockRejectedValueOnce(
      new Error('schema unavailable')
    )

    render(
      <RegistryInstallModal
        entry={{
          ...MOCK_ENTRY,
          mcp_server_meta: {
            ...MOCK_ENTRY.mcp_server_meta,
            credentialSchema: {
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
              ],
            },
          },
        }}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(screen.getByLabelText('API Key')).toBeInTheDocument()
    expect(
      screen.getByText(/Leave all credential fields empty to install now/i)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install' })).not.toBeDisabled()
  })

  it('keeps embedded credential keys when label/kind metadata is missing', async () => {
    vi.mocked(api.getRegistryCredentialSchema).mockRejectedValueOnce(
      new Error('schema unavailable')
    )

    render(
      <RegistryInstallModal
        entry={{
          ...MOCK_ENTRY,
          mcp_server_meta: {
            ...MOCK_ENTRY.mcp_server_meta,
            credentialSchema: {
              required: true,
              authType: 'api-key',
              // This test deliberately omits label/kind to verify the
              // component's graceful-fallback behavior. Cast bypasses the
              // CredentialKey type requirement for exactly that reason.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              keys: [{ name: 'API_KEY' } as any],
            },
          },
        }}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const fallbackInput = screen.getByLabelText('API_KEY')
    expect(fallbackInput).toHaveAttribute('type', 'password')

    fireEvent.change(fallbackInput, { target: { value: 'sk-test-embedded' } })
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })

    const payload = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(payload.credentials).toEqual({ API_KEY: 'sk-test-embedded' })
  })

  it('allows required credentials to stay empty for pending connector secret setup', async () => {
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
      ],
    } as api.CredentialSchema)

    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    expect(
      screen.getByText(/Leave all credential fields empty to install now/i)
    ).toBeInTheDocument()
    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).not.toBeDisabled()
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(api.installFromRegistry).toHaveBeenCalledTimes(1)
    })
    const payload = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(payload.credentials).toBeUndefined()
  })

  it('blocks partially filled required credentials with a clear message', async () => {
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

    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test-123' } })

    expect(
      screen.getByText(
        'Complete all credential fields or clear them all to install pending. Missing: Client Secret.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled()
    expect(api.installFromRegistry).not.toHaveBeenCalled()
  })
})

describe('RegistryInstallModal -- name validation', () => {
  it('test_registryInstallModal_invalidName_showsValidationError', async () => {
    render(
      <RegistryInstallModal
        entry={MOCK_ENTRY}
        isOpen={true}
        onClose={vi.fn()}
        onInstalled={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument()
    })

    const nameInput = screen.getByLabelText('Server Name') as HTMLInputElement
    // setServerName lowercases the input, so we need to set it directly via onChange
    fireEvent.change(nameInput, { target: { value: '-invalid-name-' } })

    // Should show the validation warning
    expect(screen.getByText(/Must be a valid K8s name/)).toBeInTheDocument()

    // Install button should be disabled
    const installButton = screen.getByRole('button', { name: 'Install' })
    expect(installButton).toBeDisabled()
  })
})
