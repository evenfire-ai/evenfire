import { type Page, expect } from '@playwright/test'

const DEFAULT_PROVIDER_MESSAGE_MIN_GAP_MS = 30_000
const lastProviderMessageAt = new WeakMap<Page, number>()

function providerMessageMinGapMs(): number {
  const raw = process.env.E2E_PROVIDER_MESSAGE_MIN_GAP_MS
  if (!raw) return DEFAULT_PROVIDER_MESSAGE_MIN_GAP_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PROVIDER_MESSAGE_MIN_GAP_MS
  return Math.min(Math.floor(parsed), 120_000)
}

export async function waitBeforeProviderMessage(page: Page): Promise<void> {
  await expect(page.getByTestId('telegram-send')).toBeEnabled({ timeout: 10_000 })

  const minGapMs = providerMessageMinGapMs()
  if (minGapMs <= 0) return

  const lastSentAt = lastProviderMessageAt.get(page) ?? 0
  const remainingMs = minGapMs - (Date.now() - lastSentAt)
  if (remainingMs > 0) {
    // Provider pacing, not readiness: the fake channel should not burst multiple
    // user turns into a latency-sensitive real LLM model back-to-back.
    await page.waitForTimeout(remainingMs)
  }
}

export function markProviderMessageSent(page: Page): void {
  lastProviderMessageAt.set(page, Date.now())
}
