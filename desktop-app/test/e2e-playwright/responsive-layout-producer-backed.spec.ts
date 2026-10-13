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

async function nativeSandboxViewState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) throw new Error('Desktop BrowserWindow closed')
    const view = window.contentView.children.at(-1)
    if (!view) throw new Error('Expected the producer-backed sandbox WebContentsView')
    return {
      webContentsId: view.webContents.id,
      visible: view.getVisible(),
      bounds: view.getBounds(),
      scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor,
    }
  })
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

    if (!app) throw new Error('Desktop app did not launch for responsive layout assertions')
    const page = await app.firstWindow()
    await test.step('compact navigation covers the native embed and restores its live bounds', async () => {
      await resizeDesktop(app!, 700)
      await page.evaluate(() => window.localStorage.setItem('clerum.ui.sidebarWidth', '420'))
      const savedWidthBeforeOverlay = await page.evaluate(() =>
        window.localStorage.getItem('clerum.ui.sidebarWidth')
      )
      await expect.poll(async () => (await nativeSandboxViewState(app!)).visible).toBe(true)
      const nativeViewBeforeOverlay = await nativeSandboxViewState(app!)
      const trigger = page.getByTestId('compact-navigation-toggle')
      await expect(trigger).toBeVisible()
      await expect(page.locator('.sandbox-ui-embed-slot')).toBeVisible()
      const contentBefore = await bounds(page.locator('.workspace-layout'))

      await trigger.click()
      const sidebar = page.locator('#desktop-sidebar-navigation')
      await expect(sidebar).toBeVisible()
      await expect(sidebar).toHaveClass(/compact-open/)
      await expect.poll(async () => (await nativeSandboxViewState(app!)).visible).toBe(false)
      const [sidebarBox, titlebarBox, hiddenView, contentAfter] = await Promise.all([
        bounds(sidebar),
        bounds(page.locator('.window-titlebar')),
        nativeSandboxViewState(app!),
        bounds(page.locator('.workspace-layout')),
      ])
      expect(Math.abs(sidebarBox.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(sidebarBox.y - titlebarBox.height)).toBeLessThanOrEqual(1)
      expect(Math.abs(sidebarBox.width - 700)).toBeLessThanOrEqual(2)
      expect(contentAfter.x).toBe(contentBefore.x)
      expect(contentAfter.y).toBe(contentBefore.y)
      expect(contentAfter.width).toBe(contentBefore.width)
      expect(contentAfter.height).toBe(contentBefore.height)
      expect(hiddenView.visible, 'native view must be hidden above the renderer overlay').toBe(
        false
      )
      expect(hiddenView.webContentsId).toBe(nativeViewBeforeOverlay.webContentsId)
      expect(
        await page.locator('.workspace-layout').evaluate(element => (element as HTMLElement).inert)
      ).toBe(true)
      expect(
        await page.locator('body').evaluate(element => getComputedStyle(element).overflow)
      ).toBe('hidden')

      await trigger.click()
      await expect(sidebar).not.toHaveClass(/compact-open/)
      await expect.poll(async () => (await nativeSandboxViewState(app!)).visible).toBe(true)
      expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await page.evaluate(() => window.localStorage.getItem('clerum.ui.sidebarWidth'))).toBe(
        savedWidthBeforeOverlay
      )

      const slotBox = await bounds(page.locator('.sandbox-ui-embed-slot'))
      const [restoredView, dpr] = await Promise.all([
        nativeSandboxViewState(app!),
        page.evaluate(() => window.devicePixelRatio),
      ])
      expect(restoredView.webContentsId).toBe(nativeViewBeforeOverlay.webContentsId)
      const factor = dpr / restoredView.scaleFactor
      for (const [actual, expected] of [
        [restoredView.bounds.x, slotBox.x * factor],
        [restoredView.bounds.y, slotBox.y * factor],
        [restoredView.bounds.width, slotBox.width * factor],
        [restoredView.bounds.height, slotBox.height * factor],
      ]) {
        expect(Math.abs(actual! - expected!)).toBeLessThanOrEqual(2)
      }

      await resizeDesktop(app!, 1200)
      await expect(trigger).not.toBeVisible()
      const separator = page.getByRole('separator', { name: 'Resize sidebar' })
      await expect(separator).toBeVisible()
      const desktopSidebar = page.locator('.left-nav')
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(420)
      await separator.focus()
      await separator.press('Home')
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(192)
      expect(await page.evaluate(() => window.localStorage.getItem('clerum.ui.sidebarWidth'))).toBe(
        '192'
      )

      const separatorBox = await bounds(separator)
      const startX = separatorBox.x + separatorBox.width / 2
      const startY = separatorBox.y + Math.min(120, separatorBox.height / 2)
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      await page.mouse.move(startX + 32, startY)
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(224)
      await separator.dispatchEvent('pointercancel', {
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      })
      await page.mouse.up()
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(192)
      expect(await page.evaluate(() => window.localStorage.getItem('clerum.ui.sidebarWidth'))).toBe(
        '192'
      )

      await page.mouse.move(startX, startY)
      await page.mouse.down()
      await page.mouse.move(startX + 80, startY)
      await page.mouse.up()
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(272)
      const readResizedGeometry = async () => {
        const [slot, view, devicePixelRatio] = await Promise.all([
          bounds(page.locator('.sandbox-ui-embed-slot')),
          nativeSandboxViewState(app!),
          page.evaluate(() => window.devicePixelRatio),
        ])
        const scaleFactor = devicePixelRatio / view.scaleFactor
        const matchesSlot = [
          [view.bounds.x, slot.x * scaleFactor],
          [view.bounds.y, slot.y * scaleFactor],
          [view.bounds.width, slot.width * scaleFactor],
          [view.bounds.height, slot.height * scaleFactor],
        ].every(([actual, expected]) => Math.abs(actual! - expected!) <= 2)
        return { slot, view, devicePixelRatio, matchesSlot }
      }
      await expect.poll(async () => (await readResizedGeometry()).matchesSlot).toBe(true)
      const {
        slot: resizedSlot,
        view: resizedView,
        devicePixelRatio: resizedDpr,
      } = await readResizedGeometry()
      expect(resizedView.webContentsId).toBe(nativeViewBeforeOverlay.webContentsId)
      const resizedFactor = resizedDpr / resizedView.scaleFactor
      for (const [actual, expected] of [
        [resizedView.bounds.x, resizedSlot.x * resizedFactor],
        [resizedView.bounds.y, resizedSlot.y * resizedFactor],
        [resizedView.bounds.width, resizedSlot.width * resizedFactor],
        [resizedView.bounds.height, resizedSlot.height * resizedFactor],
      ]) {
        expect(Math.abs(actual! - expected!)).toBeLessThanOrEqual(2)
      }

      await separator.focus()
      await separator.press('End')
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(460)
      await resizeDesktop(app!, 800)
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(340)
      await resizeDesktop(app!, 1200)
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(460)

      await page.getByRole('button', { name: 'Collapse sidebar' }).click()
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(74)
      await page.getByRole('button', { name: 'Expand sidebar' }).click()
      await expect.poll(async () => Math.round((await bounds(desktopSidebar)).width)).toBe(460)
      expect(await page.evaluate(() => window.localStorage.getItem('clerum.ui.sidebarWidth'))).toBe(
        '460'
      )
    })

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
      await expect(search).toHaveAttribute('placeholder', 'Search workspace...')
      await expect(search).toHaveAttribute('title', 'Search agents, connectors, plugins or apps...')
      const [trayBox, searchBox] = await Promise.all([bounds(tray), bounds(search)])
      expect(searchBox.width).toBeLessThanOrEqual(trayBox.width)

      await page.getByTestId('notification-bell').click()
      await resizeDesktop(app!, 901)
      const at901 = await bounds(search)
      // Idle above the 900px full-width breakpoint the search collapses to the
      // 40px magnifier square (it expands only on focus / open results), so the
      // bell click above must leave it collapsed rather than at its old min width.
      expect(Math.round(at901.width)).toBe(40)

      await resizeDesktop(app!, 900)
      const [mobileSearch, mobileHeader] = await Promise.all([
        bounds(search),
        bounds(page.locator('.header-left')),
      ])
      expect(Math.round(mobileSearch.width)).toBe(Math.round(mobileHeader.width))
    })

    await test.step('long return label stays accessible via the native title while title-bar actions never overlap', async () => {
      await resizeDesktop(app!, 1100)
      // Icon-only now: the full conversation name is no longer a visible text
      // span (the truncation/ellipsis invariant was retired with the max-width).
      // The complete label lives in the native `title` attribute and the
      // accessible button name — the DOM hover flyout was dropped because the
      // mounted WebContentsView composites above renderer DOM and would occlude
      // it. Resolving this button by its accessible name and asserting its title
      // is what proves the full name stays accessible; there is no [role=tooltip].
      const returnButton = page.getByRole('button', { name: `Back to ${LONG_CONVERSATION}` })
      await expect(returnButton).toHaveAttribute('title', `Back to ${LONG_CONVERSATION}`)

      // The app actions moved into the title bar's leading slot — a single row
      // now, not a wrapped header, so the old multi-row "uniqueness" check is
      // retired. What still matters: the leading actions never overlap each
      // other or the header search that shares their row (D-A3 coexistence).
      const controls = page.locator('.window-titlebar__leading button')
      const controlBoxes = await controls.evaluateAll(elements =>
        elements.map(element => {
          const rect = element.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        })
      )
      expect(controlBoxes.length, 'title-bar leading actions must be present').toBeGreaterThan(0)
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
