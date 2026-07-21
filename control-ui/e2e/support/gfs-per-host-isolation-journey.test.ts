import { type Page, expect, test } from '@playwright/test'
import { getGfsGrantSummary } from '../../../tests/e2e/gfsUiFixtures'

type PerHostIsolationJourneyInput = {
  fixture: { name: string; resourceId: string }
  page: Page
  unchangedHostSubjectIds: string[]
}

const SUBJECT_PICKER_LABEL = 'Add people, teams, agents, or workflows'
const TARGET_HOST_SEARCH = 'chatllm'
const TARGET_HOST_LABEL = 'chatllm (Stateful)'
const TARGET_HOST_SUBJECT_ID = '1st:mcp-host/chatllm'

export async function exerciseGfsPerHostIsolationJourney({
  fixture,
  page,
  unchangedHostSubjectIds,
}: PerHostIsolationJourneyInput): Promise<void> {
  await test.step('operator updates one first-party host without changing the other host grants', async () => {
    const panel = page.getByRole('dialog', {
      name: `Manage folder ${fixture.name}`,
      exact: true,
    })
    const subjectSearch = panel.getByRole('combobox', {
      name: SUBJECT_PICKER_LABEL,
    })
    await expect(subjectSearch).toBeVisible()
    await subjectSearch.fill(TARGET_HOST_SEARCH)
    const targetHost = panel.getByRole('option', { name: TARGET_HOST_LABEL, exact: true })
    await expect(targetHost).toBeVisible({ timeout: 20_000 })
    await targetHost.click()

    await panel.getByRole('button', { name: 'Permissions', exact: true }).click()
    await panel.getByRole('menuitemcheckbox', { name: 'Read', exact: true }).click()

    const grantResponsePromise = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        response.url().includes('/control-api/api/v1/gfs/grants')
    )
    await panel.getByRole('button', { name: 'Grant access', exact: true }).click()
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation).toContainText('Grant access?')
    await expect(confirmation).toContainText(/1 subject/i)
    await expect(confirmation).toContainText(/read/)
    await confirmation.getByRole('button', { name: 'Grant' }).click()

    const grantResponse = await grantResponsePromise
    expect(grantResponse.status(), `${grantResponse.url()} ${await grantResponse.text()}`).toBe(200)
    const submittedBody = grantResponse.request().postDataJSON() as {
      subject?: unknown
      subjects?: Array<{ type: string; id?: string }>
      permissions?: string[]
    }
    expect(submittedBody.subject).toBeUndefined()
    expect(submittedBody.subjects).toEqual([{ type: 'host', id: TARGET_HOST_SUBJECT_ID }])
    expect(submittedBody.permissions).toEqual(['read'])
    await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })

    await expect
      .poll(
        () =>
          getGfsGrantSummary({
            resourceId: fixture.resourceId,
            subjectType: 'host',
            subjectId: TARGET_HOST_SUBJECT_ID,
          }),
        { timeout: 15_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({
        permissions: ['read'],
        inherit: true,
        grantedBy: 'operator:',
      })

    for (const subjectId of unchangedHostSubjectIds) {
      await expect
        .poll(
          () =>
            getGfsGrantSummary({
              resourceId: fixture.resourceId,
              subjectType: 'host',
              subjectId,
            }),
          { timeout: 15_000, intervals: [250, 500, 1_000] }
        )
        .toMatchObject({
          permissions: ['read', 'write'],
          inherit: true,
          grantedBy: 'operator:',
        })
    }
  })
}
