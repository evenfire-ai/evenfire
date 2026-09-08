/**
 * Control UI — Agent Files "Mounted by" column tests
 *
 * The Agent Files list and detail pages must speak agent-facing vocabulary:
 * the mount column is "Mounted by" (never "Mounted by Contexts") and the
 * detail metadata chip resolves mounts to agent display names, never a raw
 * context slug (context ids look like "<kebab>-<5 digits>").
 *
 * Read-only: it never creates a SharedFileSystem (PVC provisioning is heavy);
 * detail assertions run only against whatever SFS already exists.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

type SharedFileSystemItem = {
  metadata?: { name?: string }
}

test.describe('Control UI — Agent Files — Mounted by', () => {
  test('list shows the "Mounted by" column header and the agent-facing subtitle', async ({
    authedPage,
  }) => {
    await authedPage.goto('/agent-files')

    await expect(
      authedPage.getByText('Workspace volumes that agents can mount read-only into their pods.')
    ).toBeVisible({ timeout: 15_000 })

    // With zero rows the table (and its header) is not rendered at all — the
    // empty state replaces it. Branch on live data instead of seeding an SFS.
    const { items } = await controlApi.getSharedFileSystems()
    const sfsItems = (items ?? []) as SharedFileSystemItem[]

    if (sfsItems.length === 0) {
      await expect(authedPage.getByText(/No SharedFileSystems yet/)).toBeVisible()
      await expect(authedPage.locator('th:text-is("Mounted by")')).toHaveCount(0)
      return
    }

    await expect(authedPage.locator('th:text-is("Mounted by")')).toBeVisible()
    // The pre-rename header must be gone everywhere, not just hidden.
    await expect(authedPage.locator('th:has-text("Mounted by Contexts")')).toHaveCount(0)
  })

  test('detail metadata chip shows agent-facing mount copy, not a raw context slug', async ({
    authedPage,
  }) => {
    const { items } = await controlApi.getSharedFileSystems()
    const sfsItems = (items ?? []) as SharedFileSystemItem[]
    test.skip(sfsItems.length === 0, 'no SharedFileSystem exists to inspect (creation is heavy)')

    const firstName = sfsItems[0]?.metadata?.name ?? ''
    expect(firstName).not.toBe('')

    await authedPage.goto(`/agent-files/${encodeURIComponent(firstName)}`)
    const chipRow = authedPage.locator('.cu-chip-row[aria-label="Shared filesystem metadata"]')
    await expect(chipRow).toBeVisible({ timeout: 15_000 })

    const mountChip = chipRow.locator('.cu-chip', {
      hasText: /not mounted by any agent|mounted by /u,
    })
    await expect(mountChip.first()).toBeVisible()

    const chipText = (await mountChip.first().innerText()).trim()
    expect(chipText, 'mount chip must use agent-facing copy').toMatch(
      /not mounted by any agent|mounted by /u
    )
    // Raw context slugs look like "<kebab>-<5 digits>" — the chip must never
    // leak one (unresolved scope ids are hidden by policy instead).
    expect(chipText, 'mount chip must not leak a raw context slug').not.toMatch(/[-]\d{5}/)
  })
})
