import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ModelStepCheckpointRow,
  ModelStepCheckpointSnapshot,
} from '../../../db/worker/modelStepCheckpointOps'
import { toModelStepCheckpointView } from '../modelStepCheckpointView'

// Same vectors as the contract test and the Desktop suite (#1044): the Host's
// own projection must produce them byte for byte.
const VECTOR_DIR = path.join(__dirname, '../../../../../tests/fixtures/model-step-checkpoint')
const readVector = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, name), 'utf8'))

const FAILED_AT = Date.parse('2026-10-07T23:58:23.000Z')
const EXPIRES_AT = Date.parse('2026-10-14T23:58:23.000Z')

function snapshot(overrides: Partial<ModelStepCheckpointRow>): ModelStepCheckpointSnapshot {
  return {
    header: {
      checkpoint_id: 'msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1',
      session_key: 'user:rpc:agent:chat',
      origin_turn_number: 4,
      origin_task_id: '8d6f3a2e-4b1c-4e7a-9f0d-2c5b6a7e8f90',
      continuation_task_id: null,
      version: 1,
      status: 'resumable',
      provider: 'codex-subscription',
      model: 'gpt-6.1-sol',
      host_id: 'host-a',
      principal: 'user',
      loop_state: '{"nextIteration":21}',
      task_budget: null,
      source_message: null,
      claim_owner: '8d6f3a2e-4b1c-4e7a-9f0d-2c5b6a7e8f90',
      claim_generation: 0,
      claim_expires_at: null,
      blocked_reason: null,
      failed_at: FAILED_AT,
      expires_at: EXPIRES_AT,
      created_at: FAILED_AT - 60_000,
      updated_at: FAILED_AT,
      ...overrides,
    },
    tools: { confirmed: 21, unknown: 0, notDispatched: 0 },
  }
}

describe('toModelStepCheckpointView (#1043)', () => {
  it.each([
    ['session-view.resumable.json', {}],
    [
      'session-view.claimed.json',
      {
        status: 'claimed' as const,
        version: 2,
        continuation_task_id: '3c1e9b7a-0f2d-4a6b-8c5e-1d7f9a3b2c40',
        claim_owner: 'host-instance-1',
        claim_generation: 1,
        claim_expires_at: FAILED_AT + 300_000,
      },
    ],
    [
      'session-view.blocked.json',
      { status: 'blocked' as const, version: 2, blocked_reason: 'model_unavailable' },
    ],
  ])('projects the row behind %s exactly', (vector, overrides) => {
    expect(toModelStepCheckpointView(snapshot(overrides))).toEqual(readVector(vector))
  })

  it.each(['open', 'completed', 'abandoned'] as const)('serves no view for %s', status => {
    // Witness: the same row with a visible status does produce a view.
    expect(toModelStepCheckpointView(snapshot({}))).toBeDefined()
    expect(toModelStepCheckpointView(snapshot({ status }))).toBeUndefined()
  })

  it('serves attachment_expired as a blocked reason', () => {
    expect(
      toModelStepCheckpointView(
        snapshot({ status: 'blocked', blocked_reason: 'attachment_expired' })
      )
    ).toMatchObject({
      status: 'blocked',
      retryAvailable: false,
      blockedReason: 'attachment_expired',
    })
  })

  it('refuses a blocked row with an unknown reason', () => {
    expect(() =>
      toModelStepCheckpointView(snapshot({ status: 'blocked', blocked_reason: 'disk_full' }))
    ).toThrow('unknown blocked reason: disk_full')
  })

  it('refuses a visible row without failure time', () => {
    expect(() => toModelStepCheckpointView(snapshot({ failed_at: null }))).toThrow(
      'without failure or expiry time'
    )
  })
})
