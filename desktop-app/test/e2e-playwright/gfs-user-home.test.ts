// E2E_GUARDIAN_IPC_FLOW: Desktop Files, home and share transitions are brokered through Electron IPC; every step asserts the persisted signal.
/**
 * E2E — per-user GFS homes (#1168), Desktop journeys J1, J1b, J2–J6
 * and the Desktop access guards, following the plan's §5.5 contract table.
 * J5 uses the seeded initial admin's active operator link as a precondition;
 * its Desktop Files actions still use user-session authority.
 *
 * Contract (e2e-test-guardian):
 *  - Entry is a visible Desktop login of a per-test user, or the seeded
 *    initial admin in J5; homes and owner grants are never seeded — each
 *    journey consumes automatic provisioning.
 *  - Every grant/share under test is created, changed and removed through the
 *    Share dialog; SQL is used only for named preconditions and for reading
 *    business signals (gfs_user_homes, gfs_grants, gfs_shares, gfs_audit).
 *  - Each negative has a same-test positive on the same resource.
 *  - Agent denials are observed authorization refusals (no successful
 *    gfs_read, no sentinel leak), never timeouts.
 *  - Test-user credentials are generated at runtime; all credentials stay in memory.
 */
import {
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  type Page,
  type TestInfo,
  _electron as electron,
} from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  GFS_E2E_DRIVE,
  UUID_RE,
  firstDataLine,
  ridOf,
  runControlPostgresSql,
  sqlLiteral,
} from '../../../tests/e2e/gfsFixtureCore'
import {
  cleanupGfsFixture,
  seedGfsFileFixture,
  seedGfsGrant,
} from '../../../tests/e2e/gfsResourceFixtures'
import { DEV_ISOLATION_ENV, devIsolationPaths } from '../../src/devIsolation'
import { expect, test } from './fixtures'
import {
  RESPONSE_TIMEOUT_MS,
  assertNoInfraFailureShape,
  expectNoDisclosureDenial,
  expectReadWithSentinel,
  expectToolSuccess,
  expectWriteRefused,
  openExactAgent,
  sendAgentTurn,
} from './helpers/gfsAgentChat'
import { type ManagedGfsAgent, getManagedAgentDisplayName } from './helpers/gfsAgentDiscovery'
import type { GfsAuditRow } from './helpers/gfsDesktopOperatorParityFixtures'
import { assertGfsInfraHealthy, discoverManagedGfsAgents } from './helpers/gfsFixtures'
import { type HomeTestUser, UserHomeFixtures } from './helpers/gfsUserHomeFixtures'
import { humanRecordedPause } from './helpers/humanPause'
import { awaitPasswordPace } from './helpers/passwordPace'
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

/**
 * A Control UI operator context whose actions and navigations fail within a
 * minute. Playwright Test sets both defaults to 0 (no limit), so a stalled
 * operator step otherwise waits for the whole journey timeout.
 */
async function newOperatorContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: requiredEnv('CONTROL_UI_BASE_URL') })
  context.setDefaultTimeout(60_000)
  context.setDefaultNavigationTimeout(60_000)
  return context
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

