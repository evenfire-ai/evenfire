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
 *  - Every grant/share under test is created and changed through the Share
 *    dialog, except the named `seedShare` precondition and J1b's operator
 *    removal in Control UI; SQL is used only for named preconditions and for
 *    reading business signals (gfs_user_homes, gfs_grants, gfs_shares,
 *    gfs_audit).
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
import { stubSaveDialog } from './helpers/electronDialogs'
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
import {
  assertGfsInfraHealthy,
  discoverManagedGfsAgent,
  discoverManagedGfsAgents,
} from './helpers/gfsFixtures'
import { type HomeTestUser, UserHomeFixtures } from './helpers/gfsUserHomeFixtures'
import { humanRecordedPause } from './helpers/humanPause'
import { awaitPasswordPace } from './helpers/passwordPace'
import { ControlUiAccessPanel } from './pages/ControlUiAccessPanel'
import { DesktopFilesNav } from './pages/DesktopFilesNav'
import { DesktopMoveDialog } from './pages/DesktopMoveDialog'
import { DesktopResourceView } from './pages/DesktopResourceView'
import { DesktopShareDialog } from './pages/DesktopShareDialog'

const MAIN_ENTRY = path.resolve(__dirname, '../../dist/main.js')
const OWNER_BITS = ['delete', 'manage_acl', 'read', 'share', 'write']
/** The team-directory filter's one notice (GfsGrantList HIDDEN_ACCESS_NOTICE). */
const HIDDEN_MEMBERS_NOTICE =
  'Members outside your teams aren’t listed here. Access can also follow from parent folders you cannot see.'

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
  const trail = page.getByRole('navigation', { name: 'File location' })
  // The trail names the caller's home "My home", never its folder name.
  await expect(trail.getByRole('button', { name: 'My home', exact: true })).toBeVisible()
  await expect(trail.getByText(home.storageUsername ?? '', { exact: true })).toHaveCount(0)
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
    test.setTimeout(6 * RESPONSE_TIMEOUT_MS + 15 * 60_000)
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
        const nav = new DesktopFilesNav(page)
        await nav.openFiles()
        await nav.expectHomeOutsideSharedWithMe(home.storageUsername!)
        await openHomeFolder(page, home)
        await new DesktopResourceView(page).expectWritable()
        const ownerGrant = fx.accessFor(home.resourceId!, 'user', owner.id)
        expect(ownerGrant).toMatchObject({
          relation: 'grant',
          permissions: OWNER_BITS,
          inherit: true,
        })
      })
      const home = fx.readHome(owner.id)!
      await test.step('create a folder and a file through the UI', async () => {
        const view = new DesktopResourceView(page)
        await view.createFolder(folder)
        await enterFolder(page, folder)
        await view.uploadFile(file, Buffer.from(sentinel))
        fx.childId(fx.childId(home.resourceId!, folder), file)
      })
      const folderId = fx.childId(home.resourceId!, folder)
      const fileUri = `gfs://${home.drive}/${ridOf(fx.childId(folderId, file))}`
      const moved = `j1-moved-${fx.runTag}`
      await test.step('J1-N1 move a folder into My home from a nested folder', async () => {
        const view = new DesktopResourceView(page)
        await openHomeFolder(page, home)
        await enterFolder(page, folder)
        await view.createFolder(moved)
        const movedId = fx.childId(folderId, moved)
        await view.openMove(moved)
        const moveDialog = new DesktopMoveDialog(page)
        await moveDialog.expectDestinations(home.storageUsername!)
        await moveDialog.moveTo('My home')
        // Business signal: the same resource, under its new parent.
        expect(fx.childId(home.resourceId!, moved)).toBe(movedId)
        await openHomeFolder(page, home)
        await expect(page.getByRole('button', { name: `Open ${moved}` })).toBeVisible()
      })
      await test.step('J1-N2 the composer file picker shows My home apart from Shared files', async () => {
        await openExactAgent(page, getManagedAgentDisplayName(agent))
        await page.getByRole('button', { name: 'Add context' }).click()
        // The picker's entry point is the "EvenDrive" composer item (renamed
        // from "Global File System" in 6e587ff86); the flag that gates it kept
        // its original name.
        await expect(
          page.getByRole('menuitem', { name: 'EvenDrive', exact: true }),
          'The "Add context" menu has no "EvenDrive" item: the Desktop renderer was ' +
            'built without VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM=true. Rebuild the renderer ' +
            'with that flag (scripts/e2e/playwright-dev.sh exports it) and rerun.'
        ).toBeVisible({ timeout: 5_000 })
        await page.getByRole('menuitem', { name: 'EvenDrive', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Choose files for this message' })
        await expect(picker).toBeVisible({ timeout: 10_000 })
        // Root: the home is its own row, the shared listing settled empty, and
        // the home is never listed under its storage folder name.
        const homeRow = picker.getByRole('button', { name: /^My home/ })
        await expect(homeRow).toBeVisible()
        await expect(picker.getByText('No shared files yet', { exact: true })).toBeVisible()
        await expect(picker.getByText(home.storageUsername!, { exact: true })).toHaveCount(0)
        await homeRow.click()
        const location = picker.getByRole('navigation', { name: 'Global file path' })
        await expect(location.getByRole('button', { name: 'My home', exact: true })).toBeVisible()
        await expect(location.getByText(home.storageUsername!, { exact: true })).toHaveCount(0)
        const folderRow = picker
          .locator('.composer-global-files-row--folder')
          .filter({ hasText: folder })
        await expect(folderRow).toBeVisible({ timeout: 20_000 })
        await folderRow.click()
        const fileRow = picker.locator('.composer-global-files-row--file').filter({ hasText: file })
        await expect(fileRow).toBeVisible({ timeout: 20_000 })
        await fileRow.getByRole('checkbox').check()
        await picker.getByRole('button', { name: 'Attach 1' }).click()
        await expect(picker).toHaveCount(0)
        // Business signal: the attachment exists on the composer, then it is
        // removed so the later agent turns run without it.
        await expect(page.getByRole('button', { name: `Remove ${file}` })).toBeVisible()
        await page.getByRole('button', { name: `Remove ${file}` }).click()
        await expect(page.getByRole('button', { name: `Remove ${file}` })).toHaveCount(0)
      })
      await test.step('J1-N3 Shared with me keeps its view across workspace tabs; the home root tab reads My home', async () => {
        await openHomeFolder(page, home)
        const tabs = page.getByRole('toolbar', { name: 'Workspace tabs' })
        // D-5: the Files tab at the home root is titled "My home", not the
        // storage folder.
        await expect(tabs.getByRole('button', { name: 'My home', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true'
        )
        await new DesktopFilesNav(page).openSharedWithMe()
        await expect(
          tabs.getByRole('button', { name: 'Shared with me', exact: true })
        ).toHaveAttribute('aria-pressed', 'true')
        // Switch away to the agent: the Files tab keeps its shared location.
        await openExactAgent(page, getManagedAgentDisplayName(agent))
        await expect(page.getByRole('textbox', { name: 'Agent message composer' })).toBeVisible()
        await expect(
          tabs.getByRole('button', { name: 'Shared with me', exact: true })
        ).toHaveAttribute('aria-pressed', 'false')
        // Return: the Shared with me view is restored, not the overview.
        await tabs.getByRole('button', { name: 'Shared with me', exact: true }).click()
        const browser = page.getByRole('region', { name: 'EvenDrive browser' })
        await expect(
          browser
            .getByRole('navigation', { name: 'File location' })
            .getByRole('button', { name: 'Shared with me', exact: true })
        ).toHaveAttribute('aria-current', 'page')
        await expect(browser.getByText('No shared files yet', { exact: true })).toBeVisible()
        // Secondary guard: the tab did not fall back to the overview, whose
        // only content here would be the "My home" card.
        await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0)
      })
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
          .getByRole('button', { name: 'My home', exact: true })
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

  test("J1b sharing with users follows the Unix model; entries for people outside the owner's teams are hidden and an operator removes them", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(20 * 60_000)
    const adminUser = requiredEnv('ADMIN_USER')
    const adminPass = requiredEnv('ADMIN_PASS')
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const owner = fx.createUser('j1b-owner')
    const b = fx.createUser('j1b-b')
    const c = fx.createUser('j1b-c')
    const d = fx.createUser('j1b-d')
    fx.createTeam('owner-b', [owner, b, d])
    fx.createTeam('b-c', [b, c]) // C shares a team with B but not with the owner (A1)
    const outer = `j1b-outer-${fx.runTag}`
    const inner = `j1b-inner-${fx.runTag}`
    const sibling = `j1b-sibling-${fx.runTag}`
    const file = `j1b-file-${fx.runTag}.txt`
    const sessions: DesktopSession[] = []
    const control = await newOperatorContext(browser)
    let shareId: string | null = null
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
      const dRows = () =>
        fx.accessRows(outerId).filter(row => row.subjectType === 'user' && row.subjectId === d.id)
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
      await test.step("B's Editor share to D exists while B holds every bit (named precondition)", async () => {
        // Named precondition: no UI writes share rows (see seedShare). One seed
        // only — a second share row for D would hit the unique key (A-L1). The
        // row is the one the API accepts from B while B holds every bit.
        shareId = fx.seedShare(home.drive!, outerId, b, d, ['read', 'write', 'share'])
        expect(dRows()).toEqual([
          expect.objectContaining({ id: shareId, relation: 'share', inherit: true }),
        ])
      })
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
        // Revoking B removed B's grant only: B's share to D survives.
        expect(dRows()).toHaveLength(1)
      })
      await test.step("C's entry is hidden from the owner; an operator removes it in Control UI", async () => {
        const cGrant = fx.accessFor(outerId, 'user', c.id)
        if (!cGrant) throw new Error('J1b: C’s grant row is missing before the owner opens Share')
        await openHomeFolder(ownerS.page, home)
        await view.openShare(outer)
        const shareDialog = ownerS.page.getByRole('dialog', { name: `Share folder ${outer}` })
        const access = ownerS.page.getByRole('list', { name: 'Resource access' })
        // Witnesses inside the same list that hides C: the owner's own
        // inherited row (labelled by name — the owner is in owner-b), D's share
        // row with its role control, and the one notice that replaces the rows
        // the team directory cannot name.
        const ownerRow = access
          .getByRole('listitem')
          .filter({ has: ownerS.page.getByText('Owner', { exact: true }) })
        await expect(ownerRow).toHaveCount(1)
        await expect(ownerRow).toContainText(owner.name)
        await expect(access.getByRole('button', { name: `Access role for ${d.name}` })).toHaveCount(
          1
        )
        await expect(shareDialog.getByText(HIDDEN_MEMBERS_NOTICE, { exact: true })).toBeVisible()
        // Negatives: C's grant row is absent by its own testid (a row rendered
        // under any label fails this), and neither C's name nor email shows.
        await expect(shareDialog.getByTestId(`gfs-access-row-grant-${cGrant.id}`)).toHaveCount(0)
        await expect(shareDialog.getByText(c.name, { exact: true })).toHaveCount(0)
        await expect(shareDialog.getByText(c.email, { exact: true })).toHaveCount(0)
        await ownerS.page.keyboard.press('Escape')

        // An operator sees every row, including C's, and removes it.
        const operatorPage = await control.newPage()
        const operatorPanel = new ControlUiAccessPanel(operatorPage)
        await operatorPanel.login(adminUser, adminPass)
        await operatorPanel.openResource(`/Users/${home.storageUsername}/${outer}`)
        await operatorPanel.revoke({ label: c.name })
        expect(fx.accessFor(outerId, 'user', c.id)).toBeNull()

        // C loses access; the owner still opens the file two levels down.
        await openEvenDriveLink(cS.page, `gfs://${home.drive}/${ridOf(outerId)}`)
        await expectRefusedLinkAndClose(cS.page)
        await openHomeFolder(ownerS.page, home)
        await enterFolder(ownerS.page, outer)
        await enterFolder(ownerS.page, inner)
        await expect(ownerS.page.getByRole('button', { name: `Open ${file}` })).toBeVisible()
        // C is not used again: close the session now and stop tracking it.
        const cIndex = sessions.indexOf(cS)
        if (cIndex < 0) throw new Error('J1b: C’s Desktop session is not tracked')
        sessions.splice(cIndex, 1)
        await cS.close()
      })
      await test.step('owner lowers the Editor share B made to D to Read (D26, D9)', async () => {
        // The same share row seeded in step 5: no new seed here (A-L1).
        const seededShareId = shareId
        if (!seededShareId) throw new Error('J1b: the seeded share id from step 5 is missing')
        expect(dRows()).toEqual([
          expect.objectContaining({ id: seededShareId, relation: 'share', inherit: true }),
        ])
        const outerUri = `gfs://${home.drive}/${ridOf(outerId)}`
        const dS = await launchDesktopAs(testInfo, d)
        sessions.push(dS)
        await new DesktopFilesNav(dS.page).openFiles()
        await new DesktopFilesNav(dS.page).openSharedWithMe()
        await enterFolder(dS.page, outer)
        await enterFolder(dS.page, inner)
        await expect(dS.page.getByRole('button', { name: `Open ${file}` })).toBeVisible()
        const innerRow = dS.page.getByRole('button', { name: `Open ${inner}` })
        // D's effective bits on the folder, read through D's own authenticated
        // Desktop session.
        const dHeld = () =>
          dS.page.evaluate(
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
        await expect.poll(dHeld).toEqual(expect.arrayContaining(['read', 'write']))
        // D reaches the folder through the share (positive).
        await openEvenDriveLink(dS.page, outerUri)
        await expect(innerRow).toBeVisible()
        await openHomeFolder(ownerS.page, home)
        await view.openShare(outer)
        await new DesktopShareDialog(ownerS.page).lowerShare(d.name)
        expect(dRows()).toEqual([
          expect.objectContaining({
            id: seededShareId,
            relation: 'share',
            permissions: ['read', 'share'],
            inherit: true,
          }),
        ])
        await ownerS.page.keyboard.press('Escape')
        // Lowering narrows the share without revoking it: D keeps read and
        // loses write, and opens the folder again after leaving it.
        await expect.poll(dHeld).not.toContain('write')
        expect(await dHeld()).toContain('read')
        await openHomeFolder(dS.page, await fx.waitForHomeState(d.id, 'ready'))
        await expect(innerRow).toHaveCount(0)
        await openEvenDriveLink(dS.page, outerUri)
        await expect(innerRow).toBeVisible()
      })
    } finally {
      await control.close()
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
          .getByRole('button', { name: 'My home', exact: true })
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
        // U1 keeps the in-team label: the owner is in B's team directory, so
        // the row names them next to "Owner".
        await expect(ownerRow).toContainText(owner.name)
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
            .getByRole('button', { name: 'My home', exact: true })
        ).toHaveAttribute('aria-current', 'page')
        await new DesktopResourceView(adminPage).expectWritable()
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

  test('J7a Recent files are per user: own opens, agent reads, writes and copies for that user only', async ({}, testInfo) => {
    test.setTimeout(5 * RESPONSE_TIMEOUT_MS + 45 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const agent = discoverManagedGfsAgent()
    const owner = fx.createUser('j7a-owner')
    const a = fx.createUser('j7a-a')
    const b = fx.createUser('j7a-b')
    const folder = `j7a-shared-${fx.runTag}`
    const destination = `j7a-dest-${fx.runTag}`
    const f1 = `j7a-f1-${fx.runTag}.txt`
    const f2 = `j7a-f2-${fx.runTag}.txt`
    const f3 = `j7a-f3-${fx.runTag}.txt`
    const copyName = `j7a-f1-copy-${fx.runTag}.txt`
    const written = `J7a written ${fx.runTag}`
    let ownerS: DesktopSession | null = null
    let aS: DesktopSession | null = null
    let bS: DesktopSession | null = null
    try {
      fx.createTeam('j7a', [owner, a, b])
      fx.associateAgent(owner, agent)
      fx.associateAgent(a, agent)
      fx.associateAgent(b, agent)
      const ownerHome = await fx.waitForHomeState(owner.id, 'ready')
      await fx.waitForHomeState(a.id, 'ready')
      await fx.waitForHomeState(b.id, 'ready')

      ownerS = await launchDesktopAs(testInfo, owner)
      await test.step('J7a-1 O writes three files and a destination folder, then shares the folder', async () => {
        const page = ownerS!.page
        const view = new DesktopResourceView(page)
        await openHomeFolder(page, ownerHome)
        await view.createFolder(folder)
        await enterFolder(page, folder)
        for (const [name, sentinel] of [
          [f1, `J7a f1 ${fx.runTag}`],
          [f2, `J7a f2 ${fx.runTag}`],
          [f3, `J7a f3 ${fx.runTag}`],
        ]) {
          await view.uploadFile(name, Buffer.from(sentinel))
        }
        await view.createFolder(destination)
        await openHomeFolder(page, ownerHome)
        await view.openShare(folder)
        const dialog = new DesktopShareDialog(page)
        await dialog.grant(a.name, 'Read', { includeContents: true })
        await dialog.grant(b.name, 'Read', { includeContents: true })
        await dialog.grant(agent.name, 'Editor', { includeContents: true })
        await dialog.close()
        const folderId = fx.childId(ownerHome.resourceId!, folder)
        expect(fx.accessFor(folderId, 'user', a.id)).toBeTruthy()
        expect(fx.accessFor(folderId, 'user', b.id)).toBeTruthy()
        expect(fx.accessFor(folderId, 'host', agent.subjectId)).toBeTruthy()
      })
      const folderId = fx.childId(ownerHome.resourceId!, folder)
      const f1Id = fx.childId(folderId, f1)
      const f2Id = fx.childId(folderId, f2)
      const f3Id = fx.childId(folderId, f3)
      const folderUri = `gfs://${ownerHome.drive}/${ridOf(folderId)}`
      const f2Uri = `gfs://${ownerHome.drive}/${ridOf(f2Id)}`
      const f3Uri = `gfs://${ownerHome.drive}/${ridOf(f3Id)}`

      await test.step("J7a-2 O's own uploads are his recent files, newest first", async () => {
        const page = ownerS!.page
        const nav = new DesktopFilesNav(page)
        await nav.expectRecentFiles([f3, f2, f1])
        expect(fx.recentActivity(owner.id).map(row => row.resourceId)).toEqual([f3Id, f2Id, f1Id])
      })
      const ownerActivity = fx.recentActivity(owner.id)
      const ownerTimestamps = new Map(
        ownerActivity.map(row => [row.resourceId, row.lastActivityAt])
      )

      aS = await launchDesktopAs(testInfo, a)
      await test.step('J7a-3 a listing is not activity, and the card is overview-only', async () => {
        const page = aS!.page
        const nav = new DesktopFilesNav(page)
        await nav.expectNoRecentCardInSharedWithMe()
        await nav.openSharedWithMe()
        await enterFolder(page, folder)
        await expect(page.getByRole('button', { name: `Open ${f1}` })).toBeVisible()
        await nav.expectNoRecentFiles()
        expect(fx.recentActivity(a.id)).toEqual([])
      })
      await test.step("J7a-4 A's open counts for A", async () => {
        const page = aS!.page
        const nav = new DesktopFilesNav(page)
        await nav.openSharedWithMe()
        await enterFolder(page, folder)
        await page.getByRole('button', { name: `Open ${f1}` }).click()
        await expect(page.getByRole('article', { name: `Text preview of ${f1}` })).toBeVisible({
          timeout: 60_000,
        })
        await nav.expectRecentFiles([f1])
        expect(fx.recentActivity(a.id).map(row => row.resourceId)).toEqual([f1Id])
      })

      bS = await launchDesktopAs(testInfo, b)
      await test.step('J7a-5 B has access without activity, then an open of the same file', async () => {
        const page = bS!.page
        const nav = new DesktopFilesNav(page)
        await nav.expectNoRecentFiles()
        await nav.openSharedWithMe()
        await enterFolder(page, folder)
        await expect(page.getByRole('button', { name: `Open ${f1}` })).toBeVisible()
        await nav.expectNoRecentFiles()
        await page.getByRole('button', { name: `Open ${f1}` }).click()
        await expect(page.getByRole('article', { name: `Text preview of ${f1}` })).toBeVisible({
          timeout: 60_000,
        })
        await nav.expectRecentFiles([f1])
      })

      await test.step("J7a-6 other users do not reorder O's list", async () => {
        const page = ownerS!.page
        const nav = new DesktopFilesNav(page)
        await nav.expectRecentFiles([f3, f2, f1])
        const now = new Map(
          fx.recentActivity(owner.id).map(row => [row.resourceId, row.lastActivityAt])
        )
        expect(now.get(f1Id)).toBe(ownerTimestamps.get(f1Id))
        expect(now.get(f2Id)).toBe(ownerTimestamps.get(f2Id))
        expect(now.get(f3Id)).toBe(ownerTimestamps.get(f3Id))
      })

      await test.step('J7a-7 D9 agent read: f2 becomes recent for A only, and the binding names the namespace', async () => {
        const page = aS!.page
        await page.getByRole('navigation', { name: 'Main navigation' }).getByText('Chat').click()
        await openExactAgent(page, getManagedAgentDisplayName(agent))
        const { stepper, responseText } = await sendAgentTurn(page, readPrompt(f2Uri))
        assertNoInfraFailureShape(responseText)
        await expectReadWithSentinel(stepper, `J7a f2 ${fx.runTag}`)
        const binding = fx.directRunBinding(a.id, agent.name)
        expect(binding).toHaveLength(1)
        expect(binding[0]!.count).toBeGreaterThanOrEqual(1)
        expect(binding[0]!.hostNamespace).toBe(agent.subjectId.split('/')[0]!.replace('1st:', ''))
        const nav = new DesktopFilesNav(page)
        await nav.expectRecentFiles([f2, f1])
        const bNav = new DesktopFilesNav(bS!.page)
        await bNav.expectRecentFiles([f1])
        // Witness: B really can read f2 in the shared folder.
        await bNav.openSharedWithMe()
        await enterFolder(bS!.page, folder)
        await expect(bS!.page.getByRole('button', { name: `Open ${f2}` })).toBeVisible()
        const now = new Map(
          fx.recentActivity(owner.id).map(row => [row.resourceId, row.lastActivityAt])
        )
        expect(now.get(f3Id)).toBe(ownerTimestamps.get(f3Id))
      })

      await test.step("J7a-8 D9 agent write: f3 becomes A's newest file only", async () => {
        const page = aS!.page
        await openExactAgent(page, getManagedAgentDisplayName(agent))
        const { stepper, responseText } = await sendAgentTurn(page, writePrompt(f3Uri, written))
        assertNoInfraFailureShape(responseText)
        await expectToolSuccess(stepper, 'gfs_write')
        const nav = new DesktopFilesNav(page)
        await nav.expectRecentFiles([f3, f2, f1])
        const bNav = new DesktopFilesNav(bS!.page)
        await bNav.expectRecentFiles([f1])
        const now = new Map(
          fx.recentActivity(owner.id).map(row => [row.resourceId, row.lastActivityAt])
        )
        expect(now.get(f3Id)).toBe(ownerTimestamps.get(f3Id))
      })

      let copyId = ''
      await test.step("J7a-9 D16 agent copy: every file the copy created is A's activity", async () => {
        const page = aS!.page
        await openExactAgent(page, getManagedAgentDisplayName(agent))
        const { stepper, responseText } = await sendAgentTurn(
          page,
          `Read ${f1} from ${folderUri} with clerum__gfs_list and clerum__gfs_read, then copy ` +
            `that file into ${destination} with clerum__gfs_copy under the name ${copyName}. ` +
            `Use only the native GFS tools.`
        )
        assertNoInfraFailureShape(responseText)
        await expectToolSuccess(stepper, 'gfs_read')
        await expectToolSuccess(stepper, 'gfs_copy')
        const destinationId = fx.childId(folderId, destination)
        copyId = fx.childId(destinationId, copyName)
        const nav = new DesktopFilesNav(page)
        await nav.expectRecentFiles([copyName, f1, f3, f2])
        expect(
          fx
            .recentActivity(a.id)
            .map(row => row.resourceId)
            .slice(0, 4)
        ).toEqual([copyId, f1Id, f3Id, f2Id])
        const bNav = new DesktopFilesNav(bS!.page)
        await bNav.expectRecentFiles([f1])
        // Witness: B sees the copy inside the destination folder.
        await bNav.openSharedWithMe()
        await enterFolder(bS!.page, folder)
        await enterFolder(bS!.page, destination)
        await expect(bS!.page.getByRole('button', { name: `Open ${copyName}` })).toBeVisible()
        const now = new Map(
          fx.recentActivity(owner.id).map(row => [row.resourceId, row.lastActivityAt])
        )
        expect(now.get(f3Id)).toBe(ownerTimestamps.get(f3Id))
      })

      await test.step("J7a-10 opening from the card records again and shows the agent's write", async () => {
        const page = aS!.page
        const nav = new DesktopFilesNav(page)
        const before = fx.recentActivity(a.id).find(row => row.resourceId === f3Id)!.lastActivityAt
        await nav.openEvenDriveOverview()
        await nav.openRecentFile(f3)
        await expect(page.getByRole('article', { name: `Text preview of ${f3}` })).toBeVisible({
          timeout: 60_000,
        })
        await expect(page.getByText(written, { exact: false })).toBeVisible()
        const after = fx.recentActivity(a.id)
        expect(after[0]!.resourceId).toBe(f3Id)
        expect(after[0]!.lastActivityAt > before).toBe(true)
      })

      await test.step("J7a-11 revoking A's share hides its rows without deleting them", async () => {
        const page = ownerS!.page
        const view = new DesktopResourceView(page)
        await openHomeFolder(page, ownerHome)
        await view.openShare(folder)
        const dialog = new DesktopShareDialog(page)
        await dialog.revoke(a.name)
        await dialog.close()
        expect(fx.accessFor(folderId, 'user', a.id)).toBeNull()

        const aNav = new DesktopFilesNav(aS!.page)
        await aNav.expectNoRecentFiles()
        expect(fx.recentActivity(a.id)).toHaveLength(4)
        const bNav = new DesktopFilesNav(bS!.page)
        await bNav.expectRecentFiles([f1])
      })

      await test.step('J7a-12 deleting the file hides it from every list', async () => {
        const page = ownerS!.page
        const view = new DesktopResourceView(page)
        await openHomeFolder(page, ownerHome)
        await enterFolder(page, folder)
        await view.deleteResource(f1)

        const bNav = new DesktopFilesNav(bS!.page)
        await bNav.expectNoRecentFiles()
        expect(fx.recentActivity(b.id).map(row => row.resourceId)).toEqual([f1Id])
        const oNav = new DesktopFilesNav(ownerS!.page)
        await oNav.expectRecentFiles([f3, f2])
      })
    } finally {
      await aS?.close()
      await bS?.close()
      await ownerS?.close()
      fx.cleanup()
    }
  })

  test('J7b Recent files: five initially, load more in their own view; a ZIP export records nothing', async ({}, testInfo) => {
    test.setTimeout(4 * RESPONSE_TIMEOUT_MS + 30 * 60_000)
    const fx = new UserHomeFixtures(runTagFor(testInfo))
    const owner = fx.createUser('j7b-owner')
    const a = fx.createUser('j7b-a')
    const folder = `j7b-zip-${fx.runTag}`
    const names = Array.from(
      { length: 24 },
      (_, index) => `j7b-z${String(index + 1).padStart(2, '0')}-${fx.runTag}.txt`
    )
    let ownerS: DesktopSession | null = null
    let aS: DesktopSession | null = null
    try {
      fx.createTeam('j7b', [owner, a])
      const ownerHome = await fx.waitForHomeState(owner.id, 'ready')
      await fx.waitForHomeState(a.id, 'ready')
      ownerS = await launchDesktopAs(testInfo, owner)
      const page = ownerS.page
      await test.step('J7b-1 O uploads 24 files and shares the folder', async () => {
        const view = new DesktopResourceView(page)
        await openHomeFolder(page, ownerHome)
        await view.createFolder(folder)
        await enterFolder(page, folder)
        for (const [index, name] of names.entries()) {
          await view.uploadFile(name, Buffer.from(`J7b z${index + 1} ${fx.runTag}`))
        }
        await openHomeFolder(page, ownerHome)
        await view.openShare(folder)
        const dialog = new DesktopShareDialog(page)
        await dialog.grant(a.name, 'Read', { includeContents: true })
        await dialog.close()
        const folderId = fx.childId(ownerHome.resourceId!, folder)
        expect(fx.accessFor(folderId, 'user', a.id)).toBeTruthy()
        const activity = fx.recentActivity(owner.id)
        expect(activity).toHaveLength(24)
        expect(activity.map(row => row.resourceId)).toEqual(
          [...names].reverse().map(name => fx.childId(folderId, name))
        )
        const timestamps = activity.map(row => row.lastActivityAt)
        expect(new Set(timestamps).size).toBe(24)
      })
      await test.step('J7b-2 the overview fits recent files and both destinations', async () => {
        const nav = new DesktopFilesNav(page)
        const newest = [...names].reverse()
        await nav.openEvenDriveOverview()
        await expect(nav.recentFiles()).toHaveAttribute('aria-busy', 'false')
        await expect.poll(async () => [5, 10].includes(await nav.recentRows().count())).toBe(true)
        const overviewCount = await nav.recentRows().count()
        await nav.expectRecentFiles(newest.slice(0, overviewCount))
        await expect(nav.recentFiles().getByRole('button', { name: 'Load more' })).toHaveCount(0)
        await expect(page.getByRole('region', { name: 'My home' })).toBeInViewport({ ratio: 1 })
        await expect(page.getByRole('region', { name: 'Shared with me' })).toBeInViewport({
          ratio: 1,
        })
        await page.getByRole('region', { name: 'My home' }).getByRole('button').click()
        await expect(
          page
            .getByRole('toolbar', { name: 'Workspace tabs' })
            .getByRole('button', { name: 'My home', exact: true })
        ).toHaveAttribute('aria-pressed', 'true')
        await nav.openEvenDriveOverview()
        await page.getByRole('region', { name: 'Shared with me' }).getByRole('button').focus()
        await page.keyboard.press('Enter')
        const sharedTab = page
          .getByRole('toolbar', { name: 'Workspace tabs' })
          .getByRole('button', {
            name: 'Shared with me',
            exact: true,
          })
        await expect(sharedTab).toHaveAttribute('aria-pressed', 'true')
        await expect(sharedTab).toBeFocused()
        await nav.openEvenDriveOverview()
      })
      await test.step('J7b-3 the sidebar opens a separate view with activity times and Load more', async () => {
        const nav = new DesktopFilesNav(page)
        await page.getByRole('treeitem', { name: 'Recent files', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Files', level: 2 })).toBeVisible()
        await expect(nav.recentFiles().getByRole('heading', { name: 'Recent files' })).toBeVisible()
        await expect(nav.recentRows()).toHaveCount(5)
        await expect
          .poll(() =>
            nav.recentRows().evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))
          )
          .toEqual(
            [...names]
              .reverse()
              .slice(0, 5)
              .map(name => `Open ${name}`)
          )
        await expect(nav.recentFiles().locator('time')).toHaveCount(5)
        const newestRow = nav.recentFiles().getByRole('button', {
          name: `Open ${names[23]}`,
          exact: true,
        })
        await expect(newestRow.locator('time')).toContainText(/\d/)
        await expect(newestRow.locator('time')).toHaveAttribute('datetime', /.+/)
        await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0)
        await expect(page.getByRole('region', { name: 'EvenDrive browser' })).toHaveCount(0)
        const loadMore = nav.recentFiles().getByRole('button', { name: 'Load more', exact: true })
        await loadMore.click()
        await expect(nav.recentRows()).toHaveCount(10)
        await newestRow.click()
        await expect(
          page.getByRole('article', { name: `Text preview of ${names[23]}` })
        ).toBeVisible()
        await page
          .getByRole('toolbar', { name: 'Workspace tabs' })
          .getByRole('button', { name: 'Recent files', exact: true })
          .click()
        await expect(nav.recentRows()).toHaveCount(10)
        for (const count of [15, 20, 24]) {
          await loadMore.click()
          await expect(nav.recentRows()).toHaveCount(count)
        }
        await expect
          .poll(() =>
            nav.recentRows().evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))
          )
          .toEqual([...names].reverse().map(name => `Open ${name}`))
        await expect(loadMore).toHaveCount(0)
      })

      aS = await launchDesktopAs(testInfo, a)
      await test.step('J7b-4 a ZIP export records nothing (D10)', async () => {
        const aPage = aS!.page
        const nav = new DesktopFilesNav(aPage)
        await nav.expectNoRecentFiles()
        const zipPath = testInfo.outputPath('j7b.zip')
        await stubSaveDialog(aS!.app, zipPath)
        await nav.openSharedWithMe()
        await new DesktopResourceView(aPage).downloadZip(folder)
        await expect(aPage.getByText(/^Downloaded .*\(24 files\)$/)).toBeVisible({
          timeout: 120_000,
        })
        // Liveness: the archive reached the disk with content, so every entry
        // really was read by the export.
        await expect
          .poll(() => fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0, {
            timeout: 60_000,
          })
          .toBe(true)
        await nav.expectNoRecentFiles()
        expect(fx.recentActivity(a.id)).toEqual([])
      })
      await test.step("J7b-5 A's own recording path is live", async () => {
        const aPage = aS!.page
        const nav = new DesktopFilesNav(aPage)
        await nav.openSharedWithMe()
        await enterFolder(aPage, folder)
        await aPage.getByRole('button', { name: `Open ${names[0]}` }).click()
        await expect(
          aPage.getByRole('article', { name: `Text preview of ${names[0]}` })
        ).toBeVisible({ timeout: 60_000 })
        await nav.expectRecentFiles([names[0]!])
        const folderId = fx.childId(ownerHome.resourceId!, folder)
        expect(fx.recentActivity(a.id).map(row => row.resourceId)).toEqual([
          fx.childId(folderId, names[0]!),
        ])
      })
    } finally {
      await aS?.close()
      await ownerS?.close()
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
        await expect(
          ownerS.page
            .getByRole('navigation', { name: 'File location' })
            .getByRole('button', { name: 'My home', exact: true })
        ).toHaveAttribute('aria-current', 'page')
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
