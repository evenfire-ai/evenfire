import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { CreateMcpServerForm } from '../CreateMcpServerForm'
import { ToastProvider } from '../Toast'

// vi.mock is hoisted before imports; factory runs lazily so references to `api` are safe.
vi.mock('../../lib/api', async () => {
  const { buildContextList, buildContextResource } =
    await import('../../test/fixtures/contextResource')
  const context1 = buildContextResource({
    metadata: { name: 'context1', resourceVersion: 'rv-context1' },
  })
  return {
    createMcpServer: vi.fn().mockResolvedValue({ metadata: { name: 'test-server' } }),
    createMcpSecret: vi.fn().mockResolvedValue({
      name: 'test-credentials',
      uid: 'uid-test-credentials',
      resourceVersion: '1',
    }),
    deleteMcpSecret: vi.fn().mockResolvedValue({ name: 'test-credentials' }),
    getContexts: vi.fn().mockResolvedValue(
      buildContextList([
        context1,
        buildContextResource({
          metadata: { name: 'research', resourceVersion: 'rv-research' },
        }),
      ])
    ),
    getContext: vi.fn().mockResolvedValue(context1),
    getContextTeams: vi.fn().mockResolvedValue({ items: [] }),
    getContextUsers: vi.fn().mockResolvedValue({ items: [] }),
    listOrgImages: vi.fn().mockResolvedValue({ org: 'evenfire-dev', images: [] }),
    getHosts: vi.fn().mockResolvedValue({ items: [] }),
    updateContext: vi.fn().mockResolvedValue({}),
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
  await waitFor(() => expect(api.getContexts).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByPlaceholderText('my-mcp-server'), {
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
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

function chooseNoCredentials() {
  fireEvent.click(screen.getByRole('radio', { name: /No credentials required/ }))
}

function chooseNewSecret() {
  fireEvent.click(screen.getByRole('radio', { name: /Create Kubernetes Secret/ }))
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

  it('loads available contexts into the dedicated Context step', async () => {
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)

    await fillIdentity()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Context access' })).toBeInTheDocument()
    )
    const contextSelector = screen.getByRole('button', { name: 'context1' })
    fireEvent.click(contextSelector)

    expect(screen.getByRole('option', { name: 'context1' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'research' })).toBeInTheDocument()
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

  it('uses connector, context, and secrets steps', () => {
    const { container } = render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    expect(container.querySelectorAll('.cu-agent-step-rail__item')).toHaveLength(3)
    expect(screen.queryByText('Step 1 of 3')).not.toBeInTheDocument()
    expect(screen.queryByText('Step 1 of 4')).not.toBeInTheDocument()
  })

  it('previews the selected context access before continuing to secrets', async () => {
    vi.mocked(api.getContextUsers).mockResolvedValueOnce({
      items: [{ id: 'user-1', displayName: 'Josue', email: 'josue@example.com', name: 'josue' }],
    })
    vi.mocked(api.getContextTeams).mockResolvedValueOnce({
      items: [{ id: 'team-1', name: 'Development Team' }],
    })
    vi.mocked(api.getHosts).mockResolvedValueOnce({
      items: [{ metadata: { name: 'agents/product' }, spec: { contextRef: 'context1' } }],
    })
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)

    await fillIdentity()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Josue')).toBeInTheDocument()
    expect(screen.getByText('Development Team')).toBeInTheDocument()
    expect(screen.getByText('product')).toBeInTheDocument()
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

  it('calls createMcpServer and adds the server to the Context allowlist on submit', async () => {
    const onCreated = vi.fn()
    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={onCreated} />)
    await fillRequired()

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => {
      expect(api.createMcpServer).toHaveBeenCalledTimes(1)
    })
    // Spec shape: streamableHttp default, managed: true default, in-cluster URL from the name
    const createCall = (api.createMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall).toMatchObject({
      metadata: { name: 'brave-search' },
      spec: {
        image: 'ghcr.io/example/mcp:1.0',
        contextRef: 'context1',
        enabled: true,
        managed: true,
        transport: {
          type: 'streamableHttp',
          port: 3000,
          url: 'http://brave-search.mcp-server.svc.cluster.local:3000/mcp',
        },
      },
    })

    // Context allowlist update
    await waitFor(() => {
      expect(api.getContext).toHaveBeenCalledWith('context1')
      expect(api.updateContext).toHaveBeenCalledTimes(1)
    })
    const updateCall = (api.updateContext as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(updateCall[0]).toBe('context1')
    expect(updateCall[1]).toMatchObject({
      metadata: { resourceVersion: 'rv-context1' },
      spec: { contextId: 'context1', mcpServers: ['brave-search'] },
    })

    // Success toast + delayed onCreated callback
    expect(screen.getByText('Connector created successfully.')).toBeInTheDocument()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1), { timeout: 1500 })
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
      Object.assign(new Error('422 Unprocessable - {"message":"Connector create failed"}'), {
        status: 422,
      })
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

  it('keeps the Secret when createMcpServer fails ambiguously', async () => {
    ;(api.createMcpServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('503 Service Unavailable - {"error":"repair_required"}'), {
        status: 503,
      })
    )

    render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
    await fillRequiredBasics()
    enableEnvSecret('ambiguous-credentials')
    fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))
    fireEvent.change(screen.getByPlaceholderText('api-key'), {
      target: { value: 'api-key' },
    })
    fireEvent.change(screen.getByPlaceholderText('BRAVE_API_KEY'), {
      target: { value: 'BRAVE_API_KEY' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'sk-ambiguous' },
    })

    const submit = screen.getByRole('button', { name: 'Create connector' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    await waitFor(() => expect(api.createMcpServer).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/Secret was retained/i)).toBeInTheDocument())
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })

  it.each([408, 409, 429])(
    'keeps the Secret when connector creation returns ambiguous HTTP %s',
    async status => {
      ;(api.createMcpServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error(`${status} connector create outcome is ambiguous`), { status })
      )

      render(<CreateMcpServerForm onCancel={vi.fn()} onCreated={vi.fn()} />)
      await fillRequiredBasics()
      enableEnvSecret('ambiguous-credentials')
      fireEvent.click(screen.getByRole('button', { name: 'Add Key Mapping' }))
      fireEvent.change(screen.getByPlaceholderText('api-key'), {
        target: { value: 'api-key' },
      })
      fireEvent.change(screen.getByPlaceholderText('BRAVE_API_KEY'), {
        target: { value: 'BRAVE_API_KEY' },
      })
      fireEvent.change(screen.getByPlaceholderText('sk-...'), {
        target: { value: 'sk-ambiguous' },
      })

      const submit = screen.getByRole('button', { name: 'Create connector' })
      await waitFor(() => expect(submit).not.toBeDisabled())
      fireEvent.click(submit)

      await waitFor(() => expect(api.createMcpServer).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(screen.getByText(/Secret was retained/i)).toBeInTheDocument())
      expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    }
  )

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
    expect(screen.getByText('Connector created successfully.')).toBeInTheDocument()
  })
})
