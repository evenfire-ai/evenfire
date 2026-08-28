import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMcpSecret,
  deleteMcpSecret,
  formatApiError,
  getMcpSecretRollbackRepairIdentity,
} from '../api'

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
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
  vi.restoreAllMocks()
})

describe('MCP identity compatibility', () => {
  it('accepts a legacy create response without identity and rolls it back without a body', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ name: 'legacy-object', namespace: 'mcp-server' }, 201, 'Created')
      )
      .mockResolvedValueOnce(jsonResponse({ name: 'legacy-object', namespace: 'mcp-server' }))

    const created = await createMcpSecret('legacy-object', { fixture: 'fixture' })

    expect(created).toEqual({ name: 'legacy-object', namespace: 'mcp-server' })

    await deleteMcpSecret(created.name, undefined)

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/control-api/api/v1/admin/mcp-secrets/legacy-object',
      expect.objectContaining({
        method: 'DELETE',
        body: undefined,
      })
    )
  })

  it('preserves and sends a complete identity returned by a current API', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          {
            name: 'current-object',
            namespace: 'mcp-server',
            uid: 'uid-current-object',
            resourceVersion: '9',
          },
          201,
          'Created'
        )
      )
      .mockResolvedValueOnce(jsonResponse({ name: 'current-object', namespace: 'mcp-server' }))

    const created = await createMcpSecret('current-object', { fixture: 'fixture' })

    expect(created).toEqual({
      name: 'current-object',
      namespace: 'mcp-server',
      uid: 'uid-current-object',
      resourceVersion: '9',
    })

    await deleteMcpSecret(created.name, {
      uid: created.uid!,
      resourceVersion: created.resourceVersion!,
    })

    const deleteRequest = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(JSON.parse(String(deleteRequest.body))).toEqual({
      uid: 'uid-current-object',
      resourceVersion: '9',
    })
  })

  it('fails closed when a create response returns only part of an identity', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { name: 'partial-object', namespace: 'mcp-server', uid: 'uid-partial-object' },
        201,
        'Created'
      )
    )

    await expect(createMcpSecret('partial-object', { fixture: 'fixture' })).rejects.toThrow(
      /incomplete Secret identity/
    )
  })
})

describe('MCP Secret rollback repair identity', () => {
  it('extracts a CAS identity from the exact failed POST repair response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'mcp_secret_rollback_permit_unavailable',
          outcome: 'repair_required',
          created: {
            name: 'repaired-credentials',
            namespace: 'mcp-server',
            uid: 'uid-repaired-credentials',
            resourceVersion: '17',
          },
        },
        503,
        'Service Unavailable'
      )
    )

    const failure = await createMcpSecret('repaired-credentials', { fixture: 'fixture' }).catch(
      error => error
    )

    expect(getMcpSecretRollbackRepairIdentity(failure, 'repaired-credentials')).toEqual({
      name: 'repaired-credentials',
      namespace: 'mcp-server',
      uid: 'uid-repaired-credentials',
      resourceVersion: '17',
    })
  })

  it.each([
    [
      'has a different error code',
      503,
      {
        error: 'mcp_secret_rollback_permit_expired',
        outcome: 'repair_required',
        created: {
          name: 'repaired-credentials',
          namespace: 'mcp-server',
          uid: 'uid-repaired-credentials',
          resourceVersion: '17',
        },
      },
    ],
    [
      'is not a 503 response',
      409,
      {
        error: 'mcp_secret_rollback_permit_unavailable',
        outcome: 'repair_required',
        created: {
          name: 'repaired-credentials',
          namespace: 'mcp-server',
          uid: 'uid-repaired-credentials',
          resourceVersion: '17',
        },
      },
    ],
    [
      'does not require repair',
      503,
      {
        error: 'mcp_secret_rollback_permit_unavailable',
        outcome: 'retry_later',
        created: {
          name: 'repaired-credentials',
          namespace: 'mcp-server',
          uid: 'uid-repaired-credentials',
          resourceVersion: '17',
        },
      },
    ],
    [
      'omits a CAS field from the created Secret',
      503,
      {
        error: 'mcp_secret_rollback_permit_unavailable',
        outcome: 'repair_required',
        created: {
          name: 'repaired-credentials',
          namespace: 'mcp-server',
          uid: 'uid-repaired-credentials',
        },
      },
    ],
    [
      'names a different Secret',
      503,
      {
        error: 'mcp_secret_rollback_permit_unavailable',
        outcome: 'repair_required',
        created: {
          name: 'other-credentials',
          namespace: 'mcp-server',
          uid: 'uid-other-credentials',
          resourceVersion: '17',
        },
      },
    ],
  ])('does not extract an identity when the response %s', (_, status, body) => {
    const error = formatApiError(
      { status, statusText: status === 503 ? 'Service Unavailable' : 'Conflict' } as Response,
      JSON.stringify(body)
    )

    expect(getMcpSecretRollbackRepairIdentity(error, 'repaired-credentials')).toBeNull()
  })
})

describe('MCP delete API errors', () => {
  it.each([
    [
      'secret_identity_precondition_required',
      'A current Secret identity is required before it can be deleted.',
    ],
    ['secret_identity_unavailable', 'The server could not verify the current Secret identity.'],
    ['secret_identity_changed', 'This Secret changed since it was loaded.'],
    ['mcp_secret_in_use', 'This Secret is still in use by one or more connectors.'],
    [
      'mcp_secret_reference_check_unavailable',
      'The server could not verify whether this Secret is in use.',
    ],
  ])('maps %s to an operator-safe remediation', (code, message) => {
    const error = formatApiError(
      { status: 409, statusText: 'Conflict' } as Response,
      JSON.stringify({ error: code })
    )

    expect(error.message).toContain(message)
    expect((error as Error & { code?: string }).code).toBe(code)
  })
})
