import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { buildContextList, buildContextResource } from '../../test/fixtures/contextResource'
import { buildSecretSummary } from '../../test/fixtures/secretSummary'
import { HostWizard } from '../HostWizard'
import { ToastProvider } from '../Toast'

/**
 * Tests for the HostWizard refactor that closes an authorization gap: admins
 * could create agents without selecting any user in the "Access" step
 * (labeled "optional"), which silently left them unusable by everyone. The
 * fix adds:
 *
 *   1. A visible empty-access note when selection is empty
 *   2. A non-blocking access reminder before continuing
 *   3. An atomic call to updateAgentUsers/updateAgentTeams instead of
 *      the N×(GET+PUT) loop that was prone to race conditions
 *   4. Visible error surfacing when loadDirectory fails (was silently swallowed)
 *
 * These tests lock the new behavior so it cannot regress.
 */

// Mock lib/api BEFORE importing the component. vi.mock is hoisted.
vi.mock('../../lib/api', () => ({
  apiGet: vi.fn().mockResolvedValue({ items: [] }),
  apiSend: vi.fn().mockResolvedValue({}),
  getAdminUsers: vi.fn().mockResolvedValue({
    items: [
      { id: 'user-a', email: 'alice@example.com', name: 'Alice', displayName: null },
      { id: 'user-b', email: 'bob@example.com', name: 'Bob', displayName: null },
    ],
  }),
  getAdminTeams: vi.fn().mockResolvedValue({
    items: [{ id: 'team-1', name: 'Engineering', memberCount: 3 }],
  }),
  updateAgentUsers: vi.fn().mockResolvedValue({ agentName: '', userIds: [] }),
  updateAgentTeams: vi.fn().mockResolvedValue({ agentName: '', teamIds: [] }),
  // The model picker now loads the operator allowlist via useLlmAllowedModels.
  getLlmModels: vi.fn().mockResolvedValue({
    rows: [
      {
        id: 'm1',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        vendor: 'OpenAI',
        display_name: null,
        context_window_tokens: null,
        enabled: true,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'm2',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        vendor: 'Anthropic',
        display_name: null,
        context_window_tokens: null,
        enabled: true,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'm3',
        provider: 'zai',
        model: 'glm-5.1',
        vendor: 'Z.AI',
        display_name: null,
        context_window_tokens: null,
        enabled: true,
        created_at: '',
        updated_at: '',
      },
    ],
  }),
  isSilentApiError: vi.fn().mockReturnValue(false),
}))

// scrollIntoView is used by some step rendering and is not implemented in jsdom
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

