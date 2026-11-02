import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseModelStepCheckpointView,
  parseModelStepContinueResponse,
} from '../src/modelStepCheckpointWire.js'

const FIXTURES = resolve(__dirname, '../../tests/fixtures/model-step-checkpoint')
const CHECKPOINT_ID = 'msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as Record<string, unknown>
}

function continueFixture(name: string): { httpStatus: number; body: Record<string, unknown> } {
  return fixture(name) as { httpStatus: number; body: Record<string, unknown> }
}

function parseContinue(response: { httpStatus: number; body: Record<string, unknown> }) {
  return parseModelStepContinueResponse(response.httpStatus, response.body, CHECKPOINT_ID)
}

describe('model-step checkpoint wire contract', () => {
  it.each([
    'session-view.resumable.json',
    'session-view.claimed.json',
    'session-view.blocked.json',
  ])('accepts the shared %s view fixture', name => {
    const view = fixture(name)
    expect(parseModelStepCheckpointView(view)).toEqual(view)
  })

  it.each([
    'continue-response.claimed.json',
    'continue-response.replayed.json',
    'continue-response.reclaimed.json',
    'continue-response.completed.json',
    'continue-response.not-found.json',
    'continue-response.blocked.json',
    'continue-response.version-mismatch.json',
  ])('accepts the shared %s response fixture', name => {
    expect(parseContinue(continueFixture(name))).not.toBeNull()
  })

  it('rejects an unknown checkpoint view field', () => {
    const valid = fixture('session-view.resumable.json')
    expect(parseModelStepCheckpointView(valid)).toEqual(valid)
    expect(() => parseModelStepCheckpointView({ ...valid, unexpected: true })).toThrow(
      'Invalid model step checkpoint.unexpected'
    )
  })

  it('rejects version zero while preserving a valid checkpoint view', () => {
    const valid = fixture('session-view.resumable.json')
    expect(parseModelStepCheckpointView(valid)).toEqual(valid)
    expect(() => parseModelStepCheckpointView({ ...valid, version: 0 })).toThrow(
      'Invalid model step checkpoint.version'
    )
  })

  it('rejects an unknown tools field', () => {
    const valid = fixture('session-view.resumable.json')
    expect(parseModelStepCheckpointView(valid)).toEqual(valid)
    expect(() =>
      parseModelStepCheckpointView({
        ...valid,
        tools: { ...(valid.tools as object), unexpected: true },
      })
    ).toThrow('Invalid model step checkpoint.tools.unexpected')
  })

  it('rejects an unknown current view field in a version-mismatch response', () => {
    const valid = continueFixture('continue-response.version-mismatch.json')
    expect(parseContinue(valid)).not.toBeNull()
    expect(() =>
      parseContinue({
        ...valid,
        body: {
          ...valid.body,
          current: { ...(valid.body.current as object), unexpected: true },
        },
      })
    ).toThrow('Invalid model step continue response.current.unexpected')
  })

  it.each([
    ['continue-response.completed.json', 200],
    ['continue-response.claimed.json', 202],
    ['continue-response.not-found.json', 404],
    ['continue-response.blocked.json', 409],
    ['continue-response.version-mismatch.json', 409],
  ])('rejects an unknown field in %s (%i)', name => {
    const valid = continueFixture(name)
    expect(parseContinue(valid)).not.toBeNull()
    expect(() => parseContinue({ ...valid, body: { ...valid.body, unexpected: true } })).toThrow(
      'Invalid model step continue response.unexpected'
    )
  })

  it.each([
    ['session-view.resumable.json', 'blockedReason', 'model_unavailable'],
    ['session-view.claimed.json', 'blockedReason', 'model_unavailable'],
    ['session-view.resumable.json', 'blockedReason', null],
    ['session-view.resumable.json', 'continuationTaskId', 'task_other'],
    ['session-view.blocked.json', 'continuationTaskId', 'task_other'],
    ['session-view.blocked.json', 'continuationTaskId', null],
  ])('rejects %s with %s=%s outside its status', (name, field, value) => {
    const valid = fixture(name)
    expect(parseModelStepCheckpointView(valid)).toEqual(valid)
    expect(() => parseModelStepCheckpointView({ ...valid, [field]: value })).toThrow(
      `Invalid model step checkpoint.${field}`
    )
  })

  it.each([
    ['failedAt', 'October 9, 2026'],
    ['expiresAt', '2026-10-14T23:58:23Z'],
    ['failedAt', '2026-02-30T23:58:23.000Z'],
  ])('rejects noncanonical ISO timestamp %s=%s', (field, value) => {
    const valid = fixture('session-view.resumable.json')
    expect(parseModelStepCheckpointView(valid)).toEqual(valid)
    expect(() => parseModelStepCheckpointView({ ...valid, [field]: value })).toThrow(
      `Invalid model step checkpoint.${field}`
    )
  })

  it('names replayed when a completed response does not replay', () => {
    const valid = continueFixture('continue-response.completed.json')
    expect(parseContinue(valid)).not.toBeNull()
    expect(() => parseContinue({ ...valid, body: { ...valid.body, replayed: false } })).toThrow(
      'Invalid model step continue response.replayed'
    )
  })
})
