import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  dispatchEntityChangeOutbox,
  isEntityChangeCursor,
  readEntityChangeCheckpoint,
  subscribeEntityChangeFeedWake,
} from '../src/services/entityChangeService.js'

const dbMock = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }))
const configMock = vi.hoisted(() => ({
  entityChangeDispatchBatchSize: 37,
  entityChangeRetentionSeconds: 86_400,
  entityChangeMaxRecoveryEvents: 500,
}))

vi.mock('../src/db.js', () => ({ pool: dbMock }))
vi.mock('../src/config.js', () => ({ config: configMock }))
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}))

describe('entityChangeService', () => {
  beforeEach(() => {
    dbMock.query.mockReset()
    dbMock.connect.mockReset()
  })

  it('validates only canonical UUID cursors', () => {
    expect(isEntityChangeCursor('d119f895-1ef8-4e73-8f08-f9754919682a')).toBe(true)
    expect(isEntityChangeCursor('d119f895-1ef8-4e73-8f08-f9754919682')).toBe(false)
  })

  it('exposes only approved coarse scopes from the durable checkpoint', async () => {
    dbMock.query.mockResolvedValueOnce({
      rows: [
        {
          needs_resync: false,
          current_cursor: 'd119f895-1ef8-4e73-8f08-f9754919682a',
          invalidated_scopes: ['gfs', 'authorization', 'private-resource-id'],
        },
      ],
    })

    await expect(
      readEntityChangeCheckpoint('d119f895-1ef8-4e73-8f08-f9754919682a')
    ).resolves.toEqual({
      resyncRequired: false,
      cursor: 'd119f895-1ef8-4e73-8f08-f9754919682a',
      scopes: ['gfs', 'authorization'],
    })
    expect(dbMock.query).toHaveBeenCalledWith(
      'SELECT * FROM entity_change_read_checkpoint($1::uuid, $2)',
      ['d119f895-1ef8-4e73-8f08-f9754919682a', 500]
    )
  })

  it('dispatches with the configured batch and retention bounds', async () => {
    dbMock.query.mockResolvedValueOnce({ rows: [{ feed_sequence: 1 }] })
    await expect(dispatchEntityChangeOutbox()).resolves.toBe(1)
    expect(dbMock.query).toHaveBeenCalledWith(
      'SELECT * FROM entity_change_dispatch_batch($1, $2)',
      [37, 86_400]
    )
  })

  it('shares one LISTEN connection among wake subscribers and releases it when empty', async () => {
    const listener = new EventEmitter() as EventEmitter & {
      query: ReturnType<typeof vi.fn>
      release: ReturnType<typeof vi.fn>
    }
    listener.query = vi.fn().mockResolvedValue({ rows: [] })
    listener.release = vi.fn()
    dbMock.connect.mockResolvedValueOnce(listener)
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = subscribeEntityChangeFeedWake(first)
    const unsubscribeSecond = subscribeEntityChangeFeedWake(second)
    await vi.waitFor(() => expect(listener.query).toHaveBeenCalledWith('LISTEN entity_change_feed'))
    expect(dbMock.connect).toHaveBeenCalledOnce()

    listener.emit('notification')
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()

    unsubscribeFirst()
    unsubscribeSecond()
    expect(listener.release).toHaveBeenCalledOnce()
  })
})
