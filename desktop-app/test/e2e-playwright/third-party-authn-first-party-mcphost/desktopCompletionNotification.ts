import { type Page, expect } from '@playwright/test'
import { selectWorkflow, shortRunId } from '../workflowUi'
import { humanClick } from './telegramE2eClient'

export async function expectDesktopWorkflowCompletionNotificationOpensResults(
  page: Page,
  recipeName: string,
  runId: string
): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  if ((await bell.getAttribute('aria-expanded')) !== 'true') await humanClick(bell)
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const completionItem = panel
    .getByTestId('notification-menu-item')
    .filter({ hasText: recipeName })
    .filter({ hasText: 'Workflow completed' })
    .first()
  await expect(completionItem).toBeVisible({ timeout: 45_000 })
  await expect(completionItem).toContainText('Results are ready')
  const openButton = completionItem.getByRole('button', { name: 'Open' })
  await expect(openButton).toBeEnabled()
  await humanClick(openButton)

  const detailCard = await selectWorkflow(page, recipeName, 'sandbox-recipes')
  const row = detailCard.getByTestId('workflow-run-row').filter({ hasText: shortRunId(runId) })
  await expect(row).toBeVisible({ timeout: 60_000 })
  await expect(row).toContainText('Succeeded')
}