async function renderWizard(props?: {
  mcpServers?: Array<{ metadata?: { name?: string; namespace?: string } }>
  existingSecrets?: Array<{ name?: string; keys?: string[] }>
}) {
  const onCreated = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const utils = render(
    <ToastProvider>
      <HostWizard
        mcpServers={props?.mcpServers ?? [{ metadata: { name: 'mcp-a' } }]}
        existingSecrets={props?.existingSecrets ?? [buildSecretSummary({ name: 'secret-a' })]}
        onCreated={onCreated}
        onClose={onClose}
      />
    </ToastProvider>
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return { ...utils, onCreated, onClose }
}

/**
 * Walk through the setup steps filling minimal valid values, landing on Access.
 * Each step's validation is tested elsewhere — this helper is only a
 * vehicle to reach the Access step quickly.
 */
async function walkToAccessStep(opts?: { agentName?: string }) {
  const name = opts?.agentName ?? 'testagent'

  // Wait for loadDirectory to resolve (otherwise the users list is empty)
  await waitFor(() => {
    expect(api.getAdminUsers).toHaveBeenCalled()
  })

  // Step 0: Agent name
  fireEvent.change(screen.getByPlaceholderText(/agent-name/i), {
    target: { value: name },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  // Step 1: Context — create a new context. MCP attachments are optional,
  // but this helper selects one to keep existing submit payload coverage.
  fireEvent.click(screen.getByLabelText(/Create new context/i))
  fireEvent.change(screen.getByPlaceholderText(/context-name/i), {
    target: { value: 'ctx1' },
  })
  // Select the first connector checkbox
  const mcpCheckbox = screen.getByRole('checkbox', { name: /mcp-a/i }) as HTMLInputElement
  fireEvent.click(mcpCheckbox)
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  // Step 2: Model & Credentials — default model is valid; reuse the secret we provided.
  fireEvent.click(screen.getByLabelText(/Use an existing Secret/i))
  fireEvent.click(screen.getByRole('button', { name: /Select secret/i }))
  fireEvent.click(screen.getByRole('option', { name: /secret-a/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  // Now at the "Access" step.
}

function openTeamsAccessTab() {
  fireEvent.click(screen.getByRole('tab', { name: /Teams/i }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HostWizard — credential draft is projected onto the active provider domain', () => {
  it('shows every provider with complete credentials for an existing Secret', async () => {
    await renderWizard({
      existingSecrets: [
        buildSecretSummary({
          name: 'shared-llm-keys',
          keys: ['openai-api-key', 'aws-access-key-id', 'aws-secret-access-key'],
        }),
      ],
    })
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'testagent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: 'ctx1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText(/Use an existing Secret/i))
    fireEvent.click(screen.getByRole('button', { name: /Select secret/i }))

    const option = screen.getByRole('option', { name: /shared-llm-keys/ })
    expect(option).toHaveTextContent(/Providers: OpenAI, Amazon Bedrock/)
  })

  it('matches the primary provider to the selected credential', async () => {
    await renderWizard({
      existingSecrets: [
        buildSecretSummary({ name: 'zai-only', keys: ['zai-api-key'] }),
        buildSecretSummary({
          name: 'anthropic-and-zai',
          keys: ['claude-api-key', 'zai-api-key'],
        }),
      ],
    })
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'testagent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: 'ctx1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    fireEvent.click(screen.getByRole('button', { name: /Select secret/i }))
    fireEvent.click(screen.getByRole('option', { name: /zai-only/i }))
    const providerField = screen.getByText('Provider', { selector: 'label' }).parentElement
    const modelField = screen.getByText('Default model', { selector: 'label' }).parentElement
    expect(providerField).toHaveTextContent('Z.AI')
    expect(modelField).toHaveTextContent('glm-5.1')

    fireEvent.click(screen.getByRole('button', { name: /zai-only/i }))
    fireEvent.click(screen.getByRole('option', { name: /anthropic-and-zai/i }))
    expect(providerField).toHaveTextContent('Anthropic')
    expect(modelField).toHaveTextContent('claude-sonnet-4-6')
  })

  it('leads with an existing Secret and keeps fallback providers collapsed in create', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'testagent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: 'ctx1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    const existingCard = screen.getByLabelText(/Use an existing Secret/i).closest('label')
    const newCard = screen.getByLabelText(/New secret/i).closest('label')
    expect(existingCard).not.toBeNull()
    expect(newCard).not.toBeNull()
    expect(screen.getByLabelText(/Use an existing Secret/i)).toBeChecked()
    expect(screen.getByLabelText(/New secret/i)).not.toBeChecked()
    expect(screen.getByText('Credential', { selector: 'strong' })).toBeInTheDocument()
    expect(existingCard?.compareDocumentPosition(newCard as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    const fallbackToggle = screen.getByRole('button', { name: /Fallback providers/i })
    expect(fallbackToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Add fallback provider' })).not.toBeInTheDocument()
    fireEvent.click(fallbackToggle)
    expect(screen.getByRole('button', { name: 'Add fallback provider' })).toBeInTheDocument()
  })

  it('a Bedrock fallback key does NOT block save nor get written once the fallback is removed', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    // Step 0: name.
    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), {
      target: { value: 'bedrock-orphan' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Step 1: a new context with just a name.
    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: 'ctx1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Step 2: explicitly create a new Secret and make the OpenAI primary usable.
    fireEvent.click(screen.getByLabelText(/New secret/i))
    fireEvent.change(screen.getByLabelText(/OpenAI API key/i), { target: { value: 'sk-openai' } })

    // Add a fallback and switch it to Bedrock (a different provider than the
    // primary), then type ONLY one of its two required keys.
    fireEvent.click(screen.getByRole('button', { name: /Fallback providers/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Add fallback provider' }))
    fireEvent.change(screen.getByLabelText('Provider', { selector: '#llm-fallback-0-provider' }), {
      target: { value: 'bedrock' },
    })
    fireEvent.change(screen.getByLabelText(/Amazon Bedrock access key ID/i), {
      target: { value: 'AKIA-half-pair' },
    })

    // While the Bedrock fallback is present, the half-pair correctly blocks.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()

    // Remove the fallback → its keys leave the active domain. The orphaned
    // half-pair must neither block save nor get written.
    fireEvent.click(screen.getByRole('button', { name: 'Remove fallback 1' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
    })

    // Walk to the final Access step and create.
    fireEvent.click(screen.getByRole('button', { name: 'Next' })) // → Access
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalledWith(
        'POST',
        '/api/v1/admin/secrets',
        expect.objectContaining({ stringData: { 'openai-api-key': 'sk-openai' } })
      )
    })
    const secretCall = vi
      .mocked(api.apiSend)
      .mock.calls.find(call => call[0] === 'POST' && call[1] === '/api/v1/admin/secrets')
    const stringData = (secretCall![2] as { stringData: Record<string, string> }).stringData
    expect(stringData['aws-access-key-id']).toBeUndefined()
    expect(stringData['aws-secret-access-key']).toBeUndefined()
  })
})

describe('HostWizard — Context creation', () => {
  it('titles the existing context selector and shows attached MCP servers as chips', async () => {
    vi.mocked(api.apiGet)
      .mockResolvedValueOnce(
        buildContextList([
          buildContextResource({
            metadata: { name: 'business', namespace: 'mcp-host' },
            spec: { mcpServers: ['mcp-a', 'mcp-b'] },
          }),
        ])
      )
      .mockResolvedValueOnce({ items: [] })
    await renderWizard()

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), {
      target: { value: 'existing-context-agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    const title = screen.getByText('Select Context', { selector: 'strong' })
    const selector = screen.getByRole('button', { name: /Select context/i })
    expect(title.compareDocumentPosition(selector)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    fireEvent.click(selector)
    fireEvent.click(screen.getByRole('option', { name: 'business' }))
    const summary = screen.getByRole('region', { name: 'Attached MCP servers' })
    expect(summary).toHaveTextContent('MCP servers')
    expect(summary).toHaveTextContent('2')
    expect(summary.querySelectorAll('li')).toHaveLength(2)
    expect(summary).toHaveTextContent('mcp-a')
    expect(summary).toHaveTextContent('mcp-b')
  })

  it('allows a new context with only a name and no MCP servers selected', async () => {
    await renderWizard()

    await waitFor(() => {
      expect(api.getAdminUsers).toHaveBeenCalled()
    })

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), {
      target: { value: 'context-only-agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), {
      target: { value: 'empty-context' },
    })

    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
    expect(screen.queryByText(/Select at least one MCP server/i)).not.toBeInTheDocument()
  })
})

describe("HostWizard — 'Access' empty state", () => {
  it('shows the empty-access note when no users and no teams are selected', async () => {
    await renderWizard()
    await walkToAccessStep()

    expect(screen.getByTestId('wizard-empty-access-warning')).toBeInTheDocument()
    expect(screen.getByText(/grant access later/i)).toBeInTheDocument()
  })

  it('hides the empty-access note once a user is selected', async () => {
    await renderWizard()
    await walkToAccessStep()

    expect(screen.getByTestId('wizard-empty-access-warning')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/alice/i))

    expect(screen.queryByTestId('wizard-empty-access-warning')).not.toBeInTheDocument()
  })

  it('hides the empty-access note once a team is selected', async () => {
    await renderWizard()
    await walkToAccessStep()

    expect(screen.getByTestId('wizard-empty-access-warning')).toBeInTheDocument()

    openTeamsAccessTab()
    fireEvent.click(screen.getByLabelText(/engineering/i))

    expect(screen.queryByTestId('wizard-empty-access-warning')).not.toBeInTheDocument()
  })
})

describe('HostWizard — Access is the final step', () => {
  it("keeps 'Create Agent' enabled when selection is empty", async () => {
    await renderWizard()
    await walkToAccessStep()

    expect(screen.queryByText('Channels')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create Agent/i })).not.toBeDisabled()
  })

  it("keeps 'Create Agent' enabled when a user is selected", async () => {
    await renderWizard()
    await walkToAccessStep()

    fireEvent.click(screen.getByLabelText(/alice/i))

    expect(screen.getByRole('button', { name: /Create Agent/i })).not.toBeDisabled()
  })
})

describe('HostWizard — submit path uses the atomic agent-centric endpoints', () => {
  it('creates an agent without access grants when no users or teams are selected', async () => {
    await renderWizard()
    await walkToAccessStep({ agentName: 'empty-access-test' })

    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    await waitFor(() => {
      expect(screen.queryByText(/Failed to create agent resources/i)).not.toBeInTheDocument()
      expect(api.apiSend).toHaveBeenCalledWith(
        'PUT',
        '/api/v1/admin/hosts/empty-access-test',
        expect.objectContaining({ spec: expect.objectContaining({ channels: [] }) })
      )
    })

    expect(vi.mocked(api.updateAgentUsers)).not.toHaveBeenCalled()
    expect(vi.mocked(api.updateAgentTeams)).not.toHaveBeenCalled()
    expect(
      vi
        .mocked(api.apiSend)
        .mock.calls.some(call => String(call[1]).includes('/communication-channels'))
    ).toBe(false)
  })

  it('calls updateAgentUsers exactly ONCE when selecting multiple users (not N times as the old loop did)', async () => {
    await renderWizard()
    await walkToAccessStep({ agentName: 'atomic-test' })

    // Select BOTH users
    fireEvent.click(screen.getByLabelText(/alice/i))
    fireEvent.click(screen.getByLabelText(/bob/i))

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    // Wait for the submit pipeline to reach the agent-user association step
    await waitFor(() => {
      expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalled()
    })

    // CRITICAL: exactly one call, with both userIds in a single request.
    // The old implementation would have called updateAdminUserAgents twice
    // (once per user), plus 2 getAdminUserAgents reads = 4 requests.
    expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalledWith('atomic-test', [
      'user-a',
      'user-b',
    ])
  })

  it('calls updateAgentTeams exactly ONCE when a team is selected', async () => {
    await renderWizard()
    await walkToAccessStep({ agentName: 'team-test' })

    openTeamsAccessTab()
    fireEvent.click(screen.getByLabelText(/engineering/i))
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    await waitFor(() => {
      expect(vi.mocked(api.updateAgentTeams)).toHaveBeenCalled()
    })

    expect(vi.mocked(api.updateAgentTeams)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.updateAgentTeams)).toHaveBeenCalledWith('team-test', ['team-1'])
  })

  it('calls both updateAgentUsers and updateAgentTeams when both are selected', async () => {
    await renderWizard()
    await walkToAccessStep({ agentName: 'both-test' })

    fireEvent.click(screen.getByLabelText(/alice/i))
    openTeamsAccessTab()
    fireEvent.click(screen.getByLabelText(/engineering/i))
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    await waitFor(() => {
      expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalled()
      expect(vi.mocked(api.updateAgentTeams)).toHaveBeenCalled()
    })

    expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.updateAgentTeams)).toHaveBeenCalledTimes(1)
  })
})

describe('HostWizard — loadDirectory error surfacing (no more silent catch)', () => {
  it('displays a visible error banner when getAdminUsers fails at mount', async () => {
    vi.mocked(api.getAdminUsers).mockRejectedValueOnce(new Error('network timeout'))

    await renderWizard()

    // Wait for the error to surface
    await waitFor(() => {
      expect(screen.getByText(/Failed to load users\/teams\/contexts/i)).toBeInTheDocument()
    })
  })

  it('does NOT silently swallow loadDirectory errors (regression guard for the old behavior)', async () => {
    // The old implementation had `catch { /* keep creation flow functional */ }`
    // which caused admins to see an empty Access step with no indication of why.
    // This test asserts the new behavior: errors MUST be visible.
    vi.mocked(api.getAdminTeams).mockRejectedValueOnce(new Error('500 internal'))
    await renderWizard()

    await waitFor(() => {
      // The error banner contains the wrapped message
      expect(screen.getByText(/Failed to load users\/teams\/contexts/i)).toBeInTheDocument()
    })
  })
})

describe('HostWizard — baseline render', () => {
  it('renders the Create Agent modal title', async () => {
    await renderWizard()
    expect(screen.getByText(/Create Agent/i)).toBeInTheDocument()
  })

  it('starts on Step 0 (Agent metadata name)', async () => {
    await renderWizard()
    expect(screen.getByPlaceholderText(/agent-name/i)).toBeInTheDocument()
  })

  it('shows Default model without Allowed models in Model & Credentials', async () => {
    await renderWizard()

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), {
      target: { value: 'default-model-agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), {
      target: { value: 'ctx1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(
      screen.getByLabelText('Default model', { selector: '#llm-primary-model' })
    ).toBeInTheDocument()
    expect(screen.queryByText(/Allowed models/)).not.toBeInTheDocument()
  })
})

describe('HostWizard — Agent type (stateless lifecycle)', () => {
  it('hides the Agent type selector from the create flow', async () => {
    await renderWizard()

    expect(screen.queryByText('Agent type')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /Stateful \(always on\)/i })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('radio', { name: /Stateless \(suspends when idle\)/i })
    ).not.toBeInTheDocument()
  })

  it('omits spec.lifecycle from the created Host when Stateful is kept (absent = disabled)', async () => {
    await renderWizard()
    await walkToAccessStep({ agentName: 'stateful-agent' })
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalledWith(
        'PUT',
        '/api/v1/admin/hosts/stateful-agent',
        expect.any(Object)
      )
    })
    const hostCall = vi
      .mocked(api.apiSend)
      .mock.calls.find(call => call[1] === '/api/v1/admin/hosts/stateful-agent')
    expect(hostCall).toBeDefined()
    const payload = hostCall![2] as { spec: Record<string, unknown> }
    expect('lifecycle' in payload.spec).toBe(false)
    expect('workflowControl' in payload.spec).toBe(false)
  })
})
