import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  MODEL_STEP_BLOCKED_REASONS,
  MODEL_STEP_CHECKPOINT_VISIBLE_STATUSES,
  MODEL_STEP_CONTINUE_ERROR_CODES,
  type ModelStepCheckpointView,
} from '../modelStepCheckpointContract'

// The same vectors are loaded by the Desktop suite (#1044); a field renamed on one
// side and not the other fails here or there.
const VECTOR_DIR = path.join(__dirname, '../../../../../tests/fixtures/model-step-checkpoint')

const VIEW_KEYS = new Set([
  'checkpointId',
  'version',
  'status',
  'retryAvailable',
  'originTaskId',
  'continuationTaskId',
  'provider',
  'model',
  'blockedReason',
  'tools',
  'failedAt',
  'expiresAt',
])

function readVector(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, name), 'utf8'))
}

function assertView(value: unknown): asserts value is ModelStepCheckpointView {
  expect(value).toBeTypeOf('object')
  const view = value as Record<string, unknown>
  for (const key of Object.keys(view))
    expect(VIEW_KEYS.has(key), `unexpected key ${key}`).toBe(true)
  expect(view.checkpointId).toBeTypeOf('string')
  expect(Number.isInteger(view.version) && (view.version as number) >= 1).toBe(true)
  expect(MODEL_STEP_CHECKPOINT_VISIBLE_STATUSES).toContain(view.status)
  expect(view.retryAvailable).toBe(view.status === 'resumable')
  expect(view.originTaskId).toBeTypeOf('string')
  expect(view.continuationTaskId !== undefined).toBe(view.status === 'claimed')
  expect(view.blockedReason !== undefined).toBe(view.status === 'blocked')
  if (view.blockedReason !== undefined)
    expect(MODEL_STEP_BLOCKED_REASONS).toContain(view.blockedReason)
  expect(view.provider).toBeTypeOf('string')
  expect(view.model).toBeTypeOf('string')
  const tools = view.tools as Record<string, unknown>
  expect(Object.keys(tools).sort()).toEqual(['confirmed', 'notDispatched', 'unknown'])
  for (const count of Object.values(tools))
    expect(Number.isInteger(count) && (count as number) >= 0).toBe(true)
  expect(Number.isNaN(Date.parse(view.failedAt as string))).toBe(false)
  expect(Number.isNaN(Date.parse(view.expiresAt as string))).toBe(false)
}

describe('model-step checkpoint wire vectors', () => {
  const files = fs.readdirSync(VECTOR_DIR).filter(name => name.endsWith('.json'))

  it('ships one session view per visible status and one continue response per POST row', () => {
    expect(files.sort()).toEqual([
      'continue-response.blocked.json',
      'continue-response.check-unavailable.json',
      'continue-response.claimed.json',
      'continue-response.completed.json',
      'continue-response.not-found.json',
      'continue-response.reclaimed.json',
      'continue-response.replayed.json',
      'continue-response.version-mismatch.json',
      'session-view.blocked.json',
      'session-view.claimed.json',
      'session-view.resumable.json',
    ])
  })

  it.each(MODEL_STEP_CHECKPOINT_VISIBLE_STATUSES)(
    'session-view.%s.json is a valid view of that status',
    status => {
      const view = readVector(`session-view.${status}.json`)
      assertView(view)
      expect(view.status).toBe(status)
    }
  )

  it('continue responses match the status-first precedence table', () => {
    const claimed = readVector('continue-response.claimed.json') as {
      httpStatus: number
      body: Record<string, unknown>
    }
    const replayed = readVector('continue-response.replayed.json') as typeof claimed
    const reclaimed = readVector('continue-response.reclaimed.json') as typeof claimed
    const completed = readVector('continue-response.completed.json') as typeof claimed
    const mismatch = readVector('continue-response.version-mismatch.json') as typeof claimed
    const blocked = readVector('continue-response.blocked.json') as typeof claimed
    const checkUnavailable = readVector(
      'continue-response.check-unavailable.json'
    ) as typeof claimed
    const notFound = readVector('continue-response.not-found.json') as typeof claimed

    expect([claimed.httpStatus, claimed.body.status, claimed.body.replayed]).toEqual([
      202,
      'claimed',
      false,
    ])
    expect([replayed.httpStatus, replayed.body.status, replayed.body.replayed]).toEqual([
      202,
      'claimed',
      true,
    ])
    expect(replayed.body.taskId).toBe(claimed.body.taskId)
    expect([reclaimed.httpStatus, reclaimed.body.status, reclaimed.body.replayed]).toEqual([
      202,
      'claimed',
      false,
    ])
    // A re-claim keeps the checkpoint and mints a new task id.
    expect(reclaimed.body.checkpointId).toBe(claimed.body.checkpointId)
    expect(reclaimed.body.taskId).not.toBe(claimed.body.taskId)
    expect([completed.httpStatus, completed.body.status, completed.body.replayed]).toEqual([
      200,
      'completed',
      true,
    ])

    expect(mismatch.httpStatus).toBe(409)
    expect(mismatch.body.code).toBe(MODEL_STEP_CONTINUE_ERROR_CODES.versionMismatch)
    assertView(mismatch.body.current)
    expect(blocked.httpStatus).toBe(409)
    expect(blocked.body.code).toBe(MODEL_STEP_CONTINUE_ERROR_CODES.blocked)
    expect(MODEL_STEP_BLOCKED_REASONS).toContain(blocked.body.blockedReason)
    // Row 6b: the claim is released, which bumps the version, so the body
    // carries the resumable view the client retries against.
    expect(checkUnavailable.httpStatus).toBe(503)
    expect(checkUnavailable.body.code).toBe(MODEL_STEP_CONTINUE_ERROR_CODES.checkUnavailable)
    assertView(checkUnavailable.body.current)
    expect(checkUnavailable.body.current.status).toBe('resumable')
    expect(notFound.httpStatus).toBe(404)
    expect(notFound.body).toEqual({ code: MODEL_STEP_CONTINUE_ERROR_CODES.notFound })
  })
})
