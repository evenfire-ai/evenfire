import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db.js', () => {
  const pool = { query: vi.fn() }
  return {
    pool,
    withTransaction: vi.fn(async (fn: (db: typeof pool) => unknown) => fn(pool)),
  }
})

const { pool } = await import('../src/db.js')
const { acknowledgeDesktopNotificationDelivery } =
  await import('../src/services/notificationAckService.js')

describe('notificationAckService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks queued SDK notifications as sent on desktop ack and transitions the invocation', async () => {
    // Call 1: desktop ACK UPDATE returns the invocation id (payload
    // notificationId). Call 2: the invocation accepted → delivered transition.
    vi.mocked(pool.query)
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ invocationId: '33333333-3333-3333-3333-333333333333' }],
      } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ attempt_generation: 1 }] } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] } as never)

    const result = await acknowledgeDesktopNotificationDelivery(
      '22222222-2222-2222-2222-222222222222',
      '11111111-1111-1111-1111-111111111111'
    )

    expect(result).toEqual({ status: 'acked' })
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("delivered_medium = 'desktop'"),
      ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']
    )
    // S3: desktop delivery closes the clientNotifications lifecycle.
    const invocationSql = String(vi.mocked(pool.query).mock.calls[1]![0])
    expect(invocationSql).toContain('UPDATE plugin_workload_sdk_invocations')
    expect(vi.mocked(pool.query).mock.calls[1]![1]).toEqual([
      '33333333-3333-3333-3333-333333333333',
      'delivered',
      true,
      0,
      'accepted',
    ])
  })

  it('returns already_terminal when the delivery is no longer claimable', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'sent' }] } as never)

    const result = await acknowledgeDesktopNotificationDelivery(
      '22222222-2222-2222-2222-222222222222',
      '11111111-1111-1111-1111-111111111111'
    )

    expect(result).toEqual({ status: 'already_terminal' })
  })
})
