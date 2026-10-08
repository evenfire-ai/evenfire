/**
 * #1044 — shared test support for the model-step checkpoint. Views and POST
 * answers are read from the C0 contract fixtures and parsed by the same reader
 * the main process uses, so a renderer test cannot drift from the wire contract.
 */
import { expect } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseModelStepCheckpointView,
  parseModelStepContinueResponse,
} from '../../../../../../src/modelStepCheckpointWire'
import type {
  ModelStepCheckpointView,
  ModelStepContinueResult,
  SessionMessagesResult,
} from '../../../../../../src/types'
import { renderController } from './controllerHarness'
import type { MockClerum } from './mockClerum'

export const CHECKPOINT_ID = 'msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1'
export const ORIGIN_TASK_ID = '8d6f3a2e-4b1c-4e7a-9f0d-2c5b6a7e8f90'
export const CONTINUATION_TASK_ID = '3c1e9b7a-0f2d-4a6b-8c5e-1d7f9a3b2c40'
export const ORIGIN_PROMPT = 'run the 21 tool calls'

export const FAILED_TERMINAL = {
  type: 'terminal',
  data: {
    status: 'failed',
    error: { message: 'The provider is unavailable.', code: 'provider_unavailable' },
  },
}

export function modelStepFixture(name: string): unknown {
  const path = resolve(__dirname, '../../../../../../../tests/fixtures/model-step-checkpoint', name)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function checkpointView(name: string): ModelStepCheckpointView {
  return parseModelStepCheckpointView(modelStepFixture(name))
}

export function continueAnswer(name: string): ModelStepContinueResult {
  const { httpStatus, body } = modelStepFixture(name) as { httpStatus: number; body: unknown }
  const parsed = parseModelStepContinueResponse(httpStatus, body, CHECKPOINT_ID)
  if (!parsed) throw new Error(`fixture ${name} is not a contract row`)
  return parsed
}

export function sessionWith(
  checkpoint: ModelStepCheckpointView | undefined,
  chatId = ''
): SessionMessagesResult {
  return {
    agent: 'agent-x',
    chatId,
    state: 'idle',
    turns: [],
    ...(checkpoint ? { modelStepCheckpoint: checkpoint } : {}),
  } as SessionMessagesResult
}

/** The session reads the failed-terminal path makes for the checkpoint (`limit: 1`). */
export function checkpointReads(clerum: MockClerum): unknown[][] {
  return clerum.rpc.loadSessionMessages.mock.calls.filter(call => {
    const query = call[call.length - 1] as { limit?: number } | undefined
    return query?.limit === 1
  })
}

/**
 * Sends one message whose task (the fixture's origin task) fails, with every
 * Host session read answering `checkpoint`. Resolves once the failed terminal
 * has been fully handled: its error bubble is persisted and the tracker has
 * released the task.
 */
export async function sendAndFail(
  clerum: MockClerum,
  checkpoint: ModelStepCheckpointView | undefined
) {
  clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: ORIGIN_TASK_ID })
  clerum.rpc.loadSessionMessages.mockResolvedValue(sessionWith(checkpoint))
  const harness = renderController()
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
  await act(async () => {
    await harness.result.current.handleSendAgentMessage(ORIGIN_PROMPT)
  })
  await waitFor(() => expect(clerum.hasProgressHandler(ORIGIN_TASK_ID)).toBe(true))
  const appendsBefore = clerum.chat.appendMessages.mock.calls.length
  await act(async () => {
    clerum.emitTaskProgress(ORIGIN_TASK_ID, FAILED_TERMINAL)
  })
  await waitFor(() =>
    expect(
      clerum.chat.appendMessages.mock.calls
        .slice(appendsBefore)
        .some(call =>
          (call[2] as Array<{ isError?: boolean; task_id?: string }>).some(
            message => message.isError === true && message.task_id === ORIGIN_TASK_ID
          )
        )
    ).toBe(true)
  )
  await waitFor(() => expect(clerum.hasProgressHandler(ORIGIN_TASK_ID)).toBe(false))
  return harness
}
