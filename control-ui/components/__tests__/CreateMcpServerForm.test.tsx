import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { CreateMcpServerForm } from '../CreateMcpServerForm'
import { ToastProvider } from '../Toast'

// vi.mock is hoisted before imports; factory runs lazily so references to `api` are safe.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    // Spread the real module so helpers the form imports directly (e.g.
    // getMcpSecretRollbackRepairIdentity) keep their real behaviour; every
    // network-touching export below is then overridden explicitly.
    ...actual,
    apiSend: vi.fn().mockResolvedValue({}),
    createMcpServer: vi.fn().mockResolvedValue({ metadata: { name: 'test-server' } }),
    listMcpSecrets: vi.fn().mockResolvedValue({
      items: [{ name: 'shared-credentials', uid: 'shared-uid', keys: ['api-key'] }],
    }),
    createMcpSecret: vi.fn().mockResolvedValue({
      name: 'test-credentials',
      namespace: 'mcp-server',
      uid: 'uid-test-credentials',
      resourceVersion: '1',
    }),
    deleteMcpSecret: vi.fn().mockResolvedValue({ name: 'test-credentials' }),
    listOrgImages: vi.fn().mockResolvedValue({ org: 'evenfire-dev', images: [] }),
    // Creating a connector touches no Context or agent: kept as spies to lock that contract.
    getContexts: vi.fn(),
    getContext: vi.fn(),
    getHosts: vi.fn(),
    updateContext: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

async function fillIdentity(name = 'brave-search') {
  fireEvent.change(await screen.findByPlaceholderText('my-mcp-server'), {
    target: { value: name },
  })
  fireEvent.change(
    screen.getByPlaceholderText('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest'),
    { target: { value: 'ghcr.io/example/mcp:1.0' } }
  )
}

function openAdvanced() {
  fireEvent.click(screen.getByText('Advanced options'))
}

