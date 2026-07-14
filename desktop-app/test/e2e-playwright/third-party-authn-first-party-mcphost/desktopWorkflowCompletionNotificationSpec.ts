import { test } from '@playwright/test'
import { E2E_EMAIL, clearSession, launchAndLogin, loginAs } from '../workflowUi'
import { expectDesktopWorkflowCompletionNotificationOpensResults } from './desktopCompletionNotification'
import { seedWorkflowCompletedNotificationFixture } from './desktopCompletionNotificationFixture'
import {
  cleanupWorkflowRecipe,
  installWorkflowRecipeForUser,
  makeScopedE2ERecipeName,
} from './workflowApprovalJourney'

test.describe('Desktop workflow completion notifications', () => {
  test('opens the existing bell notification and refreshes workflow run results', async () => {
    test.setTimeout(120_000)
    const recipeName = makeScopedE2ERecipeName('desktop')
    const marker = `desk-${Date.now().toString(36)}`
    let app: Awaited<ReturnType<typeof launchAndLogin>>['app'] | null = null
    let userId = ''

    try {
      await test.step('Seed a completed workflow notification visible to the Desktop user', async () => {
        await clearSession()
        cleanupWorkflowRecipe(recipeName)
        const login = await loginAs(E2E_EMAIL)
        userId = login.userId
        await installWorkflowRecipeForUser({ recipeName, marker, userId })
      })

      const runId = seedWorkflowCompletedNotificationFixture({ recipeName, userId })

      await test.step('Open Desktop and use the bell to navigate to the completed run', async () => {
        const launched = await launchAndLogin(E2E_EMAIL)
        app = launched.app
        await expectDesktopWorkflowCompletionNotificationOpensResults(
          launched.page,
          recipeName,
          runId
        )
      })
    } finally {
      if (app) await app.close().catch(() => undefined)
      cleanupWorkflowRecipe(recipeName)
    }
  })
})
