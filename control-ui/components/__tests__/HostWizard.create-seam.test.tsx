import React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { HostWizard } from '../HostWizard'
import { ToastProvider } from '../Toast'

/**
 * Fase 3 — HostWizard create seam moves from "create-as-upsert (PUT-first)" to
 * "create-only (POST) + inverse compensation" (closes R5-C1 upsert overwrites a
 * foreign context/channel/host, and R5-B1 no real server-side create control).
 *
 * These invariants assert the OBSERVABLE apiSend traffic (T4) — the POST/PUT/
 * DELETE calls — never internal effects:
 *
 *  - INV-A  a successful create is POST-only (no PUT to hosts/contexts/channels).
 *  - INV-B  a Host name collision (409, no body code) shows "already in use",
 *           overwrites nothing (no PUT), and rolls back the created siblings.
 *  - INV-C  for every failure boundary before the Host (context POST, channel
 *           POST, host POST), the siblings created BEFORE it are DELETEd by name
 *           and no orphan survives.
 *  - INV-D  a grant failure AFTER the Host exists compensates nothing (V-7).
 *  - INV-E  a `mode=existing` channel is edited via PUT and is NEVER tracked, so
 *           a later failure does not delete that foreign channel.
 *
 * INV-A/B/C FAIL against the pre-fix head, where create was a PUT-first upsert:
 * the PUT to hosts/contexts fired (INV-A), a colliding PUT silently "succeeded"
 * so no error/rollback surfaced (INV-B), and a rejected POST never ran because
 * the PUT resolved first, so no sibling DELETE occurred (INV-C).
 */

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn().mockResolvedValue({ items: [] }),
  apiSend: vi.fn().mockResolvedValue({}),
  getAdminUsers: vi.fn().mockResolvedValue({
    items: [{ id: 'user-a', email: 'alice@example.com', name: 'Alice', displayName: null }],
  }),
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

type ApiSendMock = ReturnType<typeof vi.fn>

// T1 (derive fixtures from the real producer): the error shape createOrThrow /
// the submitAll catch discriminate on (`.status`, `.body`, `.code`, `.message`)
// is produced by lib/api's formatApiError. We build every rejection by calling
// the REAL formatApiError (via importActual, bypassing the module mock) against
// a synthetic 4xx Response — so if formatApiError's shape ever drifts, these
// tests break instead of quietly certifying a stale hand-built shape.
let formatApiError!: (typeof import('../../lib/api'))['formatApiError']
beforeAll(async () => {
  ;({ formatApiError } = await vi.importActual<typeof import('../../lib/api')>('../../lib/api'))
})

/** A real formatApiError-derived Error for an HTTP status + JSON body. */
function makeApiError(status: number, body: Record<string, unknown>): Error {
  const text = JSON.stringify(body)
  const statusText = status === 409 ? 'Conflict' : 'Internal Server Error'
  return formatApiError(new Response(text, { status, statusText }), text)
}

/** apiSend calls to a specific method — `[method, url, body]` tuples. */
function callsFor(method: 'POST' | 'PUT' | 'DELETE'): unknown[][] {
  return (api.apiSend as unknown as ApiSendMock).mock.calls.filter(call => call[0] === method)
}

function urlsFor(method: 'POST' | 'PUT' | 'DELETE'): string[] {
  return callsFor(method).map(call => String(call[1]))
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

/**
 * Fill steps 0→3 with a NEW context + NEW (auto-named) secret and land on the
 * Channels step. Leaves the Access selection empty unless `selectUser` is set.
 * The auto-derived secret name is `${agentName}-llm`.
 */
async function fillToChannels(agentName: string, opts: { selectUser?: boolean } = {}) {
  await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalled())

  // Step 0: agent name.
  fireEvent.change(screen.getByPlaceholderText(/agent-name/i), { target: { value: agentName } })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  // Step 1: a new context named "ctx-a".
  fireEvent.click(screen.getByLabelText(/Create new context/i))
  fireEvent.change(screen.getByPlaceholderText(/context-name/i), { target: { value: 'ctx-a' } })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  // Step 2: default "new secret" (auto-named) + a usable OpenAI primary key.
  fireEvent.change(screen.getByLabelText(/OpenAI API key/i), { target: { value: 'sk-openai' } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  // Step 3: Access.
  if (opts.selectUser) {
    fireEvent.click(screen.getByLabelText(/alice/i))
  }
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  // Now on Step 4: Channels.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Skip channel setup/i })).toBeInTheDocument()
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // Restore the default resolved stubs so a per-test implementation never leaks.
  ;(api.apiSend as unknown as ApiSendMock).mockResolvedValue({})
  ;(api.apiGet as unknown as ApiSendMock).mockResolvedValue({ items: [] })
})

describe('HostWizard create seam — INV-A: a successful create is POST-only', () => {
  it('POSTs secret/context/host and never PUTs any of them (R5-C1/R5-B1)', async () => {
    await renderWizard()
    await fillToChannels('agent-a')

    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalledWith(
        'POST',
        '/api/v1/admin/hosts',
        expect.objectContaining({ metadata: { name: 'agent-a' } })
      )
    })

    // Create-only: the three resources are POSTed to their collections.
    const posted = urlsFor('POST')
    expect(posted).toContain('/api/v1/admin/secrets')
    expect(posted).toContain('/api/v1/admin/contexts')
    expect(posted).toContain('/api/v1/admin/hosts')

    // Nothing was upsert-overwritten: no PUT fired at all in the skip-channels
    // path (the only surviving PUT is the mode=existing channel edit, unused).
    expect(callsFor('PUT')).toHaveLength(0)
    // No rollback on the happy path.
    expect(callsFor('DELETE')).toHaveLength(0)
  })
})

