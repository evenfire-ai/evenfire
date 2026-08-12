import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  applySdkLayoutRecipe,
  cleanupSdkWorkloadRecipe,
  createSdkWorkloadGrants,
  purgeStaleSdkNotifications,
  waitForSdkSandboxUiNotification,
} from './sdk-client-notification/sdkWorkloadFixture'
import { HOST_REF } from './third-party-authn-first-party-mcphost/telegramE2eClient'
import {
  profilesSql,
  sqlLiteral,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { createApproval, issueRuntimeTokens } from './workflow-approval-quadrants/approvalApi'
import { WORKFLOW_RECIPE_NS } from './workflow-approval-quadrants/constants'
import {
  applyRecipe,
  cleanupRecipe,
  setUserWorkflowGrantsThroughAdminRoute,
} from './workflow-approval-quadrants/recipes'
import { E2E_EMAIL, RECIPE_NS, clearSession, launchAndLogin, loginAs } from './workflowUi'

const LONG_CONVERSATION =
  'A deliberately long conversation label that must remain accessible while the visible return control truncates it'

function assertNoIntersection(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number }
): void {
  const intersects =
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  expect(intersects, 'header controls must not overlap').toBe(false)
}

async function resizeDesktop(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, nextWidth) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) throw new Error('Desktop BrowserWindow closed')
    window.setContentSize(nextWidth, 800)
  }, width)
}

async function bounds(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox()
  expect(box, 'expected a visible layout element').not.toBeNull()
  return box!
}