function continueToSecrets() {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

function chooseNoCredentials() {
  fireEvent.click(screen.getByRole('radio', { name: /No credentials required/ }))
}

function chooseNewSecret() {
  fireEvent.click(screen.getByRole('radio', { name: /Create Kubernetes Secret/ }))
}

function mcpSecretRollbackRepairError(created: Record<string, unknown>) {
  return Object.assign(
    new Error('503 Service Unavailable - mcp_secret_rollback_permit_unavailable'),
    {
      status: 503,
      code: 'mcp_secret_rollback_permit_unavailable',
      body: {
        error: 'mcp_secret_rollback_permit_unavailable',
        outcome: 'repair_required',
        created,
      },
    }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
describe('CreateMcpServerForm — render', () => {
  it('renders the section title', () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Create connector' })).toBeInTheDocument()
  })

  it('renders the Continue button disabled until required fields are filled', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(continueButton).toBeDisabled()

    await fillIdentity()

    expect(continueButton).not.toBeDisabled()
  })

  it('selects an organization image and fills its full registry coordinate', async () => {
    vi.mocked(api.listOrgImages).mockResolvedValueOnce({
      org: 'evenfire-dev',
      images: [
        {
          name: 'todoist-mcp-server',
          visibility: 'private',
          createdAt: '2026-08-05',
          tags: ['1.0.0'],
        },
      ],
    })
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)

    const imageField = await screen.findByPlaceholderText(
      'us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest'
    )
    fireEvent.focus(imageField)
    fireEvent.click(screen.getByRole('option', { name: 'todoist-mcp-server:1.0.0' }))

    expect(
      screen.getByDisplayValue('registry.evenfire.ai/evenfire-dev/todoist-mcp-server:1.0.0')
    ).toBeInTheDocument()
  })

  it('uses connector and secrets steps, with no access step', () => {
    const { container } = render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    expect(container.querySelectorAll('.cu-agent-step-rail__item')).toHaveLength(2)
    const stepTitles = Array.from(container.querySelectorAll('.cu-agent-step-rail__title')).map(
      element => element.textContent
    )
    expect(stepTitles).toEqual(['Connector', 'Secrets'])
    expect(screen.queryByText('Step 1 of 3')).not.toBeInTheDocument()
    expect(screen.queryByText('Step 1 of 4')).not.toBeInTheDocument()
  })

  it('hides the advanced options by default and reveals them on toggle', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    const summary = screen.getByText('Advanced options')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute('open')

    fireEvent.click(summary)

    expect(details).toHaveAttribute('open')
  })

  it('shows the Port field when transport is streamableHttp (default)', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    openAdvanced()
    expect(screen.getByDisplayValue('3000')).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Name validation (DNS-label pattern)
// ─────────────────────────────────────────────────────────────────────────────
describe('CreateMcpServerForm — name validation', () => {
  it('lowercases and strips invalid characters from name input', () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    const nameField = screen.getByPlaceholderText('my-mcp-server') as HTMLInputElement
    fireEvent.change(nameField, { target: { value: 'My_MCP.Server!' } })
    // Uppercase → lowercase, invalid chars (_, ., !) stripped
    expect(nameField.value).toBe('mymcpserver')
  })

  it('accepts a valid DNS-label name', () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    const nameField = screen.getByPlaceholderText('my-mcp-server') as HTMLInputElement
    fireEvent.change(nameField, { target: { value: 'brave-search' } })
    expect(nameField.value).toBe('brave-search')
    // No error banner for a valid name
    expect(screen.queryByText(/Name must match/)).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Transport behavior
// ─────────────────────────────────────────────────────────────────────────────
describe('CreateMcpServerForm — transport', () => {
  it('hides the Port field when transport is set to stdio', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    openAdvanced()
    // Port defaults to 3000 and is visible initially
    expect(screen.getByDisplayValue('3000')).toBeInTheDocument()

    // SelectInput is a custom control; grab the transport dropdown by its
    // default selected option text (label: "StreamableHTTP") rather than an
    // accessible-name lookup, since the component does not wire htmlFor/
    // aria-labelledby. The `Managed` select has two different option labels
    // starting with "Yes" / "No" so there is no collision.
    const transportSelect = screen.getByDisplayValue('StreamableHTTP')
    fireEvent.change(transportSelect, { target: { value: 'stdio' } })

    expect(screen.queryByDisplayValue('3000')).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Credentials
// ─────────────────────────────────────────────────────────────────────────────
describe('CreateMcpServerForm — secret reference', () => {
  it('requires an explicit credential decision before creation is enabled', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    continueToSecrets()

    const submit = screen.getByRole('button', { name: 'Create connector' })
    expect(submit).toBeDisabled()

    chooseNoCredentials()

    expect(submit).not.toBeDisabled()
  })

  it('reveals the Kubernetes Secret Name input when Create Kubernetes Secret is selected', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    continueToSecrets()

    // Not visible by default
    expect(screen.queryByPlaceholderText('brave-search-credentials')).not.toBeInTheDocument()

    chooseNewSecret()

    expect(screen.getByPlaceholderText('brave-search-credentials')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Key Mapping' })).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cancel
// ─────────────────────────────────────────────────────────────────────────────
describe('CreateMcpServerForm — cancel', () => {
  it('invokes onCancel when the Cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(<CreateMcpServerForm onCancel={onCancel} onCreated={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Happy-path submission
// ─────────────────────────────────────────────────────────────────────────────
describe('CreateMcpServerForm — submit', () => {
  async function fillRequired(name = 'brave-search') {
    await fillIdentity(name)
    continueToSecrets()
    chooseNoCredentials()
  }

  it('creates the connector without a Context and leaves agent access for later', async () => {
    const onCreated = vi.fn()
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={onCreated} />)
    await fillRequired()

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => {
      expect(api.createMcpServer).toHaveBeenCalledTimes(1)
    })
    // Spec shape: streamableHttp default, managed: true default, in-cluster URL from the name.
    const createCall = (api.createMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall).toMatchObject({
      metadata: { name: 'brave-search' },
      spec: {
        image: 'ghcr.io/example/mcp:1.0',
        enabled: true,
        managed: true,
        transport: {
          type: 'streamableHttp',
          port: 3000,
          url: 'http://brave-search.mcp-server.svc.cluster.local:3000/mcp',
        },
      },
    })
    expect(createCall.spec).not.toHaveProperty('contextRef')
    expect(api.apiSend).not.toHaveBeenCalled()
    expect(api.getHosts).not.toHaveBeenCalled()
    expect(api.getContext).not.toHaveBeenCalled()
    expect(api.updateContext).not.toHaveBeenCalled()

    expect(
      screen.getByText(
        'Connector created. Give agents access from the Installed Connectors list whenever you’re ready.'
      )
    ).toBeInTheDocument()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1), { timeout: 1500 })
  })

  it('sends managed: false when the operator deploys the pod themselves', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    openAdvanced()
    fireEvent.change(screen.getByDisplayValue(/^Yes — Evenfire creates/), {
      target: { value: 'false' },
    })
    continueToSecrets()
    chooseNoCredentials()

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => expect(api.createMcpServer).toHaveBeenCalledTimes(1))
    const createCall = (api.createMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall.spec.managed).toBe(false)
  })

  it('submits exact-host egress bindings when configured', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    openAdvanced()

    fireEvent.change(screen.getByDisplayValue('No external egress (closed by default)'), {
      target: { value: 'exact-host' },
    })
    fireEvent.change(screen.getByPlaceholderText('api.example.com, auth.example.com'), {
      target: { value: 'api.example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('443'), {
      target: { value: '443' },
    })
    continueToSecrets()

    chooseNoCredentials()

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => {
      expect(api.createMcpServer).toHaveBeenCalledTimes(1)
    })
    const createCall = (api.createMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall.spec.egressBindings).toEqual([
      { dns: 'api.example.com', port: 443, protocol: 'TCP' },
    ])
  })

  it('submits public-web as one explicit egress class binding', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    openAdvanced()

    fireEvent.change(screen.getByDisplayValue('No external egress (closed by default)'), {
      target: { value: 'public-web' },
    })
    continueToSecrets()

    chooseNoCredentials()

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => {
      expect(api.createMcpServer).toHaveBeenCalledTimes(1)
    })
    const createCall = (api.createMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall.spec.egressBindings).toEqual([{ egressClass: 'public-web' }])
  })

  it('submits exact-cidr egress bindings when configured', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    openAdvanced()

    fireEvent.change(screen.getByDisplayValue('No external egress (closed by default)'), {
      target: { value: 'exact-cidr' },
    })
    fireEvent.change(screen.getByPlaceholderText('203.0.114.10/32, 8.8.8.8'), {
      target: { value: '8.8.8.8' },
    })
    fireEvent.change(screen.getByPlaceholderText('443'), {
      target: { value: '443' },
    })
    continueToSecrets()

    chooseNoCredentials()

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => {
      expect(api.createMcpServer).toHaveBeenCalledTimes(1)
    })
    const createCall = (api.createMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall.spec.egressBindings).toEqual([
      { cidr: '8.8.8.8/32', port: 443, protocol: 'TCP' },
    ])
  })

  it('shows an error banner when createMcpServer rejects', async () => {
    ;(api.createMcpServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('image pull failed')
    )
    const onCreated = vi.fn()
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={onCreated} />)
    await fillRequired()

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => {
      expect(screen.getByText('image pull failed')).toBeInTheDocument()
    })
    expect(onCreated).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PR-A / A2 — envSecret client validation + rollback
// ─────────────────────────────────────────────────────────────────────────────
describe('CreateMcpServerForm — envSecret guardrails', () => {
  async function fillRequiredBasics(name = 'brave-search') {
    await fillIdentity(name)
    continueToSecrets()
  }

  function enableEnvSecret(secretName = 'brave-credentials') {
    chooseNewSecret()
    fireEvent.change(screen.getByPlaceholderText('brave-search-credentials'), {
      target: { value: secretName },
    })
  }

  it('keeps Create disabled when a Secret has no key mappings', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret()
    // No "Add Key Mapping" click — zero rows total.

    const submit = screen.getByRole('button', { name: 'Create connector' })
    expect(submit).toBeDisabled()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.createMcpServer).not.toHaveBeenCalled()
  })

  it('keeps Create disabled when a Secret mapping is incomplete', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret()
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))

    // Fill secretKey + envVar but leave value blank (the broken shape).
    const secretKeyInput = screen.getByPlaceholderText('api-key') as HTMLInputElement
    const envVarInput = screen.getByPlaceholderText('BRAVE_API_KEY') as HTMLInputElement
    fireEvent.change(secretKeyInput, { target: { value: 'api-key' } })
    fireEvent.change(envVarInput, { target: { value: 'BRAVE_API_KEY' } })

    const submit = screen.getByRole('button', { name: 'Create connector' })
    expect(submit).toBeDisabled()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.createMcpServer).not.toHaveBeenCalled()
  })

  it('keeps Create disabled when every Secret mapping row is blank', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret()
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))

    // Leave both secretKey and value blank. Row exists but no meaningful data.
    // This triggers the "Add at least one key-value pair or disable envSecret"
    // path (meaningfulRows.length === 0).
    const submit = screen.getByRole('button', { name: 'Create connector' })
    expect(submit).toBeDisabled()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.createMcpServer).not.toHaveBeenCalled()
  })

  it('rolls back the created Secret when createMcpServer rejects', async () => {
    ;(api.createMcpServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('422 Unprocessable - {"message":"Connector create failed"}')
    )

    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret('brave-credentials')
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))
    fireEvent.change(screen.getByPlaceholderText('api-key'), {
      target: { value: 'api-key' },
    })
    fireEvent.change(screen.getByPlaceholderText('BRAVE_API_KEY'), {
      target: { value: 'BRAVE_API_KEY' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'sk-test-abc' },
    })

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    // Secret created first
    await waitFor(() => {
      expect(api.createMcpSecret).toHaveBeenCalledTimes(1)
    })
    expect(api.createMcpSecret).toHaveBeenCalledWith('brave-credentials', {
      'api-key': 'sk-test-abc',
    })

    // CRD failed → rollback deletes the Secret once with same name
    await waitFor(() => {
      expect(api.deleteMcpSecret).toHaveBeenCalledTimes(1)
    })
    expect(api.deleteMcpSecret).toHaveBeenCalledWith('brave-credentials', {
      uid: 'uid-test-credentials',
      resourceVersion: '1',
    })

    // JSON API errors surface their server message after rollback.
    await waitFor(() => {
      expect(screen.getByText('Connector create failed')).toBeInTheDocument()
    })
  })

  it('rolls back a repaired Secret with CAS when createMcpSecret rejects', async () => {
    ;(api.createMcpSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      mcpSecretRollbackRepairError({
        name: 'requested-credentials',
        namespace: 'mcp-server',
        uid: 'uid-requested-credentials',
        resourceVersion: '17',
      })
    )

    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret('requested-credentials')
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))
    fireEvent.change(screen.getByPlaceholderText('api-key'), {
      target: { value: 'api-key' },
    })
    fireEvent.change(screen.getByPlaceholderText('BRAVE_API_KEY'), {
      target: { value: 'BRAVE_API_KEY' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'sk-test-abc' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }))

    await waitFor(() => {
      expect(api.deleteMcpSecret).toHaveBeenCalledWith('requested-credentials', {
        uid: 'uid-requested-credentials',
        resourceVersion: '17',
      })
    })
    expect(api.createMcpServer).not.toHaveBeenCalled()
  })

  it('does not use a bodyless rollback when a repair response has incomplete identity', async () => {
    ;(api.createMcpSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      mcpSecretRollbackRepairError({
        name: 'repaired-credentials',
        namespace: 'mcp-server',
        uid: 'uid-repaired-credentials',
      })
    )

    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret('requested-credentials')
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))
    fireEvent.change(screen.getByPlaceholderText('api-key'), {
      target: { value: 'api-key' },
    })
    fireEvent.change(screen.getByPlaceholderText('BRAVE_API_KEY'), {
      target: { value: 'BRAVE_API_KEY' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'sk-test-abc' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }))

    await waitFor(() => {
      expect(screen.getByText(/mcp_secret_rollback_permit_unavailable/)).toBeInTheDocument()
    })
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    expect(api.createMcpServer).not.toHaveBeenCalled()
  })

  it('uses the legacy bodyless rollback when the create API omits identity fields', async () => {
    ;(api.createMcpSecret as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: 'legacy-credentials',
      namespace: 'mcp-server',
    })
    ;(api.createMcpServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Connector create failed')
    )

    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret('legacy-credentials')
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))
    fireEvent.change(screen.getByPlaceholderText('api-key'), {
      target: { value: 'api-key' },
    })
    fireEvent.change(screen.getByPlaceholderText('BRAVE_API_KEY'), {
      target: { value: 'BRAVE_API_KEY' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'test-value' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }))

    await waitFor(() => {
      expect(api.deleteMcpSecret).toHaveBeenCalledWith('legacy-credentials', undefined)
    })
    expect(screen.getByText('Connector create failed')).toBeInTheDocument()
  })

  it('preserves the primary error when legacy rollback fails against a newer delete API', async () => {
    ;(api.createMcpSecret as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: 'mixed-version-credentials',
      namespace: 'mcp-server',
    })
    ;(api.createMcpServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Connector create failed')
    )
    ;(api.deleteMcpSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('428 Precondition Required - current identity required')
    )

    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret('mixed-version-credentials')
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))
    fireEvent.change(screen.getByPlaceholderText('api-key'), {
      target: { value: 'api-key' },
    })
    fireEvent.change(screen.getByPlaceholderText('BRAVE_API_KEY'), {
      target: { value: 'BRAVE_API_KEY' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'test-value' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }))

    await waitFor(() => {
      expect(api.deleteMcpSecret).toHaveBeenCalledWith('mixed-version-credentials', undefined)
    })
    expect(screen.getByText(/Connector create failed/)).toBeInTheDocument()
    expect(
      screen.getByText(
        /Cleanup of the created Secret "mixed-version-credentials" also failed: 428 Precondition Required - current identity required\. Refresh the page and review the Secret before taking further action\./
      )
    ).toBeInTheDocument()
  })

  it('happy path: creates Secret then CRD, no rollback', async () => {
    const onCreated = vi.fn()
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={onCreated} />)
    await fillRequiredBasics()
    enableEnvSecret('brave-credentials')
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))
    fireEvent.change(screen.getByPlaceholderText('api-key'), {
      target: { value: 'api-key' },
    })
    fireEvent.change(screen.getByPlaceholderText('BRAVE_API_KEY'), {
      target: { value: 'BRAVE_API_KEY' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'sk-live-xyz' },
    })

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => {
      expect(api.createMcpSecret).toHaveBeenCalledTimes(1)
      expect(api.createMcpServer).toHaveBeenCalledTimes(1)
    })
    // Rollback must NOT fire on success
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'Connector created. Give agents access from the Installed Connectors list whenever you’re ready.'
      )
    ).toBeInTheDocument()
  })
})

