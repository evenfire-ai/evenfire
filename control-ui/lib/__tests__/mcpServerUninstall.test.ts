import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MCP_SERVER_PENDING_BODY,
  OAUTH_PENDING_BODY,
  SECRETS_PENDING_BODY,
  uninstallIncompleteResponse,
} from '../../test/fixtures/mcpServerUninstall'
import { McpServerUninstallIncompleteError, deleteMcpServer } from '../api'

function jsonResponse(body: unknown, status: number, statusText: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deleteMcpServer incomplete uninstall', () => {
  it('turns the 503 repair_required body into a typed error naming the pending cleanup', async () => {
    fetchMock.mockResolvedValueOnce(uninstallIncompleteResponse(SECRETS_PENDING_BODY))

    const error = await deleteMcpServer('srv').catch(e => e)

    expect(error).toBeInstanceOf(McpServerUninstallIncompleteError)
    expect(error.status).toBe(503)
    expect(error.code).toBe('mcp_server_uninstall_incomplete')
    expect(error.pending).toEqual(['secrets'])
    expect(error.deleted).toEqual(['Context/ctx-a (removed from allowlist)'])
    expect(error.message).toBe(
      'Connector uninstall is incomplete (pending cleanup: connector Secrets). ' +
        'The connector is still installed; retry the delete to finish.'
    )
  })

  it('names a failed CR delete as the pending connector resource that may still be installed', async () => {
    fetchMock.mockResolvedValueOnce(uninstallIncompleteResponse(MCP_SERVER_PENDING_BODY))

    const error = await deleteMcpServer('srv').catch(e => e)

    expect(error.message).toBe(
      'Connector uninstall is incomplete (pending cleanup: connector resource). ' +
        'The connector may still be installed; retry the delete to finish.'
    )
  })

  it('names every stage when the OAuth teardown leaves several pending', async () => {
    fetchMock.mockResolvedValueOnce(uninstallIncompleteResponse(OAUTH_PENDING_BODY))

    const error = await deleteMcpServer('srv').catch(e => e)

    expect(error.pending).toEqual(['dynamic_client', 'oauth_grants'])
    expect(error.message).toBe(
      'Connector uninstall is incomplete (pending cleanup: OAuth client registration, OAuth grants). ' +
        'The connector is still installed; retry the delete to finish.'
    )
  })

  it('keeps the incomplete error for an unknown stage, naming only the known ones', async () => {
    fetchMock
      .mockResolvedValueOnce(
        uninstallIncompleteResponse({ ...SECRETS_PENDING_BODY, pending: ['future_stage'] })
      )
      .mockResolvedValueOnce(
        uninstallIncompleteResponse({
          ...SECRETS_PENDING_BODY,
          pending: ['future_stage', 'secrets'],
        })
      )

    const unknownOnly = await deleteMcpServer('srv').catch(e => e)
    const mixed = await deleteMcpServer('srv').catch(e => e)

    expect(unknownOnly).toBeInstanceOf(McpServerUninstallIncompleteError)
    expect(unknownOnly.pending).toEqual([])
    expect(unknownOnly.message).toBe(
      'Connector uninstall is incomplete. The connector is still installed; retry the delete to finish.'
    )
    expect(mixed).toBeInstanceOf(McpServerUninstallIncompleteError)
    expect(mixed.message).toContain('(pending cleanup: connector Secrets)')
    expect(mixed.message).not.toContain('future_stage')
  })

  it('leaves a 404 for a missing connector as the generic API error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'mcpservers/srv not found' }, 404, 'Not Found')
    )

    const error = await deleteMcpServer('srv').catch(e => e)

    expect(error).not.toBeInstanceOf(McpServerUninstallIncompleteError)
    expect(error.status).toBe(404)
  })

  it('does not treat an unrelated 503 as an incomplete uninstall', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'upstream_unavailable' }, 503, 'Service Unavailable')
    )

    const error = await deleteMcpServer('srv').catch(e => e)

    expect(error).not.toBeInstanceOf(McpServerUninstallIncompleteError)
    expect(error.status).toBe(503)
  })
})
