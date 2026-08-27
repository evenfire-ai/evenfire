// control-ui/e2e/qa-recorder-agent-files-mounted-by.spec.ts
//
// Optional QA recorder journey (READ-ONLY) for the Agent Files section's
// agent-facing mount vocabulary: the list's mount column header is
// "Mounted by" (never "Mounted by Contexts") and the detail metadata chip
// resolves mounts to agent display names ("mounted by ..." / "not mounted by
// any agent"), never a raw scope slug (scope ids look like
// "<kebab>-<5 digits>"). Ports the assertions from
// tests/e2e/playwright/control-ui/agent-files-mounted-by.spec.ts.
//
// Creates nothing: SharedFileSystem provisioning is heavy, so detail
// assertions run only against whatever already exists in the environment;
// the empty state is recorded instead when none do.
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the
// recorder").
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

type SharedFileSystemItem = {
  metadata?: { name?: string }
}

test.describe('optional QA recorder: Control UI agent files mounted-by vocabulary', () => {
  test('records the Agent Files list and detail mount vocabulary', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    // "Agent Files" is hidden from the sidebar (the Files group only exposes
    // its other children), so the section is reached directly by URL — the
    // same way a bookmarked link would.
    await page.goto(`${CONTROL_UI_URL}/agent-files`)
    await expect(
      page.getByText('Workspace volumes that agents can mount read-only into their pods.')
    ).toBeVisible({ timeout: 20_000 })

    // Branch on live data instead of seeding: with zero rows the table (and
    // its header) is not rendered at all — the empty state replaces it.
    const res = await api<{ items?: SharedFileSystemItem[] }>(
      page.request,
      'GET',
      '/api/v1/admin/shared-filesystems'
    )
    expect(res.status, `list shared filesystems: ${JSON.stringify(res.data)}`).toBeLessThan(300)
    const sfsItems = res.data.items ?? []

    if (sfsItems.length === 0) {
      await expect(page.getByText(/No SharedFileSystems yet/)).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'control-ui-agent-files-mounted-by-empty')
      return
    }

    await expect(page.locator('th:text-is("Mounted by")')).toBeVisible({ timeout: 20_000 })
    // The pre-rename header must be gone everywhere, not just hidden.
    await expect(page.locator('th:has-text("Mounted by Contexts")')).toHaveCount(0)
    await screenshotAndLog(page, testInfo, 'control-ui-agent-files-mounted-by-list')

    const firstName = sfsItems[0]?.metadata?.name ?? ''
    expect(firstName).not.toBe('')

    await page.goto(`${CONTROL_UI_URL}/agent-files/${encodeURIComponent(firstName)}`)
    const chipRow = page.locator('.cu-chip-row[aria-label="Shared filesystem metadata"]')
    await expect(chipRow).toBeVisible({ timeout: 20_000 })

    const mountChip = chipRow.locator('.cu-chip', {
      hasText: /not mounted by any agent|mounted by /u,
    })
    await expect(mountChip.first()).toBeVisible({ timeout: 20_000 })

    const chipText = (await mountChip.first().innerText()).trim()
    expect(chipText, 'mount chip must use agent-facing copy').toMatch(
      /not mounted by any agent|mounted by /u
    )
    // Raw scope slugs look like "<kebab>-<5 digits>" — the chip must never
    // leak one (unresolved scope ids are hidden by policy instead).
    expect(chipText, 'mount chip must not leak a raw scope slug').not.toMatch(/[-]\d{5}/)
    await screenshotAndLog(page, testInfo, 'control-ui-agent-files-mounted-by-detail')
  })
})
