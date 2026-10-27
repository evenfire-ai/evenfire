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
} from './support/gfs-user-home-fixtures'
import { ControlUiGrantPanel } from './support/pages/ControlUiGrantPanel'
import { ControlUiHomeInventory } from './support/pages/ControlUiHomeInventory'
import { ControlUiUserHomeBlock } from './support/pages/ControlUiUserHomeBlock'

const OWNER_BITS = ['read', 'write', 'delete', 'share', 'manage_acl']

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

async function expectVisibleReady(page: Page, path: string): Promise<void> {
  const home = page.getByRole('region', { name: 'Home folder' })
  await expect(async () => {
    const refresh = home.getByRole('button', { name: 'Refresh', exact: true })
    if (await refresh.isVisible()) await refresh.click()
    await expect(home.getByText('ready', { exact: true })).toBeVisible({ timeout: 1_000 })
    await expect(home.getByText(path, { exact: true })).toBeVisible()
  }).toPass({ timeout: 180_000, intervals: [2_000, 5_000] })
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
      await test.step('operator signs in and finds the conflict in the inventory', async () => {
        await loginControlUi(page)
        const inventory = new ControlUiHomeInventory(page)
        await inventory.open()
        await inventory.filter('conflict')
        await inventory.expectUserListed(user.id, 'conflict')
        await inventory.openUser(user.id)
        const block = page.getByRole('region', { name: 'Home folder' })
        await expect(block.getByRole('alert')).toContainText('An item was found')
        await expect(block.getByLabel('Folder name')).toHaveValue(user.name)
        const details = block.getByRole('region', { name: 'Path conflict details' })
        await expect(details.getByText(`/Users/${user.name}`, { exact: true })).toBeVisible()
        await expect(details.getByText(foreignDirectory!, { exact: true })).toBeVisible()
        await expect(details.getByText('directory', { exact: true })).toBeVisible()
      })
      const newName = `${user.name}-retry`
      await test.step('operator changes the name and retries until the home is ready', async () => {
        const block = new ControlUiUserHomeBlock(page)
        await block.retryWithName(newName)
        const home = await waitForHome(user, 'ready')
        expect(home.storageUsername).toBe(newName)
        expect(home.path).toBe(`/Users/${newName}`)
        if (!home.resourceId) throw new Error('Ready home has no resource ID')
        await expectVisibleReady(page, `/Users/${newName}`)
        await expect(page.getByTestId('home-resource-id')).toHaveText(home.resourceId)
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
        await expect(dialog.getByRole('alert')).toContainText(
          /forbidden|not authorized|not found|access|permission/i
        )
        await dialog.getByRole('button', { name: 'Close EvenDrive link dialog' }).click()
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
        const inventory = new ControlUiHomeInventory(page)
        await inventory.open()
        await inventory.filter('retired')
        await inventory.expectUserListed(owner.id, 'retired')
        const row = page
          .getByRole('row')
          .filter({ has: page.getByRole('link', { name: owner.id, exact: true }) })
        await expect(row).toContainText('Deleted user')
        await expect(row).toContainText(home.path!)
        await inventory.openUser(owner.id)
        await expect(page.getByRole('heading', { name: 'Deleted user' })).toBeVisible()
        await expect(page.getByText(`User ID: ${owner.id}`)).toBeVisible()
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

  test('Control UI guard — inventory redirects to login and works after login', async ({
    page,
  }) => {
    // E2E_GUARDIAN_NAVIGATION: negative-route-guard — inventory requires operator login
    await page.goto('/global-file-system/user-homes')
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(page.getByRole('table', { name: 'Home folders' })).toHaveCount(0)
    await loginControlUi(page)
    const inventoryResponse = page.waitForResponse(
      response =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/gfs/user-homes')
    )
    await new ControlUiHomeInventory(page).open()
    expect((await inventoryResponse).ok()).toBe(true)
  })

  test('Control UI guard — member home redirects to login and works after login', async ({
    page,
  }) => {
    const user = newHomeFixtureUser()
    try {
      createHomeFixtureUser(user)
      await waitForHome(user, 'ready')
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
      const block = new ControlUiUserHomeBlock(page)
      await block.open(user.id)
      await block.expectState('ready')
    } finally {
      await cleanupUsers(page, [user])
    }
  })
})
