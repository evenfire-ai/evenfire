import { type Page, expect, test } from '@playwright/test'
import { getGfsShareSummary } from '../../../tests/e2e/gfsUiFixtures'

type BulkShareJourneyInput = {
  fixture: { name: string; resourceId: string }
  page: Page
  targetTeam: { id: string; name: string }
  targetUserEmail: string
  targetUserId: string
}

export async function exerciseGfsBulkShareJourney({
  fixture,
  page,
  targetTeam,
  targetUserEmail,
  targetUserId,
}: BulkShareJourneyInput): Promise<void> {
  await test.step('operator creates one persisted user/team bulk share through the visible UI', async () => {
    const panel = page.getByRole('dialog', {
      name: `Manage folder ${fixture.name}`,
      exact: true,
    })
    const subjectSearch = panel.getByRole('combobox', {
      name: 'Add people, teams, agents, or workflows',
    })
    await expect(subjectSearch).toBeVisible()
    await subjectSearch.fill(targetUserEmail)
    await panel.getByRole('option').filter({ hasText: targetUserEmail }).first().click()
    await subjectSearch.fill(targetTeam.name)
    await panel.getByRole('option', { name: targetTeam.name, exact: true }).click()

    await panel.getByRole('button', { name: 'Permissions', exact: true }).click()
    await panel.getByRole('menuitemcheckbox', { name: 'Read', exact: true }).click()
    const shareResponsePromise = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().includes('/control-api/api/v1/gfs/shares')
    )
    await panel.getByRole('button', { name: 'Create share', exact: true }).click()
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation).toContainText('Create share?')
    await expect(confirmation).toContainText(/2 subjects/i)
    await expect(confirmation).toContainText(/read/)
    await confirmation.getByRole('button', { name: 'Create share' }).click()

    const shareResponse = await shareResponsePromise
    expect(shareResponse.status(), `${shareResponse.url()} ${await shareResponse.text()}`).toBe(200)
    const submittedBody = shareResponse.request().postDataJSON() as {
      subject?: unknown
      subjects?: Array<{ type: string; id?: string }>
      permissions?: string[]
    }
    expect(submittedBody.subject).toBeUndefined()
    expect(submittedBody.subjects).toEqual([
      { type: 'user', id: targetUserId },
      { type: 'team', id: targetTeam.id },
    ])
    expect(submittedBody.permissions).toEqual(['read'])
    await expect(page.getByText('Share created.').last()).toBeVisible({ timeout: 15_000 })

    for (const subject of [
      { type: 'user' as const, id: targetUserId },
      { type: 'team' as const, id: targetTeam.id },
    ]) {
      await expect
        .poll(
          () =>
            getGfsShareSummary({
              resourceId: fixture.resourceId,
              subjectType: subject.type,
              subjectId: subject.id,
            }),
          { timeout: 15_000, intervals: [250, 500, 1_000] }
        )
        .toMatchObject({ permissions: ['read'], includeDescendants: true, createdBy: 'operator:' })
    }
  })
}
