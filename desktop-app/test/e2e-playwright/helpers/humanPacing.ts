// Pointer-level pacing for recorded E2E runs (/human-e2e-recorder); no-ops
// unless HUMAN_E2E_RECORDED=1. The plain pauses live in ./humanPause.
import { type Locator, expect } from '@playwright/test'
import {
  HUMAN_E2E_RECORDED,
  type HumanPacingRange,
  humanRecordedPause,
  randomInt,
} from './humanPause'

export { HUMAN_E2E_RECORDED, humanRecordedPause, randomInt, type HumanPacingRange }

export async function humanClick(
  locator: Locator,
  options: {
    beforeMs?: HumanPacingRange
    afterMs?: HumanPacingRange
    moveSteps?: number
    clickDelayMs?: number
  } = {}
): Promise<void> {
  if (!HUMAN_E2E_RECORDED) {
    await locator.click()
    return
  }

  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  await humanRecordedPause(options.beforeMs ?? [260, 720])
  const box = await locator.boundingBox()
  if (box) {
    await locator.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: options.moveSteps ?? randomInt([12, 24]),
    })
  } else {
    await locator.hover()
  }
  await humanRecordedPause([140, 360])
  await locator.click({ delay: options.clickDelayMs ?? randomInt([45, 120]) })
  await humanRecordedPause(options.afterMs ?? [280, 760])
}

export async function humanType(locator: Locator, text: string): Promise<void> {
  if (!HUMAN_E2E_RECORDED) {
    await locator.fill(text)
    return
  }

  await humanClick(locator, { beforeMs: [180, 420], afterMs: [120, 260] })
  await locator.fill('')
  await locator.pressSequentially(text, { delay: randomInt([8, 22]) })
  await humanRecordedPause([320, 720])
}
