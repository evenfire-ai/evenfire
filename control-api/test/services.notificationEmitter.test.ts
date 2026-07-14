import { beforeEach, describe, expect, it, vi } from 'vitest'

const configMock = vi.hoisted(() => ({
  notificationsDesktopFirstEnabled: true,
  notificationDesktopGraceSeconds: 90,
}))

vi.mock('../src/config.js', () => ({
  config: configMock,
}))

vi.mock('../src/observability/metrics.js', () => ({
  notificationEventsEnqueuedTotal: { inc: vi.fn() },
  notificationOutboxEnqueueFailuresTotal: { inc: vi.fn() },
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
}))

const { pool } = await import('../src/db.js')
const { enqueueApprovalRequestedNotification, enqueuePluginWorkloadSdkNotification } =
  await import('../src/services/notificationEmitter.js')

describe('notificationEmitter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMock.notificationsDesktopFirstEnabled = true
    configMock.notificationDesktopGraceSeconds = 90
    vi.mocked(pool.query).mockResolvedValue({ rowCount: 1, rows: [] } as never)
  })

  it('enqueues approval requests with provider action payloads accepted by the reader', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }

    await enqueueApprovalRequestedNotification(db, {
      approvalRequestId: '99999999-8888-7777-6666-555555555555',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'due-diligence',
      targetUserId: 'user-1',
      payload: { message: 'Approve workflow trigger' },
      expiresAt: '2026-06-01T12:00:00.000Z',
    })

    const payload = JSON.parse(String(db.query.mock.calls[0]![1]![3]))
    expect(payload.actions).toHaveLength(2)
    expect(payload.actions[0]).toMatchObject({ decision: 'approve', label: 'Approve' })
    expect(payload.actions[1]).toMatchObject({ decision: 'deny', label: 'Deny' })
    expect(payload.actions[0].id).toBe('approve:99999999-8888-7777-6666-555555555555')
    expect(payload.actions[1].id).toBe('deny:99999999-8888-7777-6666-555555555555')
  })
})

describe('enqueuePluginWorkloadSdkNotification', () => {
  const baseParams = {
    notificationId: 'notif-1',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'sdk-recipe',
    callerRef: 'sdk-caller',
    eventType: 'e2e.test.notification',
    title: 'Title',
    body: 'Body',
  }

  it('defers channel fallback with the desktop grace window when userRef is present', async () => {
    await enqueuePluginWorkloadSdkNotification(pool, {
      ...baseParams,
      userRef: 'user-uuid-1',
    })

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('make_interval(secs => $7::int)'),
      expect.arrayContaining([
        'plugin_workload_sdk.notification',
        'notif-1:plugin_workload_sdk.notification',
        JSON.stringify({ userId: 'user-uuid-1' }),
        expect.any(String),
        'normal',
        true,
        90,
      ])
    )
  })

  it('enqueues immediately when desktop-first is disabled', async () => {
    configMock.notificationsDesktopFirstEnabled = false

    await enqueuePluginWorkloadSdkNotification(pool, {
      ...baseParams,
      userRef: 'user-uuid-1',
    })

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHEN $6::boolean THEN NOW() + make_interval'),
      expect.arrayContaining([false, 90])
    )
  })

  it('enqueues immediately for targetRef audiences without a userRef', async () => {
    await enqueuePluginWorkloadSdkNotification(pool, {
      ...baseParams,
      targetRef: 'team:ops',
    })

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHEN $6::boolean THEN NOW() + make_interval'),
      expect.arrayContaining([JSON.stringify({ targetRef: 'team:ops' }), false, 90])
    )
  })
})