describe('CreateMcpServerForm — reusable Secrets', () => {
  async function prepareExisting() {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillIdentity()
    continueToSecrets()
    fireEvent.click(screen.getByRole('radio', { name: /Use an existing Secret/ }))
    await waitFor(() => expect(screen.getByLabelText(/^Existing Secret/)).toBeEnabled())
    fireEvent.click(screen.getByLabelText(/^Existing Secret/))
    fireEvent.click(await screen.findByRole('option', { name: 'shared-credentials' }))
  }
  it('creates a connector referencing stored keys without requesting or writing values', async () => {
    await prepareExisting()
    expect(screen.queryByPlaceholderText('sk-...')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Environment variable 1/)).toHaveValue('API_KEY')
    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }))
    await waitFor(() => expect(api.createMcpServer).toHaveBeenCalledOnce())
    expect(api.createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          envSecret: {
            name: 'shared-credentials',
            keys: [{ secretKey: 'api-key', envVar: 'API_KEY' }],
          },
        }),
      })
    )
    expect(api.listMcpSecrets).toHaveBeenCalledTimes(2)
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('keeps a shared Secret when connector creation fails', async () => {
    vi.mocked(api.createMcpServer).mockRejectedValueOnce(new Error('connector rejected'))
    await prepareExisting()
    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('connector rejected')
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('checks the selected Secret identity before creating an access scope or connector', async () => {
    await prepareExisting()
    vi.mocked(api.listMcpSecrets).mockResolvedValueOnce({
      items: [{ name: 'shared-credentials', uid: 'replaced-uid', keys: ['api-key'] }],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified')
    expect(api.apiSend).not.toHaveBeenCalled()
    expect(api.createMcpServer).not.toHaveBeenCalled()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create connector' })).toBeDisabled()
  })
  it('blocks invalid and colliding environment destinations', async () => {
    await prepareExisting()
    fireEvent.change(screen.getByLabelText(/^Environment variable 1/), {
      target: { value: 'NODE_OPTIONS' },
    })
    expect(screen.getByRole('button', { name: 'Create connector' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('runtime')
  })
})
