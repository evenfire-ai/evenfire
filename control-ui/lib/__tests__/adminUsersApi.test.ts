import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteAdminUser } from '../api'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222'

describe('deleteAdminUser', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the governed reason, idempotency key, and correlation id to Control API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deleted: true, id: USER_ID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      deleteAdminUser(USER_ID, {
        reason: 'access review complete',
        idempotencyKey: 'retire-user-v1',
        correlationId: CORRELATION_ID,
      })
    ).resolves.toEqual({ deleted: true, id: USER_ID })

    expect(fetchMock).toHaveBeenCalledWith(
      `/control-api/api/v1/admin/users/${USER_ID}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Idempotency-Key': 'retire-user-v1',
          'x-correlation-id': CORRELATION_ID,
        }),
        body: JSON.stringify({ reason: 'access review complete' }),
      })
    )
  })

  it('generates governed metadata when the caller uses the default request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deleted: true, id: USER_ID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await deleteAdminUser(USER_ID)

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'control_ui_user_retirement' })
    expect(headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })
})
