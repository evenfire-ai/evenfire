import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { HostWizard } from '../HostWizard'
import { ToastProvider } from '../Toast'

/**
 * Regression guard for R5-H1: the step-0 gate validates the DERIVED slug
 * (toKebabCase), but toKebabCase STRIPS control/bidi characters and truncates
 * nothing about the free-text display value. So a name like "agent‮name"
 * (a Right-to-Left-Override bidi char) derives a clean, valid slug ("agentname")
 * that sails through the slug gate — yet the RAW display value the server stores
 * as spec.host is rejected (422). Because the secret/context are created BEFORE
 * the host in submitAll, that late rejection orphans the siblings.
 *
 * The fix validates the free-text spec.host display value with the shared
 * @clerum/display-field rule (the SAME rule the server applies), both in the
 * step-0 gate (live feedback) and as a hard check at the top of submitAll
 * (defense in depth) BEFORE any write.
 *
 * These tests FAIL against the pre-fix head, where nothing validated the raw
 * display value: the bidi name enabled Next and the whole wizard reached Create,
 * POSTing the secret before the host create failed.
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

// A Right-to-Left-Override (U+202E) bidi character: the canonical Trojan-Source
// vector. toKebabCase strips it, so the derived slug is clean ("agentname").
const BIDI_NAME = 'agent‮name'

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

// Drive the wizard from step 0 toward the final Create/Skip action, filling the
// minimal valid values each step needs. Pre-fix, a bidi name slips past step 0
// and this reaches "Skip channel setup" (which submits). Post-fix, the step-0
// gate keeps Next disabled and this bails harmlessly on the first iteration —
// so it never throws on absent later-step controls in either version.
async function driveTowardCreate() {
  for (let i = 0; i < 10; i += 1) {
    // Last step: submit via "Skip channel setup" so channel fields aren't needed.
    const skipBtn = screen.queryByRole('button', { name: /Skip channel setup/i })
    if (skipBtn) {
      fireEvent.click(skipBtn)
      return
    }

    // Step 1: pick a new context with a valid name so its gate can pass.
    const newCtx = screen.queryByLabelText(/Create new context/i) as HTMLInputElement | null
    if (newCtx) {
      if (!newCtx.checked) fireEvent.click(newCtx)
      const ctxInput = screen.queryByPlaceholderText(/context-name/i) as HTMLInputElement | null
      if (ctxInput && !ctxInput.value) fireEvent.change(ctxInput, { target: { value: 'ctx1' } })
    }

    // Step 2: make the OpenAI primary usable, then wait for the model to seed
    // (async, once the allowlist loads) so Next isn't transiently disabled.
    const openAiKey = screen.queryByLabelText(/OpenAI API key/i) as HTMLInputElement | null
    if (openAiKey && !openAiKey.value) {
      fireEvent.change(openAiKey, { target: { value: 'sk-openai' } })
      await waitFor(() => {
        const n = screen.queryByRole('button', { name: 'Next' }) as HTMLButtonElement | null
        expect(Boolean(n && !n.disabled)).toBe(true)
      })
    }

    const nextBtn = screen.queryByRole('button', { name: 'Next' }) as HTMLButtonElement | null
    if (!nextBtn || nextBtn.disabled) return
    fireEvent.click(nextBtn)
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HostWizard — step 0 gates the free-text spec.host display value (R5-H1)', () => {
  it('INV-1: keeps Next DISABLED for a name whose slug is valid but display carries a bidi char', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: BIDI_NAME } })

    // The derived slug is clean and valid, so the slug/identifier hint reports no
    // error — only the display-value gate blocks.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByText(/control or formatting characters/i)).toBeInTheDocument()
  })

  it('INV-1 baseline: enables Next for an ordinary display name', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: 'My Agent' } })

    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
    expect(screen.queryByText(/control or formatting characters/i)).not.toBeInTheDocument()
  })

  it('INV-3: keeps Next DISABLED when the display value exceeds the max length but the slug is valid', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    // "ab" + 130 dots: toKebabCase strips the dots → slug "ab" (valid, ≤63),
    // but the raw display value is 132 chars — over the 120 display max the
    // server enforces. The slug gate alone would let this through.
    const longDisplay = `ab${'.'.repeat(130)}`
    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: longDisplay } })

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByText(/too long \(max 120 characters\)/i)).toBeInTheDocument()
  })
})

describe('HostWizard — an invalid display value never reaches the server as a side-effect (R5-H1)', () => {
  it('INV-2: fires NO create apiSend when the display value is invalid (bidi char)', async () => {
    await renderWizard()
    await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: BIDI_NAME } })

    // Pre-fix: the bidi name slips through, the flow reaches Create, and the
    // secret is POSTed before the host create fails — apiSend IS called (bug).
    // Post-fix: the step-0 gate blocks before any step advances.
    await driveTowardCreate()
    await act(async () => {
      await Promise.resolve()
    })

    // The observable invariant (T4): no create request escaped for an invalid
    // display value, so no orphaned sibling can exist.
    expect(api.apiSend).not.toHaveBeenCalled()
    // And the operator sees why.
    expect(screen.getByText(/control or formatting characters/i)).toBeInTheDocument()
  })
})