describe('HostWizard create seam — INV-B: Host name collision (409) does not overwrite', () => {
  it('shows "already in use", fires no PUT, and rolls back the created siblings', async () => {
    ;(api.apiSend as unknown as ApiSendMock).mockImplementation(
      async (method: string, url: string) => {
        if (method === 'POST' && url === '/api/v1/admin/hosts') {
          // apiserver AlreadyExists: 409 with a message body but NO machine code.
          throw makeApiError(409, { error: 'hosts.clerum.io "agent-b" already exists' })
        }
        return {}
      }
    )

    await renderWizard()
    await fillToChannels('agent-b')
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    // The operator sees the collision message, mapped from the code-less 409.
    await waitFor(() => {
      expect(screen.getByText(/already in use/i)).toBeInTheDocument()
    })

    // Nothing was overwritten: no PUT anywhere.
    expect(callsFor('PUT')).toHaveLength(0)

    // The siblings created before the Host are rolled back (inverse order).
    const deleted = urlsFor('DELETE')
    expect(deleted).toContain('/api/v1/admin/contexts/ctx-a')
    expect(deleted).toContain('/api/v1/admin/secrets/agent-b-llm')
  })
})

describe('HostWizard create seam — INV-C: zero orphans at every failure boundary', () => {
  it('context POST fails → the already-created secret is DELETEd; the host is never POSTed', async () => {
    ;(api.apiSend as unknown as ApiSendMock).mockImplementation(
      async (method: string, url: string) => {
        if (method === 'POST' && url === '/api/v1/admin/contexts') {
          throw makeApiError(500, { error: 'internal' })
        }
        return {}
      }
    )

    await renderWizard()
    await fillToChannels('agent-c1')
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    await waitFor(() => {
      expect(urlsFor('DELETE')).toContain('/api/v1/admin/secrets/agent-c1-llm')
    })
    // The context POST failed, so it was never tracked → never DELETEd.
    expect(urlsFor('DELETE')).not.toContain('/api/v1/admin/contexts/ctx-a')
    // The host was never reached, so no orphaned spec.host exists.
    expect(urlsFor('POST')).not.toContain('/api/v1/admin/hosts')
  })

  it('channel POST fails → the created context and secret are both DELETEd; the host is never POSTed', async () => {
    ;(api.apiSend as unknown as ApiSendMock).mockImplementation(
      async (method: string, url: string) => {
        if (method === 'POST' && url === '/api/v1/admin/communication-channels') {
          throw makeApiError(500, { error: 'internal' })
        }
        return {}
      }
    )

    await renderWizard()
    await fillToChannels('agent-c2')

    // Configure a NEW telegram channel so a channel POST is attempted.
    fireEvent.click(screen.getByLabelText(/Create new channel/i))
    fireEvent.change(screen.getByPlaceholderText(/^channel-name$/i), {
      target: { value: 'chan-a' },
    })
    fireEvent.change(screen.getByPlaceholderText(/@your_bot/i), {
      target: { value: '@clerum_test_bot' },
    })
    fireEvent.change(screen.getByLabelText(/Telegram Bot Token/i), { target: { value: '123:ABC' } })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create Agent/i })).not.toBeDisabled()
    )
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    await waitFor(() => {
      expect(urlsFor('DELETE')).toContain('/api/v1/admin/contexts/ctx-a')
    })
    expect(urlsFor('DELETE')).toContain('/api/v1/admin/secrets/agent-c2-llm')
    // The failed channel was never tracked → never DELETEd.
    expect(urlsFor('DELETE')).not.toContain('/api/v1/admin/communication-channels/chan-a')
    // The host was never reached.
    expect(urlsFor('POST')).not.toContain('/api/v1/admin/hosts')
  })

  it('host POST fails → the created context and secret are both DELETEd', async () => {
    ;(api.apiSend as unknown as ApiSendMock).mockImplementation(
      async (method: string, url: string) => {
        if (method === 'POST' && url === '/api/v1/admin/hosts') {
          throw makeApiError(500, { error: 'internal' })
        }
        return {}
      }
    )

    await renderWizard()
    await fillToChannels('agent-c3')
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    await waitFor(() => {
      expect(urlsFor('DELETE')).toContain('/api/v1/admin/contexts/ctx-a')
    })
    expect(urlsFor('DELETE')).toContain('/api/v1/admin/secrets/agent-c3-llm')
  })
})

