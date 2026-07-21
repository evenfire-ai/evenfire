import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only inventory/navigation journey: open the External Channels page from
// the sidebar and assert the channels shell renders. The sidebar label
// 'External Channels' links to CONTROL_ROUTES.externalChannels.root
// ('/external-channels'); next.config.js transparently rewrites that to the
// 'communication-channels' app route, so the browser URL stays
// '/external-channels'. The page shell (TablePanelHeader title + subtitle)
// renders for every state (loading skeleton, empty 'No resources found.', or a
// populated Telegram/Slack/Teams table), so those headings are the resilient
// assertions rather than table contents.
test.describe('optional QA recorder: Control UI external channels journey', () => {
  test('optional QA recorder: Control UI external channels (telegram/email/slack) journey', async ({
    page,
  }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    await page.getByRole('link', { name: 'External Channels', exact: true }).click()

    // The canonical public URL is '/external-channels' (confirmed via the
    // next.config.js rewrite); assert it landed there.
    await expect(page).toHaveURL(/\/external-channels$/, { timeout: 20_000 })

    // Page shell: the TablePanelHeader title (rendered in '.cu-panel-title')
    // reads 'Communication channels' while loading/empty and
    // 'Communication channels (N)' once the list resolves. The subtitle is
    // stable regardless of data volume.
    const panelTitle = page.locator('.cu-panel-title')
    await expect(panelTitle).toContainText('Communication channels', { timeout: 20_000 })
    await expect(page.getByText('Route channel messages to the selected agent.')).toBeVisible()

    await screenshotAndLog(page, testInfo, 'control-ui-external-channels')
  })
})
