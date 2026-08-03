// Human-pacing helpers for recorded QA/demo runs (human-e2e-recorder skill).
// Not for correctness waits — Playwright auto-waiting handles those. These add
// visible mouse movement, deliberate pauses, and char-by-char typing so a
// recorded video reads like a person driving the UI. Speed is env-driven
// (HUMAN_E2E_SPEED); the runner also injects launchOptions.slowMo via the config.
import type { Locator, Page } from '@playwright/test'

type Speed = 'fast' | 'normal' | 'demo' | 'slow'
const SPEED: Speed = (process.env.HUMAN_E2E_SPEED as Speed) || 'demo'

const TYPE_DELAY: Record<Speed, [number, number]> = {
  fast: [25, 80],
  normal: [40, 120],
  demo: [80, 180],
  slow: [120, 260],
}
const PAUSE: Record<Speed, [number, number]> = {
  fast: [150, 350],
  normal: [300, 700],
  demo: [600, 1200],
  slow: [1000, 1800],
}

// Deterministic-enough jitter without Math.random reproducibility concerns:
// recordings don't need reproducibility, only human-looking variation.
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * Math.max(1, max - min))
}

export async function humanPause(page: Page, min?: number, max?: number): Promise<void> {
  const [lo, hi] = PAUSE[SPEED]
  await page.waitForTimeout(rand(min ?? lo, max ?? hi))
}

export async function humanMouseMove(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox()
  if (!box) return
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 })
}

export async function humanClick(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  await humanMouseMove(page, target)
  await humanPause(page, 150, 350)
  await target.click()
  await humanPause(page)
}

export async function humanType(page: Page, target: Locator, text: string): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  await humanMouseMove(page, target)
  await target.click()
  await humanPause(page, 120, 260)
  const [lo, hi] = TYPE_DELAY[SPEED]
  await target.pressSequentially(text, { delay: rand(lo, hi) })
  await humanPause(page)
}

export async function humanReveal(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  await humanMouseMove(page, target)
  await humanPause(page)
}
