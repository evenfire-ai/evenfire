import { type Page, expect } from '@playwright/test'

export type ProviderRequest = {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
}

export async function resetProviderRequests(providerUrl: string): Promise<void> {
  const response = await fetch(`${providerUrl}/reset`, { method: 'POST' })
  expect(response.status).toBe(200)
}

export async function selectControlUiTab(
  page: Page,
  tabName: string,
  expectedText: string
): Promise<void> {
  const tab = page.getByRole('tab', { name: tabName })
  await expect(tab).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(
      async () => {
        await tab.click()
        return tab.getAttribute('aria-selected')
      },
      { timeout: 10_000, intervals: [100, 250, 500] }
    )
    .toBe('true')
  await expect(page.getByText(expectedText)).toBeVisible({ timeout: 20_000 })
}

export async function providerRequests(providerUrl: string): Promise<ProviderRequest[]> {
  const response = await fetch(`${providerUrl}/requests`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { requests?: ProviderRequest[] }).requests ?? []
}
