import { type Page, expect, test } from '@playwright/test'
import {
  assertGfsFixtureCleaned,
  cleanupE2EUserTeamByName,
  cleanupGfsFixture,
  cleanupGfsWorkflowRecipeFixture,
  firstDataLine,
  getE2EUserId,
  getGfsGrantSummary,
  kubectlOut,
  runControlPostgresSql,
  seedE2EUserTeam,
  seedGfsDirectoryFixture,
  seedGfsWorkflowRecipeFixture,
  sqlLiteral,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import { E2E_TEST_EMAIL, E2E_TEST_NAME } from '../../../tests/e2e/testUser'
import { exerciseGfsBulkShareJourney } from './gfs-bulk-share-journey.test'
import {
  CONTROL_UI_BASE_URL,
  loginControlUi,
  openGlobalFileSystemFromSidebar,
} from './gfs-control-ui-session'
import { exerciseGfsPerHostIsolationJourney } from './gfs-per-host-isolation-journey.test'
import { exerciseGfsResourceCrudJourney } from './gfs-resource-crud-journey.test'

const SUBJECT_PICKER_LABEL = 'Add people, teams, agents, or workflows'

async function chooseGrantSubject(
  panel: ReturnType<Page['getByRole']>,
  search: string,
  optionName: string
): Promise<void> {
  const input = panel.getByRole('combobox', { name: SUBJECT_PICKER_LABEL })
  await input.fill(search)
  const option = panel.getByRole('option', { name: optionName, exact: true })
  await expect(option).toBeVisible({ timeout: 20_000 })
  await option.click()
}

async function choosePermission(
  panel: ReturnType<Page['getByRole']>,
  permissionName: string
): Promise<void> {
  const menu = panel.getByRole('menu', { name: 'Permissions' })
  if (!(await menu.isVisible().catch(() => false))) {
    await panel.getByRole('button', { name: 'Permissions', exact: true }).click()
  }
  await menu.getByRole('menuitemcheckbox', { name: permissionName, exact: true }).click()
}

export async function exerciseGfsBulkOperatorJourney(page: Page): Promise<void> {
  const targetUserId = getE2EUserId()
  const fixtureName = uniqueGfsFixtureName('e2e-gfs-operator')
  const teamName = uniqueGfsFixtureName('e2e-gfs-team')
  const workflowName = uniqueGfsFixtureName('e2e-gfs-workflow')

  try {
    const fixture = seedGfsDirectoryFixture(fixtureName)
    const targetTeam = seedE2EUserTeam(E2E_TEST_EMAIL, teamName)
    const workflowRecipe = seedGfsWorkflowRecipeFixture(workflowName)
    const grantPanel = () =>
      page.getByRole('dialog', { name: `Manage folder ${fixture.name}`, exact: true })
    const folderRow = (name: string) =>
      page
        .getByRole('list', { name: 'Current folder resources' })
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name, exact: true }) })
        .first()

    await test.step('operator logs in and navigates to Global File System through the sidebar', async () => {
      await loginControlUi(page)
      await openGlobalFileSystemFromSidebar(page)
      await expect(page).toHaveURL(/\/global-file-system(?:$|\?)/, { timeout: 15_000 })
      await expect(page.getByRole('region', { name: 'Global File System browser' })).toBeVisible()
    })

    await exerciseGfsResourceCrudJourney({
      baseUi: CONTROL_UI_BASE_URL,
      fixture,
      folderRow,
      page,
    })
    await test.step('operator selects a mixed user, team, and per-runtime host batch through the visible picker', async () => {
      const panel = grantPanel()
      await expect(panel).toBeVisible()
      await expect(panel.getByLabel('Subject ID')).toHaveCount(0)
      await expect(panel.getByRole('checkbox', { name: 'Include descendants' })).toBeChecked()

      await chooseGrantSubject(panel, E2E_TEST_EMAIL, E2E_TEST_NAME)
      await chooseGrantSubject(panel, targetTeam.name, targetTeam.name)
      const selectedSubjects = panel.getByLabel('Grant subject', { exact: true })
      await expect(selectedSubjects).toContainText(E2E_TEST_NAME)
      await expect(selectedSubjects).toContainText(targetTeam.name)

      await choosePermission(panel, 'Manage access')
      await choosePermission(panel, 'Share')
      await chooseGrantSubject(panel, 'chatllm', 'chatllm (Stateful)')
      await chooseGrantSubject(panel, 'chatllm-stateless', 'chatllm-stateless (Stateless)')
      await expect(selectedSubjects).toContainText('chatllm (Stateful)')
      await expect(selectedSubjects).toContainText('chatllm-stateless (Stateless)')
      await expect(panel.getByText(/host selections are limited to read and write/i)).toBeVisible()

      await panel.getByRole('button', { name: 'Permissions', exact: true }).click()
      const permissionMenu = panel.getByRole('menu', { name: 'Permissions' })
      await expect(
        permissionMenu.getByRole('menuitemcheckbox', { name: 'Manage access' })
      ).toHaveCount(0)
      await expect(permissionMenu.getByRole('menuitemcheckbox', { name: 'Share' })).toHaveCount(0)
      await expect(permissionMenu.getByRole('menuitemcheckbox', { name: 'Delete' })).toHaveCount(0)
      await expect(panel.getByRole('button', { name: 'Create share', exact: true })).toBeDisabled()

      await chooseGrantSubject(panel, workflowRecipe.name, workflowRecipe.name)
      await expect(selectedSubjects).toContainText(workflowRecipe.name)
      await expect(selectedSubjects.getByRole('button', { name: /^Remove / })).toHaveCount(5)
      await choosePermission(panel, 'Read')
      await choosePermission(panel, 'Write')
    })

    await test.step('operator confirms one atomic bulk grant and sees persisted access', async () => {
      const panel = grantPanel()
      const grantResponsePromise = page.waitForResponse(
        response =>
          response.request().method() === 'PUT' &&
          response.url().includes('/control-api/api/v1/gfs/grants')
      )
      await panel.getByRole('button', { name: 'Grant access', exact: true }).click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toContainText('Grant access?')
      await expect(dialog).toContainText(fixture.name)
      await expect(dialog).toContainText(/5 subjects/i)
      await expect(dialog).toContainText(/read, write/)
      await dialog.getByRole('button', { name: 'Grant' }).click()
      const grantResponse = await grantResponsePromise
      expect(grantResponse.status(), `${grantResponse.url()} ${await grantResponse.text()}`).toBe(
        200
      )

      const submittedBody = grantResponse.request().postDataJSON() as {
        subject?: unknown
        subjects?: Array<{ type: string; id?: string }>
        permissions?: string[]
      }
      const expectedSubjects = [
        { type: 'user', id: targetUserId },
        { type: 'team', id: targetTeam.id },
        { type: 'host', id: '1st:mcp-host/chatllm' },
        { type: 'host', id: '1st:mcp-host/chatllm-stateless' },
        { type: 'host', id: workflowRecipe.subjectId },
      ] as const
      expect(submittedBody.subject).toBeUndefined()
      expect(submittedBody.subjects).toEqual(expectedSubjects)
      expect(submittedBody.permissions).toEqual(['read', 'write'])
      await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })

      for (const subject of expectedSubjects) {
        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: fixture.resourceId,
                subjectType: subject.type,
                subjectId: subject.id,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read', 'write'],
            inherit: true,
            grantedBy: 'operator:',
          })
      }
      expect(
        getGfsGrantSummary({
          resourceId: fixture.resourceId,
          subjectType: 'host',
          subjectId: '1st:mcp-host/standalone',
        })
      ).toBeNull()
    })

    await test.step('closing and reopening the modal rehydrates persisted access and allows revocation', async () => {
      const panel = grantPanel()
      await panel.getByRole('button', { name: 'Close manage dialog' }).click()
      await expect(panel).toHaveCount(0)

      await page.reload()
      await expect(page).toHaveURL(/\/global-file-system(?:$|\?)/, { timeout: 15_000 })
      await expect(page.getByRole('region', { name: 'Global File System browser' })).toBeVisible()
      const row = folderRow(fixture.name)
      await expect(row).toBeVisible({ timeout: 20_000 })
      await row.getByRole('button', { name: `Actions for ${fixture.name}` }).click()
      await page.getByRole('menuitem', { name: 'Manage access' }).click()
      const reopenedPanel = grantPanel()
      await expect(reopenedPanel).toBeVisible()
      const existingAccess = reopenedPanel.getByRole('region', { name: 'Existing access' })
      await expect(existingAccess.getByText(E2E_TEST_NAME, { exact: true })).toBeVisible()
      await expect(existingAccess.getByText(targetTeam.name, { exact: true })).toBeVisible()
      await expect(existingAccess.getByText('chatllm (Stateful)', { exact: true })).toBeVisible()
      await expect(
        existingAccess.getByText('chatllm-stateless (Stateless)', { exact: true })
      ).toBeVisible()
      await expect(existingAccess.getByText(workflowRecipe.name, { exact: true })).toBeVisible()
      await expect(
        existingAccess.getByText('Grant · read, write · resource and descendants')
      ).toHaveCount(5)

      const revokeResponsePromise = page.waitForResponse(
        response =>
          response.request().method() === 'DELETE' &&
          response.url().includes('/control-api/api/v1/gfs/grants/')
      )
      await existingAccess
        .getByRole('button', { name: `Remove grant access for ${E2E_TEST_NAME}` })
        .click()
      const confirmation = page.getByRole('alertdialog')
      await expect(confirmation).toContainText('Remove access?')
      await confirmation.getByRole('button', { name: 'Remove access' }).click()
      const revokeResponse = await revokeResponsePromise
      expect(
        revokeResponse.status(),
        `${revokeResponse.url()} ${await revokeResponse.text()}`
      ).toBe(200)
      await expect(page.getByText('Access removed.').last()).toBeVisible({ timeout: 15_000 })
      await expect(existingAccess.getByText(E2E_TEST_NAME, { exact: true })).toHaveCount(0)
      await expect
        .poll(
          () =>
            getGfsGrantSummary({
              resourceId: fixture.resourceId,
              subjectType: 'user',
              subjectId: targetUserId,
            }),
          { timeout: 15_000, intervals: [250, 500, 1_000] }
        )
        .toBeNull()
    })

    await exerciseGfsPerHostIsolationJourney({
      fixture,
      page,
      unchangedHostSubjectIds: ['1st:mcp-host/chatllm-stateless', workflowRecipe.subjectId],
    })
    await exerciseGfsBulkShareJourney({
      fixture,
      page,
      targetTeam,
      targetUserEmail: E2E_TEST_EMAIL,
      targetUserId,
    })

    await test.step('operator remains a distinct singular grant target', async () => {
      const panel = grantPanel()
      await chooseGrantSubject(panel, 'Operator', 'Operator')
      await expect(panel.getByRole('button', { name: 'Remove Operator' })).toBeVisible()
      await choosePermission(panel, 'Read')
      await panel.getByRole('button', { name: 'Grant access', exact: true }).click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toContainText('Grant access?')
      await expect(dialog).toContainText(/operator/i)
      await dialog.getByRole('button', { name: 'Grant' }).click()
      await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(
          () =>
            getGfsGrantSummary({
              resourceId: fixture.resourceId,
              subjectType: 'operator',
            }),
          { timeout: 15_000, intervals: [250, 500, 1_000] }
        )
        .toMatchObject({ permissions: ['read'], inherit: true, grantedBy: 'operator:' })
    })

    await test.step('operator cannot submit without visible subject and permissions', async () => {
      const panel = grantPanel()
      await expect(panel.getByLabel('Subject ID')).toHaveCount(0)
      await expect(panel.getByRole('button', { name: 'Grant access', exact: true })).toBeDisabled()
      await panel.getByRole('combobox', { name: SUBJECT_PICKER_LABEL }).fill('not-a-uuid')
      await expect(panel.getByText('No subjects found.')).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Grant access', exact: true })).toBeDisabled()
    })
  } finally {
    try {
      cleanupGfsWorkflowRecipeFixture(workflowName)
      expect(
        kubectlOut([
          '-n',
          'sandbox-recipes',
          'get',
          'workflowrecipe',
          workflowName,
          '--ignore-not-found=true',
          '-o',
          'name',
        ]).trim()
      ).toBe('')
    } finally {
      try {
        cleanupGfsFixture(fixtureName)
        assertGfsFixtureCleaned(fixtureName)
      } finally {
        cleanupE2EUserTeamByName(teamName)
        expect(
          firstDataLine(
            runControlPostgresSql(
              `SELECT COUNT(*)::text FROM teams WHERE name = ${sqlLiteral(teamName)};`
            )
          )
        ).toBe('0')
      }
    }
  }
}
