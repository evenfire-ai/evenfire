import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
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
  existingSecrets?: Array<{ name?: string }>
}) {
  const onCreated = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const utils = render(
    <ToastProvider>
      <HostWizard
        mcpServers={props?.mcpServers ?? [{ metadata: { name: 'mcp-a' } }]}
        existingSecrets={props?.existingSecrets ?? [{ name: 'secret-a' }]}
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
  fireEvent.click(screen.getByLabelText(/Reuse an existing Secret/i))
  fireEvent.click(screen.getByRole('button', { name: /Select secret/i }))
  fireEvent.click(screen.getByRole('option', { name: /secret-a/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  // Now at the "Access" step.
}

async function continueFromAccessToChannels() {
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByRole('button', { name: /Skip channel setup/i })).toBeInTheDocument()
}

function openTeamsAccessTab() {
  fireEvent.click(screen.getByRole('tab', { name: /Teams/i }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HostWizard — credential draft is projected onto the active provider domain', () => {
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

    // Step 2: default "new secret". Make the OpenAI primary usable.
    fireEvent.change(screen.getByLabelText(/OpenAI API key/i), { target: { value: 'sk-openai' } })

    // Add a fallback and switch it to Bedrock (a different provider than the
    // primary), then type ONLY one of its two required keys.
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

    // Walk to the last step and create.
    fireEvent.click(screen.getByRole('button', { name: 'Next' })) // → Access
    await continueFromAccessToChannels() // → Channels
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

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

describe('HostWizard — Access selection does not gate continuing', () => {
  it("keeps 'Next' enabled when selection is empty", async () => {
    await renderWizard()
    await walkToAccessStep()

    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).not.toBeDisabled()
  })

  it("enables 'Next' when a user is selected", async () => {
    await renderWizard()
    await walkToAccessStep()

    fireEvent.click(screen.getByLabelText(/alice/i))

    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).not.toBeDisabled()
  })
})

describe('HostWizard — submit path uses the atomic agent-centric endpoints', () => {
  it('creates an agent without access grants when no users or teams are selected', async () => {
    await renderWizard()
    await walkToAccessStep({ agentName: 'empty-access-test' })

    await continueFromAccessToChannels()
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    await waitFor(() => {
      expect(screen.queryByText(/Failed to create agent resources/i)).not.toBeInTheDocument()
      expect(api.apiSend).toHaveBeenCalledWith(
        'PUT',
        '/api/v1/admin/hosts/empty-access-test',
        expect.any(Object)
      )
    })

    expect(vi.mocked(api.updateAgentUsers)).not.toHaveBeenCalled()
    expect(vi.mocked(api.updateAgentTeams)).not.toHaveBeenCalled()
  })

  it('calls updateAgentUsers exactly ONCE when selecting multiple users (not N times as the old loop did)', async () => {
    await renderWizard()
    await walkToAccessStep({ agentName: 'atomic-test' })

    // Select BOTH users
    fireEvent.click(screen.getByLabelText(/alice/i))
    fireEvent.click(screen.getByLabelText(/bob/i))

    // Submit
    await continueFromAccessToChannels()
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

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
    await continueFromAccessToChannels()
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

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
    await continueFromAccessToChannels()
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    await waitFor(() => {
      expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalled()
      expect(vi.mocked(api.updateAgentTeams)).toHaveBeenCalled()
    })

    expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.updateAgentTeams)).toHaveBeenCalledTimes(1)
  })

  it('creates a new Telegram channel with provider settings and access grants', async () => {
    vi.mocked(api.apiSend).mockImplementation(async (method, url) => {
      if (
        method === 'PUT' &&
        String(url).includes('/api/v1/admin/communication-channels/new-telegram-channel')
      ) {
        throw new Error('not found')
      }
      return {}
    })

    await renderWizard()
    await walkToAccessStep({ agentName: 'agent-with-channel' })

    fireEvent.click(screen.getByLabelText(/alice/i))
    await continueFromAccessToChannels()
    fireEvent.click(screen.getByLabelText(/Create new channel/i))
    fireEvent.change(screen.getByPlaceholderText(/^channel-name$/i), {
      target: { value: 'new-telegram-channel' },
    })
    fireEvent.change(screen.getByPlaceholderText(/@your_bot/i), {
      target: { value: '@clerum_test_bot' },
    })
    fireEvent.change(screen.getByLabelText(/Telegram Bot Token/i), {
      target: { value: '123:ABC' },
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Agent/i })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalledWith(
        'POST',
        '/api/v1/admin/communication-channels',
        expect.objectContaining({
          metadata: { name: 'new-telegram-channel' },
          credentials: { 'telegram-bot-token': '123:ABC' },
          spec: expect.objectContaining({
            hostRef: 'agent-with-channel',
            access: { users: ['user-a'], teams: [] },
            telegram: [],
            slack: [],
            telegramSettings: {
              botHandle: '@clerum_test_bot',
              replyOnlyWhenMentioned: true,
            },
          }),
        })
      )
    })
    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalledWith(
        'PUT',
        '/api/v1/admin/hosts/agent-with-channel',
        expect.objectContaining({
          spec: expect.objectContaining({
            channels: ['new-telegram-channel'],
            workflowControl: {
              scopes: [
                'workflow:list',
                'workflow:read',
                'workflow:trigger',
                'workflow:approval:resolve',
                'workflow:approval:decide',
              ],
            },
          }),
        })
      )
    })
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
})

describe('HostWizard — Agent type (stateless lifecycle)', () => {
  it('renders the Agent type selector on step 0 with Stateful selected by default', async () => {
    await renderWizard()

    const stateful = screen.getByRole('radio', { name: /Stateful \(always on\)/i })
    const stateless = screen.getByRole('radio', { name: /Stateless \(suspends when idle\)/i })
    expect(stateful).toBeChecked()
    expect(stateless).not.toBeChecked()
    expect(
      screen.getByText(/communication channels keep stateless agents always-on/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/requires no active communication channels/i)).not.toBeInTheDocument()
  })

  it('omits spec.lifecycle from the created Host when Stateful is kept (absent = disabled)', async () => {
    await renderWizard()
    await walkToAccessStep({ agentName: 'stateful-agent' })
    await continueFromAccessToChannels()
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

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

  it('carries spec.lifecycle.stateless=true on the created Host when Stateless is selected', async () => {
    await renderWizard()

    fireEvent.click(screen.getByRole('radio', { name: /Stateless \(suspends when idle\)/i }))
    expect(screen.getByRole('radio', { name: /Stateless \(suspends when idle\)/i })).toBeChecked()

    await walkToAccessStep({ agentName: 'stateless-agent' })
    await continueFromAccessToChannels()
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalledWith(
        'PUT',
        '/api/v1/admin/hosts/stateless-agent',
        expect.objectContaining({
          spec: expect.objectContaining({ lifecycle: { stateless: true } }),
        })
      )
    })
  })
})
