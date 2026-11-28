import { type Page, expect } from '@playwright/test'
import { agentDisplayName, fleetAgentActions, fleetAgentSelector } from './agentIdentity.js'

/** Shared by the live stateless/cross-device journeys and the seeded browser identity journey. */
export async function startAgentChatFromFleet(page: Page, ref: string): Promise<void> {
  const row = page.locator(fleetAgentSelector(ref))
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toHaveCount(1)
  const display = await row.locator('.agent-row-main-copy strong').innerText()
  const actions = fleetAgentActions(page, ref)
  await expect(actions).toHaveAccessibleName(`More actions for ${display}`)
  await actions.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible({ timeout: 10_000 })
  await menu
    .getByRole('button', { name: /^New chat$/ })
    .or(menu.getByRole('menuitem', { name: /^New chat$/ }))
    .click()
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('textbox', { name: 'Agent message composer' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Switch chat agent', exact: true })).toHaveText(
    await agentDisplayName(page, ref),
    { timeout: 30_000 }
  )
}
