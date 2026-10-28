// E2E_GUARDIAN_IPC_FLOW: Desktop Files, home and share transitions are brokered through Electron IPC; every step asserts the persisted signal.
/**
 * E2E — per-user GFS homes (#1168), Desktop journeys J1, J1b, J2, J3, J4, J6
 * and the Desktop access guards, following the plan's §5.5 contract table.
 * J5 (linked operator) needs the one-shot operator bootstrap and therefore
 * belongs to the operator-parity lane; it is not part of this file.
 *
 * Contract (e2e-test-guardian):
 *  - Entry is always a visible Desktop login of a per-test user created by a
 *    named precondition; homes and owner grants are never seeded — each
 *    journey consumes automatic provisioning.
 *  - Every grant/share under test is created, changed and removed through the
 *    Share dialog; SQL is used only for named preconditions and for reading
 *    business signals (gfs_user_homes, gfs_grants, gfs_shares).
 *  - Each negative has a same-test positive on the same resource.
 *  - Agent denials are observed authorization refusals (no successful
 *    gfs_read, no sentinel leak), never timeouts.
 *  - Credentials are generated at runtime and kept in memory only.
 */
import {
  type ElectronApplication,
  type Page,
  type TestInfo,
  _electron as electron,
} from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ridOf, runControlPostgresSql, sqlLiteral } from '../../../tests/e2e/gfsFixtureCore'
import {
  cleanupGfsFixture,
  seedGfsFileFixture,
  seedGfsGrant,
} from '../../../tests/e2e/gfsResourceFixtures'
import { expect, test } from './fixtures'
import {
  RESPONSE_TIMEOUT_MS,
  assertNoInfraFailureShape,
  expectNoDisclosureDenial,
  expectReadWithSentinel,
  expectToolSuccess,
  openExactAgent,
  sendAgentTurn,
} from './helpers/gfsAgentChat'
import { type ManagedGfsAgent, getManagedAgentDisplayName } from './helpers/gfsAgentDiscovery'
import { assertGfsInfraHealthy, discoverManagedGfsAgents } from './helpers/gfsFixtures'
import { type HomeTestUser, UserHomeFixtures } from './helpers/gfsUserHomeFixtures'
import { ControlUiAccessPanel } from './pages/ControlUiAccessPanel'
import { DesktopFilesNav } from './pages/DesktopFilesNav'
import { DesktopResourceView } from './pages/DesktopResourceView'
import { DesktopShareDialog } from './pages/DesktopShareDialog'

const MAIN_ENTRY = path.resolve(__dirname, '../../dist/main.js')
const OWNER_BITS = ['delete', 'manage_acl', 'read', 'share', 'write']

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`[USER-HOME-E2E] ${name} is required (no default).`)
  return value.replace(/\/$/, '')
}

function runTagFor(testInfo: TestInfo): string {
  return createHash('sha256')
    .update(`${testInfo.testId}:${Date.now()}:${process.pid}`)
    .digest('hex')
    .slice(0, 10)
}

interface DesktopSession {
  app: ElectronApplication
  page: Page
  close(): Promise<void>
}

/** Isolated Electron profile + visible login form (operator-parity pattern). */
async function launchDesktopAs(testInfo: TestInfo, user: HomeTestUser): Promise<DesktopSession> {
  const tag = `${user.name}-${testInfo.retry}`
  const userDataDir = testInfo.outputPath(`user-data-${tag}`)
  const videoDir = testInfo.outputPath(`video-${tag}`)
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(videoDir, { recursive: true })
  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, MAIN_ENTRY],
    env: {
      ...process.env,
      EVENFIRE_RENDERER_URL: '',
      ELECTRON_RENDERER_URL: '',
      EXTERNAL_REST_API_BASE_URL: requiredEnv('EXTERNAL_REST_API_BASE_URL'),
      RPC_PROXY_BASE_URL: requiredEnv('RPC_PROXY_BASE_URL'),
      CLERUM_DESKTOP_CONFIG_PATH: path.join(userDataDir, 'runtime-config.json'),
    },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await loginVisible(page, user)
  return {
    app,
    page,
    close: async () => {
      await app.close()
      const resolved = path.resolve(userDataDir)
      if (resolved.startsWith(`${path.resolve(testInfo.outputDir)}${path.sep}`)) {
        fs.rmSync(resolved, { recursive: true, force: true })
      }
    },
  }
}

