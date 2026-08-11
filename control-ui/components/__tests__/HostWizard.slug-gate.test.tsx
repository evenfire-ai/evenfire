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

/**
 * Regression guard for R4-M5: the step-2 SECRET gate must mirror the SERVER,
 * which validates a K8s Secret name as an RFC1123 DNS SUBDOMAIN (≤253 chars,
 * `isValidDNSSubdomain`), NOT the stricter ≤63 DNS label used for
 * host/context/channel names. R4-H1's fix wrongly applied the ≤63-label
 * validator (`isValidResourceSlug`) to the secret, making the client STRICTER
 * than the server: a 60-char host name auto-derives a `${slug}-llm` secret of 64
 * chars, which the server accepts (≤253) but the ≤63 gate blocked — freezing
 * step 2 before the user ever touched the secret field.
 *
 * FAILS against the R4-H1 head (11d5beee), where the secret gate read
 * `isValidResourceSlug(state.newSecretName)` / `slugConstraintMessage`.
 */
describe('HostWizard — step 2 secret gate mirrors the server DNS-subdomain limit (R4-M5)', () => {
  it('enables Next on a 64-char derived secret name the server (≤253) accepts', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    // 60-char host name → 60-char slug (valid ≤63). The auto-derived secret
    // default is `${slug}-llm` = 64 chars, a valid DNS subdomain the server
    // accepts. The operator never touches the secret field.
    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), {
      target: { value: 'a'.repeat(60) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Step 1: a new context with just a valid name, advance to step 2.
    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: 'ctx1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Step 2: fill the primary OpenAI key so the ONLY thing that could still
    // block Next is the secret name length. Post-fix (subdomain ≤253), the
    // 64-char default is valid → Next enabled and no length error shown.
    fireEvent.change(screen.getByLabelText(/OpenAI API key/i), { target: { value: 'sk-openai' } })

    expect(screen.queryByText(/at most 63 characters/i)).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled())
  })

  it('still blocks a secret name longer than 253 characters', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'agent-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    fireEvent.click(screen.getByLabelText(/Create new context/i))
    fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: 'ctx1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Step 2: make the primary credential valid so the secret length is the
    // sole blocker, then overtype the secret with a 254-char name (> subdomain
    // max). The gate must still block — the fix loosens the ceiling, not removes
    // it.
    fireEvent.change(screen.getByLabelText(/OpenAI API key/i), { target: { value: 'sk-openai' } })
    fireEvent.change(screen.getByPlaceholderText(/secret-name/i), {
      target: { value: 'a'.repeat(254) },
    })

    expect(screen.getByText(/at most 253 characters/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })
})

/**
 * Regression guard for R4-M6: R4-B1's fix added GET /admin/hosts INTO the same
 * `Promise.all` as users/teams/contexts/channels. `Promise.all` rejects if ANY
 * input rejects, so a 403/timeout/500 on the hosts fetch discarded every other
 * selector and dropped the wizard into `directoryLoadError` — even though hosts
 * only feeds a best-effort collision guard. The hosts fetch must be isolated so
 * its failure leaves the rest of the directory loaded and `existingHostNames`
 * empty (collision guard degrades fail-open, the pre-fix behavior).
 *
 * FAILS against the R4-B1 head (11d5beee), where the hosts fetch sat unguarded
 * inside the `Promise.all`.
 */
describe('HostWizard — a failed GET /admin/hosts does not sink the directory load (R4-M6)', () => {
  it('loads the wizard and degrades the collision guard fail-open when hosts fetch rejects', async () => {
    ;(api.apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === '/api/v1/admin/hosts') {
        return Promise.reject(new Error('403 forbidden'))
      }
      return Promise.resolve({ items: [] })
    })

    await renderWizard()
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledWith('/api/v1/admin/hosts'))

    // The whole directory load did NOT fail: no error banner from Promise.all.
    expect(screen.queryByText(/Failed to load users\/teams\/contexts/i)).not.toBeInTheDocument()

    // Collision guard degraded fail-open: existingHostNames is empty, so a name
    // that would collide had the directory loaded is NOT blocked, and no
    // "already in use" message appears.
    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'My Agent' } })
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
    expect(screen.queryByText(/Identifier already in use/i)).not.toBeInTheDocument()

    // Restore the default apiGet stub so no implementation leaks past this test.
    ;(api.apiGet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] })
  })
})