/** A dev-isolated Electron session with a visible login. */
async function launchDesktopAs(testInfo: TestInfo, user: HomeTestUser): Promise<DesktopSession> {
  const appPath = fs.realpathSync(path.dirname(MAIN_ENTRY))
  const restUrl = requiredEnv('EXTERNAL_REST_API_BASE_URL')
  const rpcUrl = requiredEnv('RPC_PROXY_BASE_URL')
  fs.mkdirSync(testInfo.outputDir, { recursive: true })
  const runDir = fs.realpathSync(fs.mkdtempSync(testInfo.outputPath('home-desktop-')))
  const isolated = devIsolationPaths(runDir)
  const videoDir = testInfo.outputPath(`video-${path.basename(runDir)}`)
  fs.mkdirSync(isolated.userDataDir, { mode: 0o700 })
  fs.mkdirSync(videoDir, { recursive: true })
  let app: ElectronApplication
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${isolated.userDataDir}`, path.join(appPath, 'main.js')],
      env: {
        ...process.env,
        EVENFIRE_DEV_ISOLATION: '1',
        [DEV_ISOLATION_ENV.runDir]: runDir,
        [DEV_ISOLATION_ENV.restUrl]: restUrl,
        [DEV_ISOLATION_ENV.rpcUrl]: rpcUrl,
        [DEV_ISOLATION_ENV.target]: path.basename(runDir),
        [DEV_ISOLATION_ENV.appPath]: appPath,
        [DEV_ISOLATION_ENV.pr]: process.env.E2E_DESKTOP_PR_NUMBER || '',
        EVENFIRE_RENDERER_URL: '',
        ELECTRON_RENDERER_URL: '',
        EXTERNAL_REST_API_BASE_URL: restUrl,
        RPC_PROXY_BASE_URL: rpcUrl,
        CLERUM_DESKTOP_CONFIG_PATH: isolated.configPath,
      },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    })
  } catch (error) {
    fs.rmSync(runDir, { recursive: true, force: true })
    throw error
  }
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginVisible(page, user)
    return {
      app,
      page,
      close: async () => {
        await app.close()
        fs.rmSync(runDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await app.close()
    fs.rmSync(runDir, { recursive: true, force: true })
    throw error
  }
}

async function loginVisible(page: Page, user: HomeTestUser): Promise<void> {
  const emailInput = page.locator('#email-input')
  const passwordInput = page.locator('#password-input')
  const settingsMenu = page.getByTestId('nav-settings-menu')
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
  await expect(emailInput).toBeVisible({ timeout: 30_000 })
  await emailInput.fill(user.email)
  await passwordInput.fill(user.password)
  await awaitPasswordPace()
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await expect(settingsMenu).toBeVisible({ timeout: 45_000 })
  await humanRecordedPause([600, 1200])
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
  await humanRecordedPause([600, 1200])
}

async function enterFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${name}` }).click()
  await expect(
    page.getByRole('navigation', { name: 'File location' }).getByText(name, { exact: true })
  ).toBeVisible()
  await humanRecordedPause([600, 1200])
}

// Agents address the file by its gfs:// link, as a user shares it. The agent's
// gfs_resolve accepts only a gfs:// URI (mcp-host/src/internalTools/gfs.ts:684-688)
// and gfs_write needs the resource id plus its current version (:890-900); a path
// let the model give up before attempting the write it was asked to make.
function readPrompt(fileUri: string): string {
  return (
    `Read the GFS file "${fileUri}" and quote its contents verbatim. ` +
    'Resolve that gfs:// URI with your Clerum GFS tools and read it; do not answer from memory, ' +
    'and attempt the read even if the file is not in your listing.'
  )
}

function writePrompt(fileUri: string, line: string): string {
  return (
    `Replace the ENTIRE contents of the GFS file "${fileUri}" with exactly this single line of text: "${line}". ` +
    'Resolve that gfs:// URI with your Clerum GFS tools to get its resource id and current version, ' +
    'then call your GFS write tool once with them. If the write is refused, report the refusal. ' +
    'Do not create, copy, or delete anything.'
  )
}

async function agentReads(
  page: Page,
  agent: ManagedGfsAgent,
  fileUri: string,
  sentinel: string
): Promise<void> {
  await openExactAgent(page, getManagedAgentDisplayName(agent))
  const turn = await sendAgentTurn(page, readPrompt(fileUri), 'gfs-user-home')
  assertNoInfraFailureShape(turn.responseText)
  await expectReadWithSentinel(turn.stepper, sentinel)
}

async function agentIsRefusedRead(
  page: Page,
  agent: ManagedGfsAgent,
  fileUri: string,
  sentinel: string
): Promise<void> {
  await openExactAgent(page, getManagedAgentDisplayName(agent))
  const turn = await sendAgentTurn(page, readPrompt(fileUri), 'gfs-user-home')
  await expectNoDisclosureDenial(turn, [sentinel])
}

