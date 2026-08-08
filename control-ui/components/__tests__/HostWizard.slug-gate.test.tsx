import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { HostWizard } from '../HostWizard'
import { ToastProvider } from '../Toast'

/**
 * Regression guard for R1-B1 (and its class sibling in step 1): the step gates
 * must validate the DERIVED slug (toKebabCase), not the raw trimmed text. A name
 * with no ASCII alphanumerics ("!!!", whitespace, "---") trims to a non-empty
 * string but toKebabCase()s to "" — which would send metadata.name: "" and, since
 * the secret/context are POSTed BEFORE the host create in submit(), orphan those
 * siblings when the host create fails.
 *
 * These tests FAIL against the pre-fix head (c3ac3e40), where the gates read
 * `state.hostName.trim().length > 0` / `state.contextName.trim().length > 0`.
 */

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn().mockResolvedValue({ items: [] }),
  apiSend: vi.fn().mockResolvedValue({}),
  getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
  getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
  updateAgentUsers: vi.fn().mockResolvedValue({ agentName: '', userIds: [] }),
  updateAgentTeams: vi.fn().mockResolvedValue({ agentName: '', teamIds: [] }),
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

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

async function renderWizard() {
  const onCreated = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const utils = render(
    <ToastProvider>
      <HostWizard
        mcpServers={[{ metadata: { name: 'mcp-a' } }]}
        existingSecrets={[{ name: 'secret-a' }]}
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HostWizard — step 0 gates on the derived slug (R1-B1)', () => {
  it('keeps Next DISABLED when the agent name has no alphanumerics', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: '!!!' } })

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByText(/Agent name must contain letters or numbers/i)).toBeInTheDocument()
  })

  it('keeps Next DISABLED for a whitespace-only name', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: '   ' } })

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('enables Next for a name that derives a valid identifier', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'My Agent' } })

    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
  })
})

describe('HostWizard — step 1 new-context gate on the derived slug (R1-B1 sibling)', () => {
  it('keeps Next DISABLED when the new context name has no alphanumerics', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    // Step 0: valid name, advance.
    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'agent-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Step 1: new context with a symbols-only name.
    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: '!!!' } })

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByText(/Context name must contain letters or numbers/i)).toBeInTheDocument()
  })

  it('enables Next when the new context name derives a valid identifier', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'agent-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: 'My Ctx' } })

    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
  })
})
