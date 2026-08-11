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

/**
 * Regression guard for R4-H1: the step-0 gate must mirror the SERVER validation
 * (RFC1123 DNS-label ≤63 chars), not just "derives a non-empty slug". A 64-char
 * name derives a valid-but-too-long slug that passes `toKebabCase(x).length > 0`
 * yet is rejected server-side (`invalid_name`), orphaning the siblings created
 * before the host. FAILS against the pre-fix head where the gate was
 * `toKebabCase(state.hostName).length > 0`.
 */
describe('HostWizard — step 0 gates on the RFC1123 length limit (R4-H1)', () => {
  it('keeps Next DISABLED when the derived slug exceeds 63 characters', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), {
      target: { value: 'a'.repeat(64) },
    })

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getAllByText(/at most 63 characters/i).length).toBeGreaterThan(0)
  })

  it('enables Next for a 63-character derived slug (boundary)', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), {
      target: { value: 'a'.repeat(63) },
    })

    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
  })
})

/**
 * Regression guard for R4-B1: create is a PUT-first upsert, so a slug that
 * collides with an existing host would silently OVERWRITE that agent's spec and
 * report "created". The step-0 gate must block a colliding derived slug BEFORE
 * any sibling (secret/context/channel) is created — no create request escapes.
 * FAILS against the pre-fix head, which never loaded the host directory.
 */
describe('HostWizard — step 0 blocks a slug colliding with an existing host (R4-B1)', () => {
  it('keeps Next DISABLED and fires no create request when the slug matches an existing host', async () => {
    ;(api.apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === '/api/v1/admin/hosts') {
        return Promise.resolve({ items: [{ metadata: { name: 'my-agent' } }] })
      }
      return Promise.resolve({ items: [] })
    })

    await renderWizard()
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledWith('/api/v1/admin/hosts'))

    // "My Agent" derives to the slug "my-agent", which already exists.
    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'My Agent' } })

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByText(/Identifier already in use/i)).toBeInTheDocument()
    // No create request (POST/PUT via apiSend) escapes for a colliding slug.
    expect(api.apiSend).not.toHaveBeenCalled()

    // Restore the default apiGet stub so no implementation leaks past this test.
    ;(api.apiGet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] })
  })
})
