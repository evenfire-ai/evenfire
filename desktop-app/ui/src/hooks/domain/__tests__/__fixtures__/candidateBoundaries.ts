import { expect } from 'vitest'
import { within } from '@testing-library/react'

type CurrentView = {
  row: (agent: string, chat: string) => HTMLElement | null
  drainCommittedWork: () => Promise<void>
}
function badge(view: CurrentView, agent: string, id: string): boolean {
  const row = view.row(agent, id)
  expect(row, agent + '/' + id).not.toBeNull()
  return within(row!).queryByRole('status', { name: 'Completed, unread' }) !== null
}

// Bind at implementation time to the actual controller and its actual queued update.
// Enqueue must retain the real dispatch. No synthetic reducer, response or badge.
export async function checkDiscard(
  view: CurrentView,
  issueOldProjection: () => Promise<void>,
  verifyQueuedBeforeCommit: () => void,
  replaceOwnerWithSameKey: () => Promise<void>,
  releaseOldWork: () => Promise<void>,
  holdCommit?: (steps: () => Promise<void>) => Promise<void>
) {
  const steps = async () => {
    await issueOldProjection()
    verifyQueuedBeforeCommit()
    await replaceOwnerWithSameKey()
    await releaseOldWork()
  }
  await (holdCommit ? holdCommit(steps) : steps())
  await view.drainCommittedWork()
  expect(badge(view, 'agent-x', 'chat-a')).toBe(true)
  expect(badge(view, 'agent-y', 'chat-a')).toBe(true)
}

// Mount the real renderer in StrictMode. The observer counts evaluations of the
// same identified update only. Run the row-13 hold, mark and settlement drivers.
export async function checkReplay(
  view: CurrentView,
  issuePublicationAndHoldFinalCommit: () => Promise<void>,
  issueHiddenMarkThenRelease: () => Promise<void>,
  evaluationsOfPublication: () => number
) {
  await issuePublicationAndHoldFinalCommit()
  await issueHiddenMarkThenRelease()
  await view.drainCommittedWork()
  expect(evaluationsOfPublication()).toBeGreaterThanOrEqual(2)
  expect(badge(view, 'agent-x', 'chat-a')).toBe(true)
  expect(badge(view, 'agent-y', 'chat-a')).toBe(true)
}