test('Desktop app tray layout is exercised with producer-backed notification and approval cards', async ({
  request,
}) => {
  test.setTimeout(420_000)
  const marker = Date.now().toString(36)
  const appRecipe = `e2e-sdk-layout-${marker}`
  const approvalRecipe = `e2e-quadrant-layout-${marker}`
  const chatId = `layout-${randomUUID()}`
  const runId = `layout-${marker}`
  let app: Awaited<ReturnType<typeof launchAndLogin>>['app'] | undefined

  try {
    await clearSession()
    const auth = await loginAs(E2E_EMAIL)
    expect(auth.userId).toMatch(/^[0-9a-f-]{36}$/)
    purgeStaleSdkNotifications(auth.userId)
    cleanupSdkWorkloadRecipe(appRecipe)
    await cleanupRecipe(approvalRecipe)

    await test.step('establish a real mounted app, notification, pending approval, and chat origin', async () => {
      applySdkLayoutRecipe(appRecipe, auth.userId, runId)
      await createSdkWorkloadGrants(appRecipe, auth.userId, ['sandbox-ui'], false)
      profilesSql(`
        INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
        VALUES (${sqlLiteral(auth.userId)}, ${sqlLiteral(RECIPE_NS)}, ${sqlLiteral(appRecipe)})
        ON CONFLICT DO NOTHING;
      `)

      applyRecipe(approvalRecipe, {
        requiresApproval: true,
        instruction: 'Producer-backed Desktop responsive-layout approval fixture.',
      })
      await setUserWorkflowGrantsThroughAdminRoute(WORKFLOW_RECIPE_NS, approvalRecipe, [
        auth.userId,
      ])

      const tokens = await issueRuntimeTokens(request, 'wrc', WORKFLOW_RECIPE_NS, approvalRecipe)
      const approvalId = await createApproval(
        request,
        tokens,
        WORKFLOW_RECIPE_NS,
        approvalRecipe,
        auth.userId
      )
      expect(approvalId).toMatch(/^[0-9a-f-]{36}$/)

      const launched = await launchAndLogin(E2E_EMAIL)
      app = launched.app
      const { page } = launched
      await page.evaluate(
        async ({ agentRef, nextChatId, title }) => {
          await window.clerum.chat.create(agentRef, nextChatId)
          await window.clerum.chat.rename(agentRef, nextChatId, title)
        },
        { agentRef: HOST_REF, nextChatId: chatId, title: LONG_CONVERSATION }
      )

      await page.getByTestId('nav-chat').click()
      const conversation = page.getByRole('button', { name: `Open ${LONG_CONVERSATION}` })
      await expect(conversation).toBeVisible({ timeout: 30_000 })
      await conversation.click()

      await page.getByTestId('nav-sandbox-ui').click()
      const appButton = page.getByRole('button', { name: 'Open E2E Layout Notification App' })
      await expect(appButton).toBeVisible({ timeout: 60_000 })
      await appButton.click()
      await expect(page.getByRole('button', { name: `Back to ${LONG_CONVERSATION}` })).toBeVisible({
        timeout: 30_000,
      })
      await waitForSdkSandboxUiNotification(appRecipe)
    })

    const page = await app.firstWindow()
    await test.step('desktop tray cards stay compact and top aligned', async () => {
      await resizeDesktop(app!, 1200)
      await page.getByTestId('notification-bell').click()
      const tray = page.getByRole('dialog', { name: 'Notifications and approvals' })
      const approval = tray
        .getByTestId('workflow-approval-card')
        .filter({ hasText: approvalRecipe })
      const notification = tray
        .getByTestId('notification-menu-item')
        .filter({ hasText: 'Sent by the mounted Plugin Workload SDK Sandbox UI fixture.' })
      await expect(approval).toBeVisible({ timeout: 30_000 })
      await expect(notification).toBeVisible({ timeout: 30_000 })

      for (const card of [approval, notification]) {
        const geometry = await card.evaluate(element => {
          const cardRect = element.getBoundingClientRect()
          const listRect = element.parentElement?.getBoundingClientRect()
          return {
            height: cardRect.height,
            offsetFromListTop: listRect ? cardRect.top - listRect.top : Number.NaN,
          }
        })
        expect(geometry.height, 'tray cards must not stretch to fill the drawer').toBeLessThan(260)
        expect(
          geometry.offsetFromListTop,
          'tray cards must begin at their list top'
        ).toBeLessThanOrEqual(1)
      }
    })

    await test.step('desktop and mobile search geometry preserves each width contract', async () => {
      await resizeDesktop(app!, 1100)
      const tray = page.getByRole('dialog', { name: 'Notifications and approvals' })
      const search = page.getByRole('textbox', { name: 'Search' })
      await expect(search).toHaveAttribute('placeholder', /Search teams, contexts…/)
      await expect(search).toHaveAttribute(
        'title',
        'Search teams, contexts, members, agents or connectors...'
      )
      const [trayBox, searchBox] = await Promise.all([bounds(tray), bounds(search)])
      expect(searchBox.width).toBeLessThanOrEqual(trayBox.width)

      await page.getByTestId('notification-bell').click()
      await resizeDesktop(app!, 901)
      const at901 = await bounds(search)
      expect(at901.width).toBeGreaterThanOrEqual(160)

      await resizeDesktop(app!, 900)
      const [mobileSearch, mobileHeader] = await Promise.all([
        bounds(search),
        bounds(page.locator('.header-left')),
      ])
      expect(Math.round(mobileSearch.width)).toBe(Math.round(mobileHeader.width))
    })

    await test.step('long return label truncates while its full name and controls remain accessible', async () => {
      await resizeDesktop(app!, 1100)
      const returnButton = page.getByRole('button', { name: `Back to ${LONG_CONVERSATION}` })
      await expect(returnButton).toHaveAttribute('title', `Back to ${LONG_CONVERSATION}`)
      const visibleLabel = returnButton.locator('span')
      const labelGeometry = await visibleLabel.evaluate(element => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      expect(labelGeometry.scrollWidth).toBeGreaterThan(labelGeometry.clientWidth)

      const controls = page.locator('.sandbox-ui-mounted-header button')
      const controlBoxes = await controls.evaluateAll(elements =>
        elements.map(element => {
          const rect = element.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        })
      )
      expect(new Set(controlBoxes.map(box => Math.round(box.y))).size).toBeGreaterThan(1)
      const searchBox = await bounds(page.getByRole('textbox', { name: 'Search' }))
      for (let index = 0; index < controlBoxes.length; index += 1) {
        assertNoIntersection(controlBoxes[index]!, searchBox)
        for (let other = index + 1; other < controlBoxes.length; other += 1) {
          assertNoIntersection(controlBoxes[index]!, controlBoxes[other]!)
        }
      }
    })
  } finally {
    await app?.close().catch(() => undefined)
    cleanupSdkWorkloadRecipe(appRecipe)
    await cleanupRecipe(approvalRecipe)
  }
})
