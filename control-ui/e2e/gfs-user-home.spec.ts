import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import {
  discoverManagedGfsAgent,
  getManagedAgentDisplayName,
} from '../../desktop-app/test/e2e-playwright/helpers/gfsAgentDiscovery'
import {
  addE2EUserToTeam,
  cleanupE2EUserTeam,
  cleanupGfsFixture,
  kubectlOut,
  seedE2EUserTeam,
  seedGfsFileFixture,
  uniqueGfsFixtureName,
} from '../../tests/e2e/gfsUiFixtures'
import { loginControlUi } from './support/gfs-control-ui-session'
import {
  launchHomeDesktop,
  openDesktopHome,
  openDesktopLink,
  readWithAgent,
  shareDesktopFolder,
  uploadDesktopFile,
} from './support/gfs-user-home-desktop'
import {
  type HomeFixtureUser,
  assertAgentAssociation,
  associateFixtureAgent,
  createForeignHomeDirectory,
  createHomeFixtureUser,
  deleteHomeFixtureUser,
  getExistingAgentAssociation,
  newHomeFixtureUser,
  nonOperatorAccessCount,
  readHome,
  readHomeGrant,
  removeForeignHomeDirectory,
  resourceIdAtPath,
  userAccessOnUsersFolder,
} from './support/gfs-user-home-fixtures'
import { ControlUiGrantPanel } from './support/pages/ControlUiGrantPanel'
import { ControlUiUserHomeBlock } from './support/pages/ControlUiUserHomeBlock'

const OWNER_BITS = ['read', 'write', 'delete', 'share', 'manage_acl']
// `ANCESTOR_HOME_EXPOSURE_MESSAGE` in components/GfsGrantPanel.tsx.
const ANCESTOR_HOME_EXPOSURE_MESSAGE =
  'Only operators can have access on the drive root or /Users. Choose a sub-folder for this access.'

async function waitForHome(
  user: HomeFixtureUser,
  state: 'ready' | 'conflict',
  conflictCode?: string
) {
  await expect
    .poll(() => readHome(user.id), {
      timeout: 180_000,
      intervals: [1_000, 2_000, 5_000],
      message: `Waiting for ${user.id} home to become ${state}`,
    })
    .toMatchObject({ state, ...(conflictCode ? { conflictCode } : {}) })
  const home = readHome(user.id)
  if (!home) throw new Error('The fixture home disappeared')
  return home
}

async function expectOwnerGrant(resourceId: string, userId: string): Promise<void> {
  await expect
    .poll(() => readHomeGrant(resourceId, 'user', userId), { timeout: 30_000 })
    .toMatchObject({
      permissions: expect.arrayContaining(OWNER_BITS),
      inherit: true,
    })
  expect(readHomeGrant(resourceId, 'user', userId)?.permissions).toHaveLength(5)
}

/**
 * D47: after Retry the block polls the pending home by itself (every 5 s for
 * 60 s) and shows `ready` without Refresh. The reconciler ticks every 60 s
 * (`gfsUserHomeReconciler.ts` PERIOD_MS), so the database can turn ready only
 * after that window; then "Still pending" with Refresh is the designed state,
 * accepted only when the database really turned ready late.
 */
async function expectReadyAfterRetry(
  page: Page,
  path: string,
  readyAfterMs: number
): Promise<void> {
  const home = page.getByRole('region', { name: 'Home folder' })
  await expect(
    home.getByText(path, { exact: true }).or(home.getByText('Still pending', { exact: true }))
  ).toBeVisible({ timeout: 90_000 })
  const stillPending = home.getByText('Still pending', { exact: true })
  if ((await stillPending.count()) > 0) {
    expect(readyAfterMs, 'polling stopped although the home was ready in time').toBeGreaterThan(
      50_000
    )
    test.info().annotations.push({
      type: 'D47',
      description: `polling window expired; database ready after ${readyAfterMs} ms`,
    })
    await home.getByRole('button', { name: 'Refresh', exact: true }).click()
  } else {
    test.info().annotations.push({
      type: 'D47',
      description: `ready by polling; database ready after ${readyAfterMs} ms`,
    })
  }
  await expect(home.getByText(path, { exact: true })).toBeVisible()
  await expect(home.locator('.cu-banner--warn[role="status"]')).toHaveCount(0)
}

async function cleanupUsers(
  page: Page,
  users: HomeFixtureUser[],
  beforeDelete?: () => void
): Promise<void> {
  await loginControlUi(page)
  for (const user of users) {
    beforeDelete?.()
    await deleteHomeFixtureUser(page, user)
  }
}