describe('HostWizard create seam — INV-D: a grant failure after the Host does NOT revert (V-7)', () => {
  it('leaves the Host + siblings and fires no DELETE when updateAgentUsers rejects', async () => {
    vi.mocked(api.updateAgentUsers).mockRejectedValueOnce(new Error('grant failed'))

    await renderWizard()
    await fillToChannels('agent-d', { selectUser: true })
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    // The Host was created, then the grant failed.
    await waitFor(() => {
      expect(urlsFor('POST')).toContain('/api/v1/admin/hosts')
      expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByText(/grant failed/i)).toBeInTheDocument()
    })

    // Nothing rolled back: the Host + siblings stay for a grant retry from detail.
    expect(callsFor('DELETE')).toHaveLength(0)
  })
})

describe('HostWizard create seam — INV-E: a mode=existing channel is edited, never tracked', () => {
  it('PUTs the selected channel and never DELETEs it, even when a later create fails', async () => {
    ;(api.apiGet as unknown as ApiSendMock).mockImplementation(async (path: string) => {
      if (path === '/api/v1/admin/communication-channels') {
        return {
          items: [{ metadata: { name: 'existing-chan', namespace: 'default' }, spec: {} }],
        }
      }
      return { items: [] }
    })
    ;(api.apiSend as unknown as ApiSendMock).mockImplementation(
      async (method: string, url: string) => {
        if (method === 'POST' && url === '/api/v1/admin/hosts') {
          throw makeApiError(500, { error: 'internal' })
        }
        return {}
      }
    )

    await renderWizard()
    await fillToChannels('agent-e')

    // channelMode defaults to "existing": open the dropdown and pick the channel.
    fireEvent.click(screen.getByRole('button', { name: /Select channel/i }))
    fireEvent.click(screen.getByRole('option', { name: /existing-chan/i }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create Agent/i })).not.toBeDisabled()
    )
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }))

    // The existing channel is edited via PUT (attach host + access).
    await waitFor(() => {
      expect(urlsFor('PUT')).toContain('/api/v1/admin/communication-channels/existing-chan')
    })

    // The host POST failed → the tracked siblings roll back...
    await waitFor(() => {
      expect(urlsFor('DELETE')).toContain('/api/v1/admin/contexts/ctx-a')
    })
    expect(urlsFor('DELETE')).toContain('/api/v1/admin/secrets/agent-e-llm')
    // ...but the foreign channel we only EDITED is never deleted.
    expect(urlsFor('DELETE')).not.toContain('/api/v1/admin/communication-channels/existing-chan')
  })
})

describe('HostWizard create seam — INV-F: a post-Host grant 409 is NOT masked as a name collision', () => {
  it('surfaces the grant history-limit message (not "already in use") and rolls back nothing', async () => {
    // The Host is created OK; then the grant call rejects with the exact 409 the
    // server sends (agentGrants.ts): { error: 'deleted_agent_history_limit_exceeded' }.
    // formatApiError already remaps that code to an actionable message. The prior
    // top-level 409 remap clobbered it with "already in use" (the HIGH regression):
    // a false collision for an agent that WAS created (no rollback) → the operator
    // recreates → duplicate agent. Derived from the real producer (T1).
    vi.mocked(api.updateAgentUsers).mockRejectedValueOnce(
      makeApiError(409, { error: 'deleted_agent_history_limit_exceeded', deletedHistoryLimit: 5 })
    )

    await renderWizard()
    await fillToChannels('agent-f', { selectUser: true })
    fireEvent.click(screen.getByRole('button', { name: /Skip channel setup/i }))

    // The Host was created (POST hosts) and the grant was attempted.
    await waitFor(() => {
      expect(urlsFor('POST')).toContain('/api/v1/admin/hosts')
      expect(vi.mocked(api.updateAgentUsers)).toHaveBeenCalled()
    })

    // The operator sees the history-limit message formatApiError produced...
    await waitFor(() => {
      expect(screen.getByText(/deleted-agent history limit was reached/i)).toBeInTheDocument()
    })
    // ...NOT a spurious collision message.
    expect(screen.queryByText(/already in use/i)).not.toBeInTheDocument()

    // V-7: the Host + siblings stay — a grant retry lives on the agent detail page.
    expect(callsFor('DELETE')).toHaveLength(0)
  })
})