/** Opens a gfs:// link through the visible "Open EvenDrive link" entry. */
async function openEvenDriveLink(page: Page, uri: string): Promise<void> {
  await new DesktopFilesNav(page).openFiles()
  await page.getByRole('button', { name: 'Options for Shared with me' }).click()
  await page.getByRole('menuitem', { name: 'Open EvenDrive link' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open EvenDrive link' })
  await expect(dialog).toBeVisible()
  // By role: a label substring also matches the "Close EvenDrive link dialog" button.
  await dialog.getByRole('textbox', { name: 'EvenDrive link' }).fill(uri)
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await humanRecordedPause([600, 1200])
}

async function expectRefusedLinkAndClose(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Open EvenDrive link' })
  await expect(
    dialog.getByText('403 Forbidden: forbidden: not authorized to read this resource', {
      exact: true,
    })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Close EvenDrive link dialog' }).click()
  await expect(dialog).toBeHidden()
}

/** Read the seeded initial admin and its active link without creating either. */
function readInitialAdmin(
  login: string,
  password: string
): {
  user: HomeTestUser
  controlAdminId: string
} {
  const row = firstDataLine(
    runControlPostgresSql(`
      SELECT jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name,
                                'controlAdminId', a.id)::text
        FROM gfs_desktop_operator_links l
        JOIN users u ON u.id = l.user_id
        JOIN control_admin_users a ON a.id = l.control_admin_id
       WHERE l.state = 'active' AND l.source = 'initial_setup'
         AND u.lifecycle_state = 'active' AND a.status = 'active'
         AND (lower(a.username) = lower(${sqlLiteral(login)})
              OR lower(a.email) = lower(${sqlLiteral(login)}));
    `)
  )
  if (!row) throw new Error('[USER-HOME-E2E] active initial-admin operator link is required')
  const identity = JSON.parse(row) as Record<string, unknown>
  if (
    typeof identity.id !== 'string' ||
    !UUID_RE.test(identity.id) ||
    typeof identity.controlAdminId !== 'string' ||
    !UUID_RE.test(identity.controlAdminId) ||
    typeof identity.email !== 'string' ||
    !identity.email ||
    typeof identity.name !== 'string' ||
    !identity.name
  ) {
    throw new Error('[USER-HOME-E2E] malformed initial-admin identity')
  }
  return {
    user: { id: identity.id, email: identity.email, name: identity.name, password },
    controlAdminId: identity.controlAdminId,
  }
}

/** Use the parity lane's gfs_audit reader and sequence floor for both audit producers. */
function auditFloor(): number {
  return Number(
    firstDataLine(
      runControlPostgresSql('SELECT coalesce(max(sequence_no), 0)::text FROM gfs_audit;')
    )
  )
}

function auditRowsAfter(sequenceNo: number, desktopUserId: string): GfsAuditRow[] {
  const output = runControlPostgresSql(`
    SELECT jsonb_build_object(
      'sequenceNo', sequence_no, 'subject', subject, 'actorOnBehalfOf', actor_on_behalf_of,
      'desktopUserId', desktop_user_id, 'authoritySource', authority_source,
      'op', op, 'outcome', outcome, 'recordType', record_type,
      'mutationOutcome', mutation_outcome, 'requestId', request_id, 'gfsUri', gfs_uri
    )::text
      FROM gfs_audit
     WHERE sequence_no > ${Number(sequenceNo)}
       AND desktop_user_id = ${sqlLiteral(desktopUserId)}::uuid
     ORDER BY sequence_no ASC;
  `)
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{') && line.endsWith('}'))
    .map(line => JSON.parse(line) as GfsAuditRow)
}

// Not serial: every journey creates and cleans its own users, homes and
// fixtures (per-test runTag), so one failure must not hide the others.
test.describe('GFS per-user homes — Desktop (#1168)', () => {
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
      const fileUri = `gfs://${home.drive}/${ridOf(fx.childId(folderId, file))}`
      await test.step('the owner row cannot be revoked; share Read with the own agent', async () => {
        await openHomeFolder(page, home)
        await new DesktopResourceView(page).openShare(folder)
        const dialog = new DesktopShareDialog(page)
        await dialog.grant(agent.name, 'Read', { includeContents: true })
        await dialog.expectRow(agent.name, 'Read', false)
        const row = fx.accessFor(folderId, 'host', agent.subjectId)
        expect(row).toMatchObject({ relation: 'grant', permissions: ['read'], inherit: true })
        // Same list on the subfolder: the inherited owner row is labelled Owner
        // and has no remove/role actions (D5), while the agent row on this same
        // resource keeps its Actions menu (positive witness).
        const folderAccess = page.getByRole('list', { name: 'Resource access' })
        const inheritedOwnerRow = folderAccess
          .getByRole('listitem')
          .filter({ has: page.getByText('Owner', { exact: true }) })
        await expect(inheritedOwnerRow).toHaveCount(1)
        await expect(inheritedOwnerRow.getByRole('button', { name: /^Actions for / })).toHaveCount(
          0
        )
        await expect(
          folderAccess.getByRole('button', { name: `Actions for ${agent.name}` })
        ).toHaveCount(1)
        await page.keyboard.press('Escape')
        // Home root: the direct owner row is present and protected as well.
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
        await page.keyboard.press('Escape')
      })
      await test.step('agent reads (positive) and cannot write while Read', async () => {
        await agentReads(page, agent, fileUri, sentinel)
        const turn = await sendAgentTurn(
          page,
          writePrompt(fileUri, `J1 denied write ${fx.runTag}`),
          'gfs-user-home'
        )
        await expectWriteRefused(turn, `J1 denied write ${fx.runTag}`)
        // The content is unchanged: an authorized read still returns the original.
        await agentReads(page, agent, fileUri, sentinel)
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
          writePrompt(fileUri, `J1 written ${fx.runTag}`),
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
        await agentIsRefusedRead(page, agent, fileUri, `J1 written ${fx.runTag}`)
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
        await expectRefusedLinkAndClose(bS.page)
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
        await expectRefusedLinkAndClose(bS.page)
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
        await expectRefusedLinkAndClose(cS.page)
        await openHomeFolder(ownerS.page, home)
        await enterFolder(ownerS.page, outer)
        await enterFolder(ownerS.page, inner)
        await expect(ownerS.page.getByRole('button', { name: `Open ${file}` })).toBeVisible()
      })
      await test.step('owner lowers an Editor share B made to C to Read (D26, D9)', async () => {
        // Named precondition: no UI writes share rows (see seedShare).
        const shareId = fx.seedShare(home.drive!, outerId, b, c, ['read', 'write', 'share'])
        const cRows = () =>
          fx.accessRows(outerId).filter(row => row.subjectType === 'user' && row.subjectId === c.id)
        expect(cRows()).toEqual([
          expect.objectContaining({ id: shareId, relation: 'share', inherit: true }),
        ])
        const outerUri = `gfs://${home.drive}/${ridOf(outerId)}`
        const innerRow = cS.page.getByRole('button', { name: `Open ${inner}` })
        // C's effective bits on the folder, read through C's own authenticated
        // Desktop session ("Your access" renders only inside the user's home).
        const cHeld = () =>
          cS.page.evaluate(
            async ([resourceId, drive]) =>
              (
                await (
                  window as unknown as {
                    clerum: {
                      gfs: {
                        affordances: (id: string, d: string) => Promise<{ held: string[] }>
                      }
                    }
                  }
                ).clerum.gfs.affordances(resourceId, drive)
              ).held,
            [outerId, home.drive!] as const
          )
        await expect.poll(cHeld).toEqual(expect.arrayContaining(['read', 'write']))
        // C reaches the folder through the share (positive).
        await openEvenDriveLink(cS.page, outerUri)
        await expect(innerRow).toBeVisible()
        await openHomeFolder(ownerS.page, home)
        await view.openShare(outer)
        await new DesktopShareDialog(ownerS.page).lowerShare(c.name)
        expect(cRows()).toEqual([
          expect.objectContaining({
            id: shareId,
            relation: 'share',
            permissions: ['read', 'share'],
            inherit: true,
          }),
        ])
        await ownerS.page.keyboard.press('Escape')
        // Lowering narrows the share without revoking it: C keeps read and
        // loses write, and opens the folder again after leaving it.
        await expect.poll(cHeld).not.toContain('write')
        expect(await cHeld()).toContain('read')
        await openHomeFolder(cS.page, await fx.waitForHomeState(c.id, 'ready'))
        await expect(innerRow).toHaveCount(0)
        await openEvenDriveLink(cS.page, outerUri)
        await expect(innerRow).toBeVisible()
      })
    } finally {
      for (const s of sessions.reverse()) await s.close()
      fx.cleanup()
    }
  })

  test('J2 a conflicting home path is shown honestly, shared files still open', async ({}, testInfo) => {
    test.setTimeout(10 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const expectedName = `e2e-home-j2-user-${fx.runTag}`
    let shared: ReturnType<typeof seedGfsFileFixture> | null = null
    let session: DesktopSession | null = null
    let foreignDirectoryId: string | null = null
    let setupComplete = false
    try {
      const sharer = fx.createUser('j2-sharer')
      foreignDirectoryId = fx.createForeignDirectoryAtHomePath(expectedName)
      const user = fx.createUser('j2-user')
      expect(user.name).toBe(expectedName)
      fx.createTeam('j2', [sharer, user])
      shared = seedGfsFileFixture(`e2e-gfs-j2-shared-${fx.runTag}`)
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
      setupComplete = true
    } finally {
      try {
        await session?.close()
      } finally {
        try {
          if (shared) cleanupGfsFixture(shared.name)
        } finally {
          try {
            fx.cleanup()
          } finally {
            if (!setupComplete && foreignDirectoryId) {
              // Match the Control UI fixture's ownership check: never delete a bound home.
              const deleted = firstDataLine(
                runControlPostgresSql(`
                  DELETE FROM gfs_resources
                   WHERE resource_id = ${sqlLiteral(foreignDirectoryId)}::uuid
                     AND drive = ${sqlLiteral(GFS_E2E_DRIVE)}
                     AND name = ${sqlLiteral(expectedName)}
                     AND path_cache = ${sqlLiteral(`/Users/${expectedName}`)}
                     AND NOT EXISTS (
                       SELECT 1 FROM gfs_user_homes
                        WHERE resource_id = ${sqlLiteral(foreignDirectoryId)}::uuid
                     )
                  RETURNING resource_id::text;
                `)
              )
              if (deleted !== foreignDirectoryId) {
                throw new Error(
                  '[USER-HOME-E2E] foreign directory cleanup refused; inspect ownership'
                )
              }
            }
          }
        }
      }
    }
  })

  test('J3 isolation: other users and unassociated agents are refused on the owner file', async ({}, testInfo) => {
    test.setTimeout(3 * RESPONSE_TIMEOUT_MS + 10 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const [ownAgent, foreignAgent] = discoverManagedGfsAgents()
    const file = `j3-file-${fx.runTag}.txt`
    const sentinel = `J3 private ${fx.runTag}`
    let control: ReturnType<typeof seedGfsFileFixture> | null = null
    const sessions: DesktopSession[] = []
    try {
      const owner = fx.createUser('j3-owner')
      const b = fx.createUser('j3-b')
      fx.createTeam('j3', [owner, b])
      fx.associateAgent(owner, ownAgent)
      fx.associateAgent(b, foreignAgent)
      control = seedGfsFileFixture(`e2e-gfs-j3-control-${fx.runTag}`)
      const controlFixture = control
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
        await expectRefusedLinkAndClose(bS.page)
        await openHomeFolder(bS.page, await fx.waitForHomeState(b.id, 'ready'))
      })
      await test.step('an agent not associated with the owner reads its control file but not the owner file', async () => {
        const bS = sessions[1]!
        await agentReads(
          bS.page,
          foreignAgent,
          controlFixture.fileUri,
          `E2E GFS file fixture: ${controlFixture.name}`
        )
        await agentIsRefusedRead(
          bS.page,
          foreignAgent,
          `gfs://${home.drive}/${ridOf(fileId)}`,
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
      try {
        for (const s of sessions.reverse()) await s.close()
      } finally {
        try {
          if (control) cleanupGfsFixture(control.name)
        } finally {
          fx.cleanup()
        }
      }
    }
  })

  test('J4 inherited entries display correctly and a role change persists with its scope', async ({}, testInfo) => {
    test.setTimeout(15 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const [agent] = discoverManagedGfsAgents()
    const owner = fx.createUser('j4-owner')
    const b = fx.createUser('j4-b')
    fx.associateAgent(owner, agent)
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
      const subId = fx.childId(home.resourceId!, sub)
      await test.step('owner shares the descendant with the own agent (Read)', async () => {
        await view.openShare(sub)
        await new DesktopShareDialog(ownerS.page).grant(agent.name, 'Read', {
          includeContents: true,
        })
        expect(fx.accessFor(subId, 'host', agent.subjectId)).toMatchObject({
          relation: 'grant',
          permissions: ['read'],
        })
        await ownerS.page.keyboard.press('Escape')
      })
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
      const bS = await launchDesktopAs(testInfo, b)
      sessions.push(bS)
      await test.step('B can now create inside the descendant (positive)', async () => {
        await new DesktopFilesNav(bS.page).openFiles()
        await new DesktopFilesNav(bS.page).openSharedWithMe()
        await enterFolder(bS.page, home.storageUsername!)
        await enterFolder(bS.page, sub)
        await new DesktopResourceView(bS.page).createFolder(`j4-by-b-${fx.runTag}`)
        fx.childId(subId, `j4-by-b-${fx.runTag}`)
      })
      await test.step('B (Editor) sees the owner row protected and the owner agent without a role control', async () => {
        await new DesktopFilesNav(bS.page).openFiles()
        await new DesktopFilesNav(bS.page).openSharedWithMe()
        await enterFolder(bS.page, home.storageUsername!)
        await new DesktopResourceView(bS.page).openShare(sub)
        const access = bS.page.getByRole('list', { name: 'Resource access' })
        // Witness: B's own row has a role control, so missing controls below are real.
        await expect(access.getByRole('button', { name: `Access role for ${b.name}` })).toHaveCount(
          1
        )
        // D5/D38: the inherited owner row has no role or remove control for B either.
        const ownerRow = access
          .getByRole('listitem')
          .filter({ has: bS.page.getByText('Owner', { exact: true }) })
        await expect(ownerRow).toHaveCount(1)
        await expect(
          ownerRow.getByRole('button', { name: /^(Actions|Access role) for / })
        ).toHaveCount(0)
        // D25: the owner's agent is not B's agent: its role is text, Remove stays.
        const agentGrant = fx.accessFor(subId, 'host', agent.subjectId)
        if (!agentGrant) throw new Error('The owner agent grant is missing')
        const agentRow = bS.page.getByTestId(`gfs-access-row-grant-${agentGrant.id}`)
        await expect(agentRow).toContainText('Read')
        await expect(agentRow.getByRole('button', { name: /^Access role for / })).toHaveCount(0)
        await agentRow.getByRole('button', { name: /^Actions for / }).click()
        await bS.page.getByRole('menuitem', { name: 'Remove access' }).click()
        await expect(agentRow).toHaveCount(0)
        expect(fx.accessFor(subId, 'host', agent.subjectId)).toBeNull()
        await bS.page.keyboard.press('Escape')
      })
    } finally {
      for (const s of sessions.reverse()) await s.close()
      fx.cleanup()
    }
  })

  test('J5 a linked initial admin uses only user authority in Desktop Files', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(15 * 60_000)
    const adminLogin = requiredEnv('ADMIN_USER')
    // Initial setup seeds the linked Desktop user with the admin's own password.
    const adminPassword = requiredEnv('ADMIN_PASS')
    const initial = readInitialAdmin(adminLogin, adminPassword)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const adminFile = `j5-admin-${fx.runTag}.txt`
    const guestFile = `j5-private-${fx.runTag}.txt`
    const sentinel = `J5 private file ${fx.runTag}`
    const sessions: DesktopSession[] = []
    let controlPage: Page | null = null
    let control: BrowserContext | null = null
    let adminSession: DesktopSession | null = null
    let adminHome: Awaited<ReturnType<UserHomeFixtures['waitForHomeState']>> | null = null
    let adminFileCreated = false
    let adminFileId: string | null = null
    let guest: HomeTestUser | null = null
    try {
      guest = fx.createUser('j5-guest')
      control = await newOperatorContext(browser)
      controlPage = await control.newPage()
      const operatorPanel = new ControlUiAccessPanel(controlPage)
      await operatorPanel.login(adminLogin, adminPassword)

      // Named precondition, as in J1b–J6: share targets are team members (D4).
      // V joins the admin's own team: a second team would make Desktop hop team
      // context in the background and refuse an upload that lands in a hop (#1218).
      fx.joinOnlyTeamOf(initial.user, guest)

      const guestSession = await launchDesktopAs(testInfo, guest)
      sessions.push(guestSession)
      const guestHome = await fx.waitForHomeState(guest.id, 'ready')
      expect(guestHome.drive).toBe(GFS_E2E_DRIVE)
      await test.step('precondition: V creates G in the automatically provisioned home', async () => {
        await openHomeFolder(guestSession.page, guestHome)
        await new DesktopResourceView(guestSession.page).uploadFile(
          guestFile,
          Buffer.from(sentinel)
        )
      })
      const guestFileId = fx.childId(guestHome.resourceId!, guestFile)
      const guestFilePath = `/Users/${guestHome.storageUsername}/${guestFile}`

      adminSession = await launchDesktopAs(testInfo, initial.user)
      sessions.push(adminSession)
      const adminPage = adminSession.page
      adminHome = await fx.waitForHomeState(initial.user.id, 'ready')
      const home = adminHome
      await test.step('My home is the linked user’s own provisioned home', async () => {
        expect(home).toMatchObject({ state: 'ready', drive: expect.any(String) })
        expect(home.storageUsername).toBeTruthy()
        expect(home.resourceId).toMatch(UUID_RE)
        const path = firstDataLine(
          runControlPostgresSql(`
            SELECT path_cache FROM gfs_resources
             WHERE resource_id = ${sqlLiteral(home.resourceId!)}::uuid
               AND drive = ${sqlLiteral(home.drive!)} AND deleted_at IS NULL;
          `)
        )
        expect(path).toBe(`/Users/${home.storageUsername}`)
        await openHomeFolder(adminPage, home)
        await expect(
          adminPage
            .getByRole('navigation', { name: 'File location' })
            .getByRole('button', { name: home.storageUsername!, exact: true })
        ).toHaveAttribute('aria-current', 'page')
        await new DesktopResourceView(adminPage).expectYourAccess(OWNER_BITS)
      })

      await new DesktopResourceView(adminPage).uploadFile(
        adminFile,
        Buffer.from(`J5 shared ${fx.runTag}`)
      )
      adminFileCreated = true
      adminFileId = fx.childId(home.resourceId!, adminFile)
      const sharedFileId = adminFileId
      await test.step('U shares a file with V as a user session', async () => {
        const floor = auditFloor()
        await new DesktopResourceView(adminPage).openShare(adminFile)
        await new DesktopShareDialog(adminPage).grant(guest!.name, 'Read', {
          includeContents: false,
        })
        expect(fx.accessFor(sharedFileId, 'user', guest!.id)).toMatchObject({
          relation: 'grant',
          permissions: ['read', 'share'],
          inherit: false,
        })
        await expect
          .poll(() =>
            auditRowsAfter(floor, initial.user.id).some(
              row =>
                row.subject === `user:${guest!.id}` &&
                row.desktopUserId === initial.user.id &&
                row.authoritySource === 'user-session' &&
                row.op === 'grant.put[read,share]' &&
                row.outcome === 'allowed' &&
                row.gfsUri === `gfs://${home.drive}/${sharedFileId}`
            )
          )
          .toBe(true)
        await adminPage.keyboard.press('Escape')
      })

      await test.step('U is refused on G and the deny records the user token subject', async () => {
        const floor = auditFloor()
        // Link opening resolves metadata before bytes; the byte-proxy refusal is
        // covered by control-api/test/routes.externalGfsAuthority.test.ts.
        await openEvenDriveLink(adminPage, `gfs://${guestHome.drive}/${ridOf(guestFileId)}`)
        await expectRefusedLinkAndClose(adminPage)
        await expect
          .poll(() =>
            auditRowsAfter(floor, initial.user.id).some(
              row =>
                row.subject === initial.user.id &&
                row.desktopUserId === initial.user.id &&
                row.authoritySource === 'user-session' &&
                row.op === 'read' &&
                row.outcome === 'deny' &&
                row.recordType === 'authorization_decision' &&
                row.gfsUri === `gfs://${guestHome.drive}/${ridOf(guestFileId)}`
            )
          )
          .toBe(true)
      })

      await test.step('an independent Control UI operator reads G', async () => {
        const page = controlPage!
        await operatorPanel.openResource(guestFilePath)
        await page.getByRole('button', { name: 'Close share dialog', exact: true }).click()
        await page
          .getByRole('list', { name: 'Current folder resources' })
          .getByRole('button', { name: guestFile, exact: true })
          .click()
        await expect(
          page.getByRole('article', { name: `Text preview of ${guestFile}` })
        ).toContainText(sentinel)
        await page
          .getByRole('dialog', { name: guestFile })
          .getByRole('button', { name: 'Close preview' })
          .click()
      })
    } finally {
      const errors: unknown[] = []
      const attempt = async (action: () => void | Promise<void>) => {
        try {
          await action()
        } catch (error) {
          errors.push(error)
        }
      }
      if (adminSession && adminHome && adminFileCreated) {
        const session = adminSession
        const home = adminHome
        await attempt(async () => {
          await session.page.keyboard.press('Escape')
          await openHomeFolder(session.page, home)
          if (guest && adminFileId && fx.accessFor(adminFileId, 'user', guest.id)) {
            await new DesktopResourceView(session.page).openShare(adminFile)
            await new DesktopShareDialog(session.page).revoke(guest.name)
            await session.page
              .getByRole('dialog', { name: `Share file ${adminFile}` })
              .getByRole('button', { name: 'Close share dialog', exact: true })
              .click()
          }
          await session.page.getByRole('button', { name: `Options for ${adminFile}` }).click()
          await session.page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
          const confirmation = session.page.getByRole('dialog', { name: `Delete ${adminFile}?` })
          await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
          await expect(confirmation).toBeHidden()
          await expect(session.page.getByRole('button', { name: `Open ${adminFile}` })).toHaveCount(
            0
          )
        })
      }
      if (control) await attempt(() => control!.close())
      for (const session of sessions.reverse()) await attempt(() => session.close())
      await attempt(() => fx.cleanup())
      if (errors.length) throw new AggregateError(errors, 'J5 fixture cleanup failed')
    }
  })

  test('J6 operator and Desktop converge on the same grants in both directions', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(4 * RESPONSE_TIMEOUT_MS + 15 * 60_000)
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
    const control = await newOperatorContext(browser)
    try {
      const ownerS = await launchDesktopAs(testInfo, owner)
      sessions.push(ownerS)
      const home = await fx.waitForHomeState(owner.id, 'ready')
      await openHomeFolder(ownerS.page, home)
      await new DesktopResourceView(ownerS.page).uploadFile(file, Buffer.from(sentinel))
      const fileId = fx.childId(home.resourceId!, file)
      const filePath = `/Users/${home.storageUsername}/${file}`
      const fileUri = `gfs://${home.drive}/${ridOf(fileId)}`
      await test.step('forward: Desktop grants the agent Editor and the agent writes', async () => {
        await new DesktopResourceView(ownerS.page).openShare(file)
        await new DesktopShareDialog(ownerS.page).grant(agent.name, 'Editor', {
          includeContents: false,
        })
        await ownerS.page.keyboard.press('Escape')
        await openExactAgent(ownerS.page, getManagedAgentDisplayName(agent))
        const turn = await sendAgentTurn(
          ownerS.page,
          writePrompt(fileUri, `${sentinel} v2`),
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
        await agentReads(ownerS.page, agent, fileUri, `${sentinel} v2`)
        const turn = await sendAgentTurn(
          ownerS.page,
          writePrompt(fileUri, `${sentinel} v3`),
          'gfs-user-home'
        )
        await expectWriteRefused(turn, `${sentinel} v3`)
        // The content is unchanged: an authorized read still returns v2.
        await agentReads(ownerS.page, agent, fileUri, `${sentinel} v2`)
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
        await agentIsRefusedRead(ownerS.page, agent, fileUri, `${sentinel} v2`)
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
        // The operator reopens the resource (the helper waits for the grant
        // list response, the liveness witness) and sees the Desktop revoke.
        const sharePanel = page.getByRole('dialog', { name: `Share file ${file}` })
        await sharePanel.getByRole('button', { name: 'Close share dialog' }).click()
        await expect(sharePanel).toBeHidden()
        await operatorPanel.openResourceInCurrentFolder(file)
        await expect(operatorPanel.roleControl({ label: b.name })).toHaveCount(0)
      })
    } finally {
      await control.close()
      for (const s of sessions.reverse()) await s.close()
      fx.cleanup()
    }
  })

  test('Guards: refused link, logout and retirement never show stale Files content', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(10 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const owner = fx.createUser('guard-owner')
    const other = fx.createUser('guard-other')
    const file = `guard-file-${fx.runTag}.txt`
    const sessions: DesktopSession[] = []
    const controls: BrowserContext[] = []
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
        await expectRefusedLinkAndClose(ownerS.page)
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
      await test.step('retirement refuses a fresh Files read and clears the stale listing (D19)', async () => {
        await loginVisible(ownerS.page, owner)
        const nav = new DesktopFilesNav(ownerS.page)
        await nav.openFiles()
        await nav.openMyHome()
        const view = new DesktopResourceView(ownerS.page)
        await view.uploadFile(file, Buffer.from(`Guard witness ${fx.runTag}`))
        const fileRow = ownerS.page.getByRole('button', { name: `Open ${file}` })
        await expect(fileRow).toBeVisible()

        // Use the same governed operator retirement journey as Control UI J8.
        const control = await newOperatorContext(browser)
        controls.push(control)
        const controlPage = await control.newPage()
        await new ControlUiAccessPanel(controlPage).login(
          requiredEnv('ADMIN_USER'),
          requiredEnv('ADMIN_PASS')
        )
        // E2E_GUARDIAN_NAVIGATION: user-detail-entry — the operator opens this fixture user
        await controlPage.goto(`/users-and-teams/users/${owner.id}`)
        await controlPage.getByRole('button', { name: 'Delete account…', exact: true }).click()
        const confirmation = controlPage.getByRole('alertdialog', {
          name: 'Delete member account permanently?',
        })
        const retirement = controlPage.waitForResponse(
          response =>
            response.request().method() === 'DELETE' &&
            new URL(response.url()).pathname.endsWith(`/admin/users/${owner.id}`)
        )
        await confirmation.getByRole('button', { name: 'Delete account', exact: true }).click()
        expect((await retirement).ok()).toBe(true)
        await expect(controlPage).toHaveURL(/\/users-and-teams\/users(?:\?|$)/)
        await fx.waitForHomeState(owner.id, 'retired')

        // Retirement ends the session's file access: Desktop re-reads, shows the
        // refusal and drops the listing without any further click.
        await expect(
          ownerS.page
            .getByRole('region', { name: 'EvenDrive browser' })
            .getByText('File access is not authorized', { exact: true })
        ).toBeVisible({
          timeout: 60_000,
        })
        await expect(fileRow).toHaveCount(0)
      })
    } finally {
      for (const control of controls) await control.close()
      for (const s of sessions.reverse()) await s.close()
      fx.cleanup()
    }
  })
})