async function loginVisible(page: Page, user: HomeTestUser): Promise<void> {
  const emailInput = page.locator('#email-input')
  const passwordInput = page.locator('#password-input')
  const settingsMenu = page.getByTestId('nav-settings-menu')
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
  await expect(emailInput.or(settingsMenu)).toBeVisible({ timeout: 30_000 })
  if (!(await emailInput.isVisible().catch(() => false))) {
    // A keychain-restored shell from another journey: leave it through the
    // real logout UI, never by mutating storage.
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') await settingsMenu.click()
    await page.getByTestId('logout-btn').click()
    await expect(emailInput).toBeVisible({ timeout: 30_000 })
  }
  await emailInput.fill(user.email)
  await passwordInput.fill(user.password)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await expect(settingsMenu).toBeVisible({ timeout: 45_000 })
}

async function openHomeFolder(page: Page, home: { storageUsername: string | null }): Promise<void> {
  const nav = new DesktopFilesNav(page)
  await nav.openFiles()
  await nav.openMyHome()
  await expect(
    page
      .getByRole('navigation', { name: 'File location' })
      .getByText(home.storageUsername ?? '', { exact: true })
  ).toBeVisible()
}

async function enterFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${name}` }).click()
  await expect(
    page.getByRole('navigation', { name: 'File location' }).getByText(name, { exact: true })
  ).toBeVisible()
}

function readPrompt(filePath: string): string {
  return (
    `Read the file at path "${filePath}" in GFS drive main and quote its contents verbatim. ` +
    'Do not answer from memory — attempt the read with your Clerum GFS tools even if the file is not in your listing.'
  )
}

function writePrompt(filePath: string, line: string): string {
  return (
    `Replace the ENTIRE contents of the file "${filePath}" in GFS drive main with exactly this single line of text: "${line}". ` +
    "Use only your native Clerum GFS tools; if your write tool needs the file's current version, discover it with your own GFS tools first. " +
    'Do not create, copy, or delete anything.'
  )
}

async function agentReads(
  page: Page,
  agent: ManagedGfsAgent,
  filePath: string,
  sentinel: string
): Promise<void> {
  await openExactAgent(page, getManagedAgentDisplayName(agent))
  const turn = await sendAgentTurn(page, readPrompt(filePath), 'gfs-user-home')
  assertNoInfraFailureShape(turn.responseText)
  await expectReadWithSentinel(turn.stepper, sentinel)
}

async function agentIsRefusedRead(
  page: Page,
  agent: ManagedGfsAgent,
  filePath: string,
  sentinel: string
): Promise<void> {
  await openExactAgent(page, getManagedAgentDisplayName(agent))
  const turn = await sendAgentTurn(page, readPrompt(filePath), 'gfs-user-home')
  await expectNoDisclosureDenial(turn, [sentinel])
}

/** Opens a gfs:// link through the visible "Open EvenDrive link" entry. */
async function openEvenDriveLink(page: Page, uri: string): Promise<void> {
  await new DesktopFilesNav(page).openFiles()
  await page.getByRole('button', { name: 'Options for Shared with me' }).click()
  await page.getByRole('menuitem', { name: 'Open EvenDrive link' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open EvenDrive link' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('EvenDrive link').fill(uri)
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
}

test.describe.serial('GFS per-user homes — Desktop (#1168)', () => {
  test.beforeAll(() => {
    assertGfsInfraHealthy()
  })

  test('J1 home appears without interaction and the owner shares it with an own agent', async ({}, testInfo) => {
    test.setTimeout(6 * RESPONSE_TIMEOUT_MS + 10 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const [agent] = discoverManagedGfsAgents()
    const owner = fx.createUser('j1-owner')
    fx.associateAgent(owner, agent)
    const folder = `j1-folder-${fx.runTag}`
    const file = `j1-file-${fx.runTag}.txt`
    const sentinel = `J1 home sentinel ${fx.runTag}`
    let session: DesktopSession | null = null
    try {
      session = await launchDesktopAs(testInfo, owner)
      const { page } = session
      await test.step('My home is ready, bound and owned', async () => {
        const home = await fx.waitForHomeState(owner.id, 'ready')
        expect(home.drive).toBeTruthy()
        expect(home.storageUsername).toBe(owner.name)
        await openHomeFolder(page, home)
        await new DesktopResourceView(page).expectYourAccess(OWNER_BITS)
        const ownerGrant = fx.accessFor(home.resourceId!, 'user', owner.id)
        expect(ownerGrant).toMatchObject({
          relation: 'grant',
          permissions: OWNER_BITS,
          inherit: true,
        })
      })
      const home = fx.readHome(owner.id)!
      const homePath = `/Users/${home.storageUsername}`
      await test.step('create a folder and a file through the UI', async () => {
        const view = new DesktopResourceView(page)
        await view.createFolder(folder)
        await enterFolder(page, folder)
        await view.uploadFile(file, Buffer.from(sentinel))
        fx.childId(fx.childId(home.resourceId!, folder), file)
      })
      const folderId = fx.childId(home.resourceId!, folder)
      const filePath = `${homePath}/${folder}/${file}`
      await test.step('the owner row cannot be revoked; share Read with the own agent', async () => {
        await openHomeFolder(page, home)
        await new DesktopResourceView(page).openShare(folder)
        const dialog = new DesktopShareDialog(page)
        await dialog.grant(agent.name, 'Read', { includeContents: true })
        await dialog.expectRow(agent.name, 'Read', false)
        const row = fx.accessFor(folderId, 'host', agent.subjectId)
        expect(row).toMatchObject({ relation: 'grant', permissions: ['read'], inherit: true })
        await page.keyboard.press('Escape')
        // Owner row: present, labelled Owner, and without remove/role actions (D5).
        await page
          .getByRole('navigation', { name: 'File location' })
          .getByText(home.storageUsername!, { exact: true })
          .click()
        await new DesktopResourceView(page).openShare(home.storageUsername!)
        const ownerRow = page
          .getByRole('list', { name: 'Resource access' })
          .getByRole('listitem')
          .filter({ has: page.getByText('Owner', { exact: true }) })
        await expect(ownerRow).toHaveCount(1)
        await expect(ownerRow.getByRole('button', { name: /^Actions for / })).toHaveCount(0)
        await expect(
          page
            .getByRole('list', { name: 'Resource access' })
            .getByRole('button', { name: `Actions for ${agent.name}` })
        ).toHaveCount(1)
        await page.keyboard.press('Escape')
      })
      await test.step('agent reads (positive) and cannot write while Read', async () => {
        await agentReads(page, agent, filePath, sentinel)
        const turn = await sendAgentTurn(
          page,
          writePrompt(filePath, `J1 denied write ${fx.runTag}`),
          'gfs-user-home'
        )
        assertNoInfraFailureShape(turn.responseText)
        expect(turn.responseText).not.toContain(`J1 denied write ${fx.runTag}`)
      })
      await test.step('Editor lets the agent write', async () => {
        await openHomeFolder(page, home)
        await new DesktopResourceView(page).openShare(folder)
        await new DesktopShareDialog(page).changeRole(agent.name, 'Editor')
        expect(fx.accessFor(folderId, 'host', agent.subjectId)?.permissions).toEqual([
          'read',
          'write',
        ])
        await page.keyboard.press('Escape')
        await openExactAgent(page, getManagedAgentDisplayName(agent))
        const turn = await sendAgentTurn(
          page,
          writePrompt(filePath, `J1 written ${fx.runTag}`),
          'gfs-user-home'
        )
        assertNoInfraFailureShape(turn.responseText)
        await expectToolSuccess(turn.stepper, 'gfs_write')
      })
      await test.step('revoke removes the row; agent refused, owner still reads', async () => {
        await openHomeFolder(page, home)
        await new DesktopResourceView(page).openShare(folder)
        await new DesktopShareDialog(page).revoke(agent.name)
        expect(fx.accessFor(folderId, 'host', agent.subjectId)).toBeNull()
        await page.keyboard.press('Escape')
        await agentIsRefusedRead(page, agent, filePath, `J1 written ${fx.runTag}`)
        await openHomeFolder(page, home)
        await enterFolder(page, folder)
        await expect(page.getByRole('button', { name: `Open ${file}` })).toBeVisible()
      })
    } finally {
      await session?.close()
      fx.cleanup()
    }
  })

  test('J1b sharing with users follows the Unix model and the owner sees every entry', async ({}, testInfo) => {
    test.setTimeout(15 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const owner = fx.createUser('j1b-owner')
    const b = fx.createUser('j1b-b')
    const c = fx.createUser('j1b-c')
    fx.createTeam('owner-b', [owner, b])
    fx.createTeam('b-c', [b, c]) // C shares a team with B but not with the owner (A1)
    const outer = `j1b-outer-${fx.runTag}`
    const inner = `j1b-inner-${fx.runTag}`
    const sibling = `j1b-sibling-${fx.runTag}`
    const file = `j1b-file-${fx.runTag}.txt`
    const sessions: DesktopSession[] = []
    try {
      const ownerS = await launchDesktopAs(testInfo, owner)
      sessions.push(ownerS)
      const home = await fx.waitForHomeState(owner.id, 'ready')
      const view = new DesktopResourceView(ownerS.page)
      await test.step('owner prepares folders and a file two levels down', async () => {
        await openHomeFolder(ownerS.page, home)
        await view.createFolder(outer)
        await view.createFolder(sibling)
        await enterFolder(ownerS.page, outer)
        await view.createFolder(inner)
        await enterFolder(ownerS.page, inner)
        await view.uploadFile(file, Buffer.from(`J1b ${fx.runTag}`))
      })
      const outerId = fx.childId(home.resourceId!, outer)
      await test.step('owner shares the outer folder with B as Editor', async () => {
        await openHomeFolder(ownerS.page, home)
        await view.openShare(outer)
        await new DesktopShareDialog(ownerS.page).grant(b.name, 'Editor', { includeContents: true })
        expect(fx.accessFor(outerId, 'user', b.id)).toMatchObject({
          permissions: OWNER_BITS,
          inherit: true,
        })
        await ownerS.page.keyboard.press('Escape')
      })
      const bS = await launchDesktopAs(testInfo, b)
      sessions.push(bS)
      await test.step('B opens the file (positive) and is refused on the sibling', async () => {
        await new DesktopFilesNav(bS.page).openFiles()
        await new DesktopFilesNav(bS.page).openSharedWithMe()
        await enterFolder(bS.page, outer)
        await enterFolder(bS.page, inner)
        await expect(bS.page.getByRole('button', { name: `Open ${file}` })).toBeVisible()
        await openEvenDriveLink(
          bS.page,
          `gfs://${home.drive}/${ridOf(fx.childId(home.resourceId!, sibling))}`
        )
        await expect(
          bS.page.getByRole('dialog', { name: 'Open EvenDrive link' }).getByRole('alert')
        ).toBeVisible()
      })
      await test.step('B shares the outer folder with C (Read); C opens the file', async () => {
        await new DesktopFilesNav(bS.page).openFiles()
        await new DesktopFilesNav(bS.page).openSharedWithMe()
        await new DesktopResourceView(bS.page).openShare(outer)
        await new DesktopShareDialog(bS.page).grant(c.name, 'Read', { includeContents: true })
        expect(fx.accessFor(outerId, 'user', c.id)).toMatchObject({ inherit: true })
        await bS.page.keyboard.press('Escape')
      })
      const cS = await launchDesktopAs(testInfo, c)
      sessions.push(cS)
      await new DesktopFilesNav(cS.page).openFiles()
      await new DesktopFilesNav(cS.page).openSharedWithMe()
      await enterFolder(cS.page, outer)
      await enterFolder(cS.page, inner)
      await expect(cS.page.getByRole('button', { name: `Open ${file}` })).toBeVisible()
      await test.step('owner revokes B: B refused, B home still opens; C keeps access (no cascade)', async () => {
        await openHomeFolder(ownerS.page, home)
        await view.openShare(outer)
        await new DesktopShareDialog(ownerS.page).revoke(b.name)
        expect(fx.accessFor(outerId, 'user', b.id)).toBeNull()
        await ownerS.page.keyboard.press('Escape')
        await openEvenDriveLink(bS.page, `gfs://${home.drive}/${ridOf(outerId)}`)
        await expect(
          bS.page.getByRole('dialog', { name: 'Open EvenDrive link' }).getByRole('alert')
        ).toBeVisible()
        await bS.page.keyboard.press('Escape')
        await openHomeFolder(bS.page, await fx.waitForHomeState(b.id, 'ready'))
        expect(fx.accessFor(outerId, 'user', c.id)).not.toBeNull()
      })
      await test.step('owner sees C by name (outside the owner teams) and removes C', async () => {
        await openHomeFolder(ownerS.page, home)
        await view.openShare(outer)
        const dialog = new DesktopShareDialog(ownerS.page)
        await dialog.expectRow(c.name, 'Read', false)
        await dialog.revoke(c.name)
        expect(fx.accessFor(outerId, 'user', c.id)).toBeNull()
        await ownerS.page.keyboard.press('Escape')
        await openEvenDriveLink(cS.page, `gfs://${home.drive}/${ridOf(outerId)}`)
        await expect(
          cS.page.getByRole('dialog', { name: 'Open EvenDrive link' }).getByRole('alert')
        ).toBeVisible()
        await openHomeFolder(ownerS.page, home)
        await enterFolder(ownerS.page, outer)
        await enterFolder(ownerS.page, inner)
        await expect(ownerS.page.getByRole('button', { name: `Open ${file}` })).toBeVisible()
      })
    } finally {
      for (const s of sessions.reverse()) await s.close()
      fx.cleanup()
    }
  })

  test('J2 a conflicting home path is shown honestly, shared files still open', async ({}, testInfo) => {
    test.setTimeout(10 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const sharer = fx.createUser('j2-sharer')
    const expectedName = `e2e-home-j2-user-${fx.runTag}`
    fx.createForeignDirectoryAtHomePath(expectedName)
    const user = fx.createUser('j2-user')
    expect(user.name).toBe(expectedName)
    fx.createTeam('j2', [sharer, user])
    const shared = seedGfsFileFixture(`e2e-home-j2-shared-${fx.runTag}`)
    let session: DesktopSession | null = null
    try {
      seedGfsGrant({
        resourceId: shared.resourceId,
        subjectType: 'user',
        subjectId: user.id,
        permissions: ['read'],
        inherit: true,
        grantedBy: 'e2e:user-home-j2-precondition',
      })
      const home = await fx.waitForHomeState(user.id, 'conflict')
      expect(home.conflictCode).toBe('path_conflict')
      session = await launchDesktopAs(testInfo, user)
      const nav = new DesktopFilesNav(session.page)
      await nav.openFiles()
      await nav.expectHomeState('conflict')
      await nav.openSharedWithMe()
      await expect(session.page.getByRole('button', { name: `Open ${shared.name}` })).toBeVisible()
    } finally {
      await session?.close()
      cleanupGfsFixture(shared.name)
      fx.cleanup()
    }
  })

  test('J3 isolation: other users and unassociated agents are refused on the owner file', async ({}, testInfo) => {
    test.setTimeout(3 * RESPONSE_TIMEOUT_MS + 10 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const [ownAgent, foreignAgent] = discoverManagedGfsAgents()
    const owner = fx.createUser('j3-owner')
    const b = fx.createUser('j3-b')
    fx.createTeam('j3', [owner, b])
    fx.associateAgent(owner, ownAgent)
    fx.associateAgent(b, foreignAgent)
    const file = `j3-file-${fx.runTag}.txt`
    const sentinel = `J3 private ${fx.runTag}`
    const control = seedGfsFileFixture(`e2e-home-j3-control-${fx.runTag}`)
    const sessions: DesktopSession[] = []
    try {
      seedGfsGrant({
        resourceId: control.resourceId,
        subjectType: 'host',
        subjectId: foreignAgent.subjectId,
        permissions: ['read'],
        inherit: true,
        grantedBy: 'e2e:user-home-j3-control',
      })
      const ownerS = await launchDesktopAs(testInfo, owner)
      sessions.push(ownerS)
      const home = await fx.waitForHomeState(owner.id, 'ready')
      await openHomeFolder(ownerS.page, home)
      await new DesktopResourceView(ownerS.page).uploadFile(file, Buffer.from(sentinel))
      const fileId = fx.childId(home.resourceId!, file)
      await expect(ownerS.page.getByRole('button', { name: `Open ${file}` })).toBeVisible()
      await test.step('B is refused on the owner file; B home works', async () => {
        const bS = await launchDesktopAs(testInfo, b)
        sessions.push(bS)
        await openEvenDriveLink(bS.page, `gfs://${home.drive}/${ridOf(fileId)}`)
        await expect(
          bS.page.getByRole('dialog', { name: 'Open EvenDrive link' }).getByRole('alert')
        ).toBeVisible()
        await bS.page.keyboard.press('Escape')
        await openHomeFolder(bS.page, await fx.waitForHomeState(b.id, 'ready'))
      })
      await test.step('an agent not associated with the owner reads its control file but not the owner file', async () => {
        const bS = sessions[1]!
        await agentReads(
          bS.page,
          foreignAgent,
          `/${control.name}`,
          `E2E GFS file fixture: ${control.name}`
        )
        await agentIsRefusedRead(
          bS.page,
          foreignAgent,
          `/Users/${home.storageUsername}/${file}`,
          sentinel
        )
      })
      await test.step('the Share picker lists only own agents; agent Editor lacks manage_acl, user Editor has it', async () => {
        await openHomeFolder(ownerS.page, home)
        await new DesktopResourceView(ownerS.page).openShare(file)
        const picker = ownerS.page.getByRole('combobox', { name: 'Add people, teams, or agents' })
        await picker.fill(foreignAgent.name)
        await expect(
          ownerS.page
            .getByRole('listbox', { name: 'Available people, teams, and agents' })
            .getByText(foreignAgent.name, { exact: true })
        ).toHaveCount(0)
        await picker.fill('')
        const dialog = new DesktopShareDialog(ownerS.page)
        await dialog.grant(ownAgent.name, 'Editor', { includeContents: false })
        await dialog.grant(b.name, 'Editor', { includeContents: false })
        expect(fx.accessFor(fileId, 'host', ownAgent.subjectId)?.permissions).toEqual([
          'read',
          'write',
        ])
        expect(fx.accessFor(fileId, 'user', b.id)?.permissions).toContain('manage_acl')
      })
    } finally {
      for (const s of sessions.reverse()) await s.close()
      cleanupGfsFixture(control.name)
      fx.cleanup()
    }
  })

  test('J4 inherited entries display correctly and a role change persists with its scope', async ({}, testInfo) => {
    test.setTimeout(15 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const owner = fx.createUser('j4-owner')
    const b = fx.createUser('j4-b')
    fx.createTeam('j4', [owner, b])
    const sub = `j4-sub-${fx.runTag}`
    const sessions: DesktopSession[] = []
    try {
      const ownerS = await launchDesktopAs(testInfo, owner)
      sessions.push(ownerS)
      const home = await fx.waitForHomeState(owner.id, 'ready')
      const view = new DesktopResourceView(ownerS.page)
      await openHomeFolder(ownerS.page, home)
      await view.createFolder(sub)
      await test.step('grant B Read with inheritance on the home folder', async () => {
        await openHomeFolder(ownerS.page, home)
        await ownerS.page
          .getByRole('navigation', { name: 'File location' })
          .getByText(home.storageUsername!, { exact: true })
          .click()
        await view.openShare(home.storageUsername!)
        await new DesktopShareDialog(ownerS.page).grant(b.name, 'Read', { includeContents: true })
        expect(fx.accessFor(home.resourceId!, 'user', b.id)).toMatchObject({
          permissions: ['read', 'share'],
          inherit: true,
        })
        await ownerS.page.keyboard.press('Escape')
      })
      const before = fx.accessRows(home.resourceId!).filter(row => row.subjectId !== b.id)
      await test.step('the descendant shows the inherited entry; change B to Editor there', async () => {
        await openHomeFolder(ownerS.page, home)
        await view.openShare(sub)
        const dialog = new DesktopShareDialog(ownerS.page)
        await dialog.expectRow(b.name, 'Read', true)
        await dialog.changeRole(b.name, 'Editor')
        expect(fx.accessFor(home.resourceId!, 'user', b.id)).toMatchObject({
          permissions: OWNER_BITS,
          inherit: true,
        })
        expect(fx.accessRows(home.resourceId!).filter(row => row.subjectId !== b.id)).toEqual(
          before
        )
        await ownerS.page.keyboard.press('Escape')
      })
      await test.step('B can now create inside the descendant (positive)', async () => {
        const bS = await launchDesktopAs(testInfo, b)
        sessions.push(bS)
        await new DesktopFilesNav(bS.page).openFiles()
        await new DesktopFilesNav(bS.page).openSharedWithMe()
        await enterFolder(bS.page, home.storageUsername!)
        await enterFolder(bS.page, sub)
        await new DesktopResourceView(bS.page).createFolder(`j4-by-b-${fx.runTag}`)
        fx.childId(fx.childId(home.resourceId!, sub), `j4-by-b-${fx.runTag}`)
      })
    } finally {
      for (const s of sessions.reverse()) await s.close()
      fx.cleanup()
    }
  })

  test('J6 operator and Desktop converge on the same grants in both directions', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(4 * RESPONSE_TIMEOUT_MS + 15 * 60_000)
    const controlUiUrl = requiredEnv('CONTROL_UI_BASE_URL')
    const adminUser = requiredEnv('ADMIN_USER')
    const adminPass = requiredEnv('ADMIN_PASS')
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const [agent] = discoverManagedGfsAgents()
    const owner = fx.createUser('j6-owner')
    const b = fx.createUser('j6-b')
    fx.createTeam('j6', [owner, b])
    fx.associateAgent(owner, agent)
    const file = `j6-file-${fx.runTag}.txt`
    const sentinel = `J6 ${fx.runTag}`
    const sessions: DesktopSession[] = []
    const control = await browser.newContext({ baseURL: controlUiUrl })
    try {
      const ownerS = await launchDesktopAs(testInfo, owner)
      sessions.push(ownerS)
      const home = await fx.waitForHomeState(owner.id, 'ready')
      await openHomeFolder(ownerS.page, home)
      await new DesktopResourceView(ownerS.page).uploadFile(file, Buffer.from(sentinel))
      const fileId = fx.childId(home.resourceId!, file)
      const filePath = `/Users/${home.storageUsername}/${file}`
      await test.step('forward: Desktop grants the agent Editor and the agent writes', async () => {
        await new DesktopResourceView(ownerS.page).openShare(file)
        await new DesktopShareDialog(ownerS.page).grant(agent.name, 'Editor', {
          includeContents: false,
        })
        await ownerS.page.keyboard.press('Escape')
        await openExactAgent(ownerS.page, getManagedAgentDisplayName(agent))
        const turn = await sendAgentTurn(
          ownerS.page,
          writePrompt(filePath, `${sentinel} v2`),
          'gfs-user-home'
        )
        assertNoInfraFailureShape(turn.responseText)
        await expectToolSuccess(turn.stepper, 'gfs_write')
      })
      const page = await control.newPage()
      const operatorPanel = new ControlUiAccessPanel(page)
      const agentRow = { agentName: agent.name }
      await test.step('operator sees the grant and narrows it to read', async () => {
        await operatorPanel.login(adminUser, adminPass)
        // Edits go through the existing operator grant panel on drive main (D16).
        await operatorPanel.openResource(filePath)
        await operatorPanel.expectRole(agentRow, 'Editor')
        await operatorPanel.changeRole(agentRow, 'Read')
        expect(fx.accessFor(fileId, 'host', agent.subjectId)?.permissions).toEqual(['read'])
      })
      await test.step('agent reads (positive) and cannot write after narrowing', async () => {
        await agentReads(ownerS.page, agent, filePath, `${sentinel} v2`)
        const turn = await sendAgentTurn(
          ownerS.page,
          writePrompt(filePath, `${sentinel} v3`),
          'gfs-user-home'
        )
        assertNoInfraFailureShape(turn.responseText)
        expect(turn.responseText).not.toContain(`${sentinel} v3`)
      })
      await test.step('operator revokes; Desktop shows it after refresh; agent refused', async () => {
        await operatorPanel.revoke(agentRow)
        expect(fx.accessFor(fileId, 'host', agent.subjectId)).toBeNull()
        await openHomeFolder(ownerS.page, home)
        await new DesktopResourceView(ownerS.page).openShare(file)
        await expect(
          ownerS.page
            .getByRole('list', { name: 'Resource access' })
            .getByText(agent.name, { exact: true })
        ).toHaveCount(0)
        await ownerS.page.keyboard.press('Escape')
        await agentIsRefusedRead(ownerS.page, agent, filePath, `${sentinel} v2`)
      })
      await test.step('reverse: operator grants B Read; Desktop changes it to Editor and then revokes', async () => {
        await operatorPanel.grant(b.name, 'Read')
        expect(fx.accessFor(fileId, 'user', b.id)).not.toBeNull()
        await openHomeFolder(ownerS.page, home)
        await new DesktopResourceView(ownerS.page).openShare(file)
        const dialog = new DesktopShareDialog(ownerS.page)
        await dialog.expectRow(b.name, 'Read', false)
        await dialog.changeRole(b.name, 'Editor')
        expect(fx.accessFor(fileId, 'user', b.id)?.permissions).toEqual(OWNER_BITS)
        await dialog.revoke(b.name)
        expect(fx.accessFor(fileId, 'user', b.id)).toBeNull()
        // The operator reopens the resource (openResource waits for the grant
        // list response, the liveness witness) and sees the Desktop revoke.
        await operatorPanel.openResource(filePath)
        await expect(operatorPanel.roleControl({ label: b.name })).toHaveCount(0)
      })
    } finally {
      await control.close()
      for (const s of sessions.reverse()) await s.close()
      fx.cleanup()
    }
  })

  test('Guards: refused link, logout and retirement never show stale Files content', async ({}, testInfo) => {
    test.setTimeout(10 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const owner = fx.createUser('guard-owner')
    const other = fx.createUser('guard-other')
    const sessions: DesktopSession[] = []
    try {
      const ownerS = await launchDesktopAs(testInfo, owner)
      sessions.push(ownerS)
      const home = await fx.waitForHomeState(owner.id, 'ready')
      const otherHome = await fx.waitForHomeState(other.id, 'ready')
      await test.step('a link without ACL is refused; the same entry opens an own link (positive)', async () => {
        await openEvenDriveLink(
          ownerS.page,
          `gfs://${otherHome.drive}/${ridOf(otherHome.resourceId!)}`
        )
        const dialog = ownerS.page.getByRole('dialog', { name: 'Open EvenDrive link' })
        await expect(dialog.getByRole('alert')).toBeVisible()
        await ownerS.page.keyboard.press('Escape')
        await openEvenDriveLink(ownerS.page, `gfs://${home.drive}/${ridOf(home.resourceId!)}`)
        await expect(dialog).toBeHidden()
        await expect(ownerS.page.getByLabel('Your access')).toBeVisible()
      })
      await test.step('logout closes Files and it cannot be reopened from cache', async () => {
        await expect(ownerS.page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible()
        await ownerS.page.getByTestId('nav-settings-menu').click()
        await ownerS.page.getByTestId('logout-btn').click()
        await expect(ownerS.page.locator('#email-input')).toBeVisible({ timeout: 30_000 })
        await expect(ownerS.page.getByRole('region', { name: 'EvenDrive browser' })).toHaveCount(0)
      })
      await test.step('retirement (named precondition) ends the session with 401 and AuthPage (D19)', async () => {
        await loginVisible(ownerS.page, owner)
        const nav = new DesktopFilesNav(ownerS.page)
        await nav.openFiles()
        await nav.openMyHome()
        // Precondition: retire the per-test user (never the seeded identity).
        // The product's operator retirement journey is J8 in the Control UI suite.
        runControlPostgresSql(
          `UPDATE users SET lifecycle_state = 'retired', retired_at = now() WHERE id = ${sqlLiteral(owner.id)}::uuid;`
        )
        // The 401 comes from the main-process transport (externalSessionAuth);
        // the renderer-visible contract is the signed-out state with no stale listing.
        // The same "My home" action succeeded just above (positive witness).
        await ownerS.page.getByRole('treeitem', { name: 'My home' }).click()
        await expect(ownerS.page.locator('#email-input')).toBeVisible({ timeout: 60_000 })
        await expect(ownerS.page.getByRole('region', { name: 'EvenDrive browser' })).toHaveCount(0)
      })
    } finally {
      for (const s of sessions.reverse()) await s.close()
      fx.cleanup()
    }
  })
})
