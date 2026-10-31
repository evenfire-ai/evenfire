// Human pacing for recorded E2E runs (/human-e2e-recorder). Every helper is a
// no-op unless HUMAN_E2E_RECORDED=1, so certification runs keep their timing.
// No Playwright import: Control UI specs load this file from desktop-app, and a
// second @playwright/test copy aborts the run.

export const HUMAN_E2E_RECORDED = process.env.HUMAN_E2E_RECORDED === '1'

export type HumanPacingRange = [number, number]

export function randomInt([min, max]: HumanPacingRange): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

export async function humanRecordedPause(range: HumanPacingRange = [220, 520]): Promise<void> {
  if (!HUMAN_E2E_RECORDED) return
  await new Promise(resolve => setTimeout(resolve, randomInt(range)))
}