test.describe('Per-user GFS homes — Control UI', () => {
  test.setTimeout(1_200_000)

  test('J7 — operator retries a path conflict and the user opens the new home', async ({
    page,
  }) => {
    const user = newHomeFixtureUser()
    let foreignDirectory: string | undefined
    let desktop: ElectronApplication | undefined
    try {
      await test.step('prepare a foreign directory before creating the member', async () => {
        foreignDirectory = createForeignHomeDirectory(user)
        createHomeFixtureUser(user)
        await waitForHome(user, 'conflict', 'path_conflict')
      })
      await test.step('operator signs in and opens the member with the conflict', async () => {
        await loginControlUi(page)
        await new ControlUiUserHomeBlock(page).open(user.id)
        const block = page.getByRole('region', { name: 'Home folder' })
        await expect(block.getByRole('status')).toContainText('An item was found')
        await expect(block.getByText('Not created', { exact: true })).toBeVisible()
        // The new name is chosen in a dialog, never edited inline on the Contact tab.
        await expect(block.getByLabel('Folder name')).toHaveCount(0)
        const guidance = block.getByRole('region', { name: 'Path conflict recovery' })
        await expect(guidance).toContainText(`Another item occupies /Users/${user.name}.`)
        await expect(guidance).toContainText('rename or move it in EvenDrive, then press Retry')
        await expect(guidance).toContainText('Retry with another name')
        const details = block.getByRole('region', { name: 'Path conflict details' })
        await expect(
          details.getByText(`Conflicting directory: /Users/${user.name}`, { exact: true })
        ).toBeVisible()
        // No internal identifiers on the operator surface.
        await expect(block.getByText(foreignDirectory!)).toHaveCount(0)
      })
      const newName = `${user.name}-retry`
      await test.step('operator changes the name and retries; the block turns ready by itself', async () => {
        const block = new ControlUiUserHomeBlock(page)
        const region = page.getByRole('region', { name: 'Home folder' })
        // React does not own this attribute, so a remount of the block drops it.
        await region.evaluate(element => element.setAttribute('data-e2e-block', 'before-retry'))
        await block.retryWithName(newName)
        const retriedAt = Date.now()
        const home = await waitForHome(user, 'ready')
        const readyAfterMs = Date.now() - retriedAt
        expect(home.storageUsername).toBe(newName)
        expect(home.path).toBe(`/Users/${newName}`)
        if (!home.resourceId) throw new Error('Ready home has no resource ID')
        await expectReadyAfterRetry(page, `/Users/${newName}`, readyAfterMs)
        await expect(region).toHaveAttribute('data-e2e-block', 'before-retry')
        await expectOwnerGrant(home.resourceId, user.id)
        await expect(
          page
            .getByRole('region', { name: 'Home folder' })
            .getByRole('button', { name: 'Retry', exact: true })
        ).toHaveCount(0)
      })
      await test.step('member opens My home at the new path in Desktop', async () => {
        const session = await launchHomeDesktop(user)
        desktop = session.app
        await openDesktopHome(session.page, newName)
      })
    } finally {
      if (desktop) await desktop.close()
      await cleanupUsers(page, [user])
      if (foreignDirectory) removeForeignHomeDirectory(user, foreignDirectory)
    }
  })

  test('J7 — operator restores a revoked owner grant', async ({ page }) => {
    const user = newHomeFixtureUser()
    try {
      createHomeFixtureUser(user)
      const home = await waitForHome(user, 'ready')
      if (!home.resourceId || !home.path)
        throw new Error('Ready home is missing its resource or path')
      await expectOwnerGrant(home.resourceId, user.id)
      await loginControlUi(page)
      await test.step('operator revokes the owner grant through the access panel', async () => {
        const panel = new ControlUiGrantPanel(page)
        await panel.openResource(home.path!)
        await panel.expectRow(user.name, 'Editor')
        await panel.revoke(user.name)
        await expect
          .poll(() => readHome(user.id), { timeout: 30_000 })
          .toMatchObject({ state: 'conflict', conflictCode: 'ownership_conflict' })
        expect(readHomeGrant(home.resourceId!, 'user', user.id)).toBeNull()
      })
      await test.step('operator restores the owner access from the member detail', async () => {
        const block = new ControlUiUserHomeBlock(page)
        await block.open(user.id)
        await block.expectState('conflict', home.path!)
        const region = page.getByRole('region', { name: 'Home folder' })
        await expect(region.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
        await expect(region.getByRole('button', { name: 'Restore owner access' })).toBeVisible()
        await expect(
          region.getByRole('region', { name: 'Owner access conflict details' })
        ).toContainText('The owner grant is missing.')
        await block.restoreOwner()
        await expectOwnerGrant(home.resourceId!, user.id)
      })
    } finally {
      await cleanupUsers(page, [user])
    }
  })

  test('/Users cannot be shared with a member; the member home can (D45)', async ({ page }) => {
    const owner = newHomeFixtureUser()
    const member = newHomeFixtureUser()
    const users = [owner, member]
    try {
      createHomeFixtureUser(owner)
      createHomeFixtureUser(member)
      const home = await waitForHome(owner, 'ready')
      if (!home.resourceId || !home.path)
        throw new Error('Ready home is missing its resource or path')
      await loginControlUi(page)
      const panel = new ControlUiGrantPanel(page)
      await test.step('sharing /Users with the member is refused with the operator-only message', async () => {
        await panel.openResource('/Users')
        await panel.grantRefused(member.name, 'Read', 409, ANCESTOR_HOME_EXPOSURE_MESSAGE)
        expect(userAccessOnUsersFolder(member.id)).toBe(0)
        await panel.close()
      })
      await test.step('the same member gets Read on the owner home (positive)', async () => {
        await panel.openResource(home.path!)
        await panel.grant(member.name, 'Read')
        await expect
          .poll(() => readHomeGrant(home.resourceId!, 'user', member.id))
          .toMatchObject({ permissions: expect.arrayContaining(['read']), inherit: true })
        expect(userAccessOnUsersFolder(member.id)).toBe(0)
      })
    } finally {
      await cleanupUsers(page, users)
    }
  })

  test('J8 — retirement preserves the file for operators and removes member and agent access', async ({
    page,
  }) => {
    const owner = newHomeFixtureUser()
    const member = newHomeFixtureUser()
    const recipient = newHomeFixtureUser()
    const users = [owner, member, recipient]
    const agent = discoverManagedGfsAgent()
    const association = getExistingAgentAssociation(agent.name)
    const agentDisplay = getManagedAgentDisplayName(agent)
    const hostsNamespace = kubectlOut([
      '-n',
      'control-plane',
      'get',
      'configmap',
      'control-api-config',
      '-o',
      'jsonpath={.data.CONTROL_API_HOSTS_NAMESPACE}',
    ]).trim()
    if (!hostsNamespace || agent.namespace !== hostsNamespace) {
      throw new Error('The selected agent is not in the configured first-party host namespace')
    }
    const stateless = kubectlOut([
      '-n',
      agent.namespace,
      'get',
      'host',
      agent.name,
      '-o',
      'jsonpath={.spec.lifecycle.stateless}',
    ]).trim()
    if (!['', 'true', 'false'].includes(stateless)) throw new Error('Agent lifecycle is invalid')
    const operatorAgentLabel = `${agent.name} (${stateless === 'true' ? 'Stateless' : 'Stateful'})`
    const controlName = uniqueGfsFixtureName('e2e-gfs-home-control')
    let teamId: string | undefined
    let controlCreated = false
    const apps: ElectronApplication[] = []
    try {
      for (const user of users) createHomeFixtureUser(user)
      const team = seedE2EUserTeam(owner.email, uniqueGfsFixtureName('e2e-gfs-home-team'))
      teamId = team.id
      addE2EUserToTeam(member.email, team.id)
      addE2EUserToTeam(recipient.email, team.id)
      associateFixtureAgent(owner, agent.name)
      associateFixtureAgent(member, agent.name)
      const control = seedGfsFileFixture(controlName)
      controlCreated = true
      await loginControlUi(page)
      await new ControlUiGrantPanel(page).openResource(`/${control.name}/${control.fileName}`)
      await new ControlUiGrantPanel(page).grant(operatorAgentLabel, 'Read')
      await expect
        .poll(() => readHomeGrant(control.fileResourceId, 'host', agent.subjectId))
        .toMatchObject({ permissions: ['read'] })
      const home = await waitForHome(owner, 'ready')
      await waitForHome(member, 'ready')
      await waitForHome(recipient, 'ready')
      if (!home.resourceId || !home.path)
        throw new Error('Ready home is missing its resource or path')
      const fileName = `e2e-gfs-${randomBytes(8).toString('hex')}.txt`
      const sentinel = `Home retirement sentinel ${randomBytes(16).toString('hex')}`
      const filePath = `${home.path}/${fileName}`
      let fileId = ''
      let fileUri = ''
      const controlSentinel = `E2E GFS file fixture: ${controlName}`

      await test.step('owner creates a file and shares the home with the member and agent', async () => {
        const session = await launchHomeDesktop(owner)
        apps.push(session.app)
        await openDesktopHome(session.page, owner.name)
        await uploadDesktopFile(session.page, fileName, sentinel)
        fileId = resourceIdAtPath(filePath)
        fileUri = `gfs://main/${fileId.replace(/-/g, '')}`
        await shareDesktopFolder(session.page, owner.name, member.name)
        await shareDesktopFolder(session.page, owner.name, agent.name)
        await expect
          .poll(() => readHomeGrant(home.resourceId!, 'user', member.id))
          .toMatchObject({ permissions: expect.arrayContaining(['read']), inherit: true })
        await expect
          .poll(() => readHomeGrant(home.resourceId!, 'host', agent.subjectId))
          .toMatchObject({ permissions: expect.arrayContaining(['read']), inherit: true })
      })

      const memberSession = await launchHomeDesktop(member)
      apps.push(memberSession.app)
      await test.step('member and agent read the file before retirement', async () => {
        await openDesktopLink(memberSession.page, fileUri)
        await expect(
          memberSession.page.getByRole('article', { name: `Text preview of ${fileName}` })
        ).toContainText(sentinel)
        await readWithAgent(memberSession.page, agentDisplay, fileUri, sentinel, true)
      })
      await test.step('operator deletes the owner using the existing account flow', async () => {
        await loginControlUi(page)
        const block = new ControlUiUserHomeBlock(page)
        await block.open(owner.id)
        await block.expectState('ready', home.path!)
        assertAgentAssociation(agent.name, association)
        await block.deleteUser()
        await expect
          .poll(() => readHome(owner.id))
          .toMatchObject({ state: 'retired', resourceId: home.resourceId })
        await expect.poll(() => nonOperatorAccessCount(home.resourceId!)).toBe(0)
      })
      await test.step('member is refused while their own home still opens', async () => {
        await openDesktopLink(memberSession.page, fileUri)
        const dialog = memberSession.page.getByRole('dialog', { name: 'Open EvenDrive link' })
        await expect(
          dialog.getByText('403 Forbidden: forbidden: not authorized to read this resource', {
            exact: true,
          })
        ).toBeVisible()
        await dialog.getByRole('button', { name: 'Close EvenDrive link dialog' }).click()
        await expect(dialog).toBeHidden()
        await openDesktopHome(memberSession.page, member.name)
      })
      await test.step('agent is refused on the retired home and reads an independent control file', async () => {
        await readWithAgent(memberSession.page, agentDisplay, fileUri, sentinel, false)
        await readWithAgent(
          memberSession.page,
          agentDisplay,
          control.fileUri,
          controlSentinel,
          true
        )
      })
      await test.step('operator reads the retained file and grants another member access', async () => {
        const panel = new ControlUiGrantPanel(page)
        await panel.openFile(filePath)
        await expect(
          page.getByRole('article', { name: `Text preview of ${fileName}` })
        ).toContainText(sentinel)
        await page
          .getByRole('dialog', { name: fileName })
          .getByRole('button', { name: 'Close preview' })
          .click()
        await panel.openResource(home.path!)
        await panel.grant(recipient.name, 'Read')
        await expect
          .poll(() => readHomeGrant(home.resourceId!, 'user', recipient.id))
          .toMatchObject({ permissions: expect.arrayContaining(['read']), inherit: true })
      })
      await test.step('the newly authorized member reads the retained file', async () => {
        const session = await launchHomeDesktop(recipient)
        apps.push(session.app)
        await openDesktopLink(session.page, fileUri)
        await expect(
          session.page.getByRole('article', { name: `Text preview of ${fileName}` })
        ).toContainText(sentinel)
      })
    } finally {
      for (const app of apps) await app.close()
      await cleanupUsers(page, users, () => assertAgentAssociation(agent.name, association))
      if (teamId) cleanupE2EUserTeam(teamId)
      if (controlCreated) cleanupGfsFixture(controlName)
    }
  })

  test('Control UI guard — member home redirects to login and works after login', async ({
    page,
  }) => {
    const user = newHomeFixtureUser()
    try {
      createHomeFixtureUser(user)
      const home = await waitForHome(user, 'ready')
      const userId = user.id
      // E2E_GUARDIAN_NAVIGATION: negative-route-guard — member home requires operator login
      await page.goto(
        `/users-and-teams/users/${
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(userId)?.[0] ??
          (() => {
            throw new Error('Invalid user ID')
          })()
        }`
      )
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Home folder' })).toHaveCount(0)
      await loginControlUi(page)
      const homeResponse = page.waitForResponse(
        response =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname.endsWith(`/gfs/user-homes/${user.id}`)
      )
      const block = new ControlUiUserHomeBlock(page)
      await block.open(user.id)
      const loaded = await homeResponse
      expect(loaded.status()).toBe(200)
      expect(((await loaded.json()) as { home: { state: string } }).home.state).toBe('ready')
      await block.expectState('ready', home.path!)
    } finally {
      await cleanupUsers(page, [user])
    }
  })
})
