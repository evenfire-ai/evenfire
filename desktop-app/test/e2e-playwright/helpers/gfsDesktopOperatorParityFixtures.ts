import {
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  type Page,
  type TestInfo,
  type WorkerInfo,
  test as base,
  _electron as electron,
  expect,
} from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  UUID_RE,
  firstDataLine,
  kubectlOut,
  runControlPostgresSql,
  splitSqlRow,
  sqlLiteral,
} from '../../../../tests/e2e/gfsFixtureCore'
import { cleanupGfsFixture } from '../../../../tests/e2e/gfsResourceFixtures'
import { requireGfsOperatorRunId } from '../gfsDesktopOperatorParityContract'
import { openResourcesNavItem } from '../navigationHelpers'

const DESKTOP_APP_ROOT = path.resolve(__dirname, '../../..')
const MAIN_ENTRY = path.join(DESKTOP_APP_ROOT, 'dist/main.js')

function configuredUrl(label: string, candidates: Array<string | undefined>): string {
  const value = candidates.find(candidate => candidate?.trim())?.trim()
  if (!value) throw new Error(`[GFS-OPERATOR-E2E] ${label} is required.`)
  return value.replace(/\/$/, '')
}

function safeTraceName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function bcryptHash(password: string): string {
  const output = kubectlOut(
    [
      '-n',
      'control-plane',
      'exec',
      '-i',
      'deploy/control-api',
      '--',
      'node',
      '-e',
      [
        "const bcrypt = require('bcryptjs')",
        "let input = ''",
        "process.stdin.on('data', chunk => { input += chunk })",
        "process.stdin.on('end', async () => console.log(await bcrypt.hash(input.trim(), 12)))",
      ].join(';'),
    ],
    20_000,
    password
  ).trim()
  if (!/^\$2[aby]\$/.test(output)) {
    throw new Error('[GFS-OPERATOR-E2E] bcrypt fixture hash generation failed.')
  }
  return output
}

export interface OperatorLinkRow {
  desktopUserId: string
  controlAdminId: string
  source: string
}

export interface GfsResourceRow {
  resourceId: string
  name: string
  kind: 'directory' | 'file'
  bytes: number
  version: number
  deleted: boolean
}

export interface GfsAuditRow {
  sequenceNo: number
  subject: string
  actorOnBehalfOf: string | null
  desktopUserId: string | null
  authoritySource: string | null
  op: string
  outcome: string
  recordType: string | null
  mutationOutcome: string | null
  requestId: string | null
  gfsUri: string | null
}

export class GfsDesktopOperatorJourney {
  readonly runId = requireGfsOperatorRunId()
  readonly runTag = createHash('sha256').update(this.runId).digest('hex').slice(0, 10)
  readonly operatorUsername = `gfsop-${this.runTag}`
  readonly operatorEmail = `e2e-gfs-operator-${this.runTag}@example.invalid`
  readonly operatorPassword = `Gfs!${randomBytes(24).toString('base64url')}`
  readonly ordinaryEmail = `e2e-gfs-unlinked-${this.runTag}@example.invalid`
  readonly ordinaryName = `GFS Unlinked ${this.runTag}`
  readonly ordinaryPassword = `Gfs!${randomBytes(24).toString('base64url')}`
  readonly names = {
    crudFolder: `e2e-gfs-op-${this.runTag}-crud`,
    renamedFolder: `e2e-gfs-op-${this.runTag}-renamed`,
    rootFile: `e2e-gfs-op-${this.runTag}-root.md`,
    nestedFile: `e2e-gfs-op-${this.runTag}-nested.md`,
    renamedFile: `e2e-gfs-op-${this.runTag}-updated.md`,
    grantFolder: `e2e-gfs-op-${this.runTag}-grant`,
    shareFolder: `e2e-gfs-op-${this.runTag}-share`,
    ordinaryFolder: `e2e-gfs-op-${this.runTag}-ordinary`,
    deniedFolder: `e2e-gfs-op-${this.runTag}-denied`,
    auditDeniedFolder: `e2e-gfs-op-${this.runTag}-audit-denied`,
  }

  readonly controlUiUrl = configuredUrl('CONTROL_UI_BASE_URL', [
    process.env.CONTROL_UI_BASE_URL,
    process.env.CONTROL_UI_URL,
  ])
  readonly controlApiUrl = configuredUrl('CONTROL_API_BASE_URL', [
    process.env.CONTROL_API_BASE_URL,
    process.env.CONTROL_API_URL,
    process.env.E2E_CONTROL_API_URL,
  ])
  readonly externalRestUrl = configuredUrl('EXTERNAL_REST_API_BASE_URL', [
    process.env.EXTERNAL_REST_API_BASE_URL,
    process.env.EXTERNAL_REST_API_URL,
    process.env.E2E_EXTERNAL_REST_API_URL,
  ])
  readonly rpcProxyUrl = configuredUrl('RPC_PROXY_BASE_URL', [
    process.env.RPC_PROXY_BASE_URL,
    process.env.RPC_PROXY_URL,
    process.env.E2E_RPC_PROXY_URL,
  ])

  controlContext: BrowserContext | null = null
  controlPage: Page | null = null
  operatorApp: ElectronApplication | null = null
  operatorPage: Page | null = null
  operatorContext: BrowserContext | null = null
  operatorUserDataDir: string | null = null
  operatorVideoDir: string | null = null
  operatorLink: OperatorLinkRow | null = null
  ordinaryUserId: string | null = null
  ordinaryTeamId: string | null = null
  rootResourceId: string | null = null
  resources = new Map<string, GfsResourceRow>()
  successfulCreateAuditFloor = 0
  deniedAuditFloor = 0

  private activeTestInfo: TestInfo | null = null
  private operatorTraceActive = false
  private controlTraceActive = false
  private readonly liveDesktopPages = new Set<Page>()

  constructor(
    private readonly browser: Browser,
    private readonly workerInfo: WorkerInfo
  ) {}

  async start(): Promise<void> {
    this.controlContext = await this.browser.newContext({ baseURL: this.controlUiUrl })
    this.controlPage = await this.controlContext.newPage()
  }

  async beginTest(testInfo: TestInfo): Promise<void> {
    this.activeTestInfo = testInfo
    if (this.controlContext) {
      await this.controlContext.tracing.start({ screenshots: true, snapshots: true, sources: true })
      this.controlTraceActive = true
    }
    if (this.operatorContext) {
      await this.operatorContext.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      })
      this.operatorTraceActive = true
    }
  }

  async endTest(testInfo: TestInfo): Promise<void> {
    const failed = testInfo.status !== testInfo.expectedStatus
    const traceName = safeTraceName(testInfo.title)
    if (failed) {
      for (const [index, page] of [...this.liveDesktopPages].entries()) {
        if (page.isClosed()) continue
        const screenshotPath = testInfo.outputPath(`desktop-${index + 1}.png`)
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined)
        if (fs.existsSync(screenshotPath)) {
          await testInfo.attach(`desktop-${index + 1}`, {
            path: screenshotPath,
            contentType: 'image/png',
          })
        }
      }
      if (this.controlPage && !this.controlPage.isClosed()) {
        const screenshotPath = testInfo.outputPath('control-ui.png')
        await this.controlPage
          .screenshot({ path: screenshotPath, fullPage: true })
          .catch(() => undefined)
        if (fs.existsSync(screenshotPath)) {
          await testInfo.attach('control-ui', { path: screenshotPath, contentType: 'image/png' })
        }
      }
    }
    if (this.operatorTraceActive && this.operatorContext) {
      const tracePath = testInfo.outputPath(`${traceName}-electron-trace.zip`)
      await this.operatorContext.tracing.stop({ path: failed ? tracePath : undefined })
      this.operatorTraceActive = false
      if (failed && fs.existsSync(tracePath)) {
        await testInfo.attach('electron-trace', { path: tracePath, contentType: 'application/zip' })
      }
    }
    if (this.controlTraceActive && this.controlContext) {
      const tracePath = testInfo.outputPath(`${traceName}-control-trace.zip`)
      await this.controlContext.tracing.stop({ path: failed ? tracePath : undefined })
      this.controlTraceActive = false
      if (failed && fs.existsSync(tracePath)) {
        await testInfo.attach('control-ui-trace', {
          path: tracePath,
          contentType: 'application/zip',
        })
      }
    }
    this.activeTestInfo = null
  }

  async finish(): Promise<void> {
    const cleanupErrors: unknown[] = []
    for (const name of new Set([
      this.names.crudFolder,
      this.names.renamedFolder,
      this.names.rootFile,
      this.names.grantFolder,
      this.names.shareFolder,
      this.names.ordinaryFolder,
      this.names.deniedFolder,
      this.names.auditDeniedFolder,
    ])) {
      try {
        cleanupGfsFixture(name)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    for (const app of [this.operatorApp]) {
      await app?.close().catch(error => cleanupErrors.push(error))
    }
    await this.controlContext?.close().catch(error => cleanupErrors.push(error))
    if (this.ordinaryUserId) {
      try {
        runControlPostgresSql(`
          DELETE FROM users
           WHERE id = ${sqlLiteral(this.ordinaryUserId)}::uuid
             AND email = ${sqlLiteral(this.ordinaryEmail)}
             AND email LIKE 'e2e-gfs-unlinked-%@example.invalid';
        `)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (this.operatorUserDataDir) {
      try {
        const resolved = path.resolve(this.operatorUserDataDir)
        const allowedRoot = path.resolve(this.workerInfo.project.outputDir)
        if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) {
          throw new Error(`refusing to remove user data outside ${allowedRoot}`)
        }
        if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'GFS operator E2E cleanup did not complete')
    }
  }

  async bootstrapInitialAdmin(): Promise<{ controlAdminId: string }> {
    const response = await fetch(`${this.controlApiUrl}/admin/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: this.operatorEmail,
        username: this.operatorUsername,
        password: this.operatorPassword,
        seedDesktopPassword: true,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      me?: { id?: string; email?: string; username?: string }
    }
    if (response.status === 409) {
      throw new Error(
        '[GFS-OPERATOR-E2E] /admin/auth/setup returned 409. This one-shot journey requires a fresh, branch-owned profile whose bootstrap has not been consumed; no database reset or link insertion is performed by the suite.'
      )
    }
    if (response.status !== 200 || !UUID_RE.test(body.me?.id ?? '')) {
      throw new Error(
        `[GFS-OPERATOR-E2E] /admin/auth/setup returned HTTP ${response.status}: ${body.error ?? JSON.stringify(body)}`
      )
    }
    expect(body.me).toMatchObject({
      email: this.operatorEmail,
      username: this.operatorUsername,
    })
    return { controlAdminId: body.me!.id! }
  }

  readOperatorLink(): OperatorLinkRow | null {
    const row = firstDataLine(
      runControlPostgresSql(`
        SELECT user_id::text, control_admin_id::text, source
          FROM gfs_desktop_operator_links
         WHERE control_admin_id IN (
           SELECT id FROM control_admin_users WHERE lower(email) = lower(${sqlLiteral(this.operatorEmail)})
         )
         LIMIT 1;
      `)
    )
    if (!row) return null
    const [desktopUserId, controlAdminId, source] = splitSqlRow(row)
    if (!UUID_RE.test(desktopUserId) || !UUID_RE.test(controlAdminId)) {
      throw new Error(`[GFS-OPERATOR-E2E] malformed operator link row: ${row}`)
    }
    return { desktopUserId, controlAdminId, source }
  }

  operatorLinkCount(): number {
    if (!this.operatorLink) throw new Error('operator link is not initialized')
    return Number(
      firstDataLine(
        runControlPostgresSql(`
          SELECT count(*)::text FROM gfs_desktop_operator_links
           WHERE user_id = ${sqlLiteral(this.operatorLink?.desktopUserId ?? '')}::uuid
             AND control_admin_id = ${sqlLiteral(this.operatorLink?.controlAdminId ?? '')}::uuid;
        `)
      )
    )
  }

  operatorSubjectGrantCount(): number {
    if (!this.operatorLink) throw new Error('operator link is not initialized')
    return Number(
      firstDataLine(
        runControlPostgresSql(`
          SELECT count(*)::text
            FROM gfs_grants
           WHERE (subject_type = 'user' AND subject_id = ${sqlLiteral(this.operatorLink.desktopUserId)})
              OR (subject_type = 'operator' AND subject_id = '')
              OR subject_id = ${sqlLiteral(this.operatorLink.controlAdminId)};
        `)
      )
    )
  }

  createOrdinaryUserFixture(): { userId: string; teamId: string } {
    if (!this.operatorLink) throw new Error('operator link must exist before ordinary-user setup')
    const hash = bcryptHash(this.ordinaryPassword)
    const row = firstDataLine(
      runControlPostgresSql(`
        WITH operator_team AS (
          SELECT tm.team_id
            FROM team_members tm
           WHERE tm.user_id = ${sqlLiteral(this.operatorLink.desktopUserId)}::uuid
             AND tm.status = 'active'
             AND tm.role = 'admin'
           ORDER BY tm.created_at ASC
           LIMIT 1
        ), ordinary_user AS (
          INSERT INTO users(email, name, password_hash, password_set_at)
          VALUES(${sqlLiteral(this.ordinaryEmail)}, ${sqlLiteral(this.ordinaryName)}, ${sqlLiteral(hash)}, now())
          ON CONFLICT (email) DO UPDATE
             SET name = EXCLUDED.name,
                 password_hash = EXCLUDED.password_hash,
                 password_set_at = now(),
                 updated_at = now()
          RETURNING id
        ), ordinary_profile AS (
          INSERT INTO profiles(user_id, display_name)
          SELECT id, ${sqlLiteral(this.ordinaryName)} FROM ordinary_user
          ON CONFLICT (user_id) DO UPDATE
             SET display_name = EXCLUDED.display_name, updated_at = now()
          RETURNING user_id
        ), membership AS (
          INSERT INTO team_members(team_id, user_id, role, status)
          SELECT operator_team.team_id, ordinary_user.id, 'member', 'active'
            FROM operator_team CROSS JOIN ordinary_user
          ON CONFLICT (team_id, user_id) DO UPDATE
             SET role = 'member', status = 'active', updated_at = now()
          RETURNING team_id, user_id
        )
        SELECT membership.user_id::text, membership.team_id::text
          FROM membership JOIN ordinary_profile ON ordinary_profile.user_id = membership.user_id;
      `)
    )
    const [userId, teamId] = splitSqlRow(row)
    if (!UUID_RE.test(userId) || !UUID_RE.test(teamId)) {
      throw new Error(`[GFS-OPERATOR-E2E] ordinary fixture could not be created: ${row}`)
    }
    const linkCount = Number(
      firstDataLine(
        runControlPostgresSql(
          `SELECT count(*)::text FROM gfs_desktop_operator_links WHERE user_id = ${sqlLiteral(userId)}::uuid;`
        )
      )
    )
    if (linkCount !== 0) throw new Error('ordinary fixture unexpectedly has an operator link')
    this.ordinaryUserId = userId
    this.ordinaryTeamId = teamId
    return { userId, teamId }
  }

  readRootResourceId(): string {
    const root = firstDataLine(
      runControlPostgresSql(
        `SELECT resource_id::text FROM gfs_resources WHERE drive = 'main' AND parent_resource_id IS NULL AND deleted_at IS NULL LIMIT 1;`
      )
    )
    if (!UUID_RE.test(root)) throw new Error('[GFS-OPERATOR-E2E] GFS drive root is not seeded')
    this.rootResourceId = root
    return root
  }

  readResource(parentResourceId: string, name: string): GfsResourceRow | null {
    if (!UUID_RE.test(parentResourceId))
      throw new Error(`invalid parent resource id ${parentResourceId}`)
    const row = firstDataLine(
      runControlPostgresSql(`
        SELECT resource_id::text, name, kind, bytes::text, version::text,
               (deleted_at IS NOT NULL)::text
          FROM gfs_resources
         WHERE drive = 'main'
           AND parent_resource_id = ${sqlLiteral(parentResourceId)}::uuid
           AND name = ${sqlLiteral(name)}
         ORDER BY updated_at DESC
         LIMIT 1;
      `)
    )
    if (!row) return null
    const [resourceId, persistedName, kind, bytes, version, deleted] = splitSqlRow(row)
    if (!UUID_RE.test(resourceId)) throw new Error(`malformed GFS resource row: ${row}`)
    return {
      resourceId,
      name: persistedName,
      kind: kind === 'directory' ? 'directory' : 'file',
      bytes: Number(bytes),
      version: Number(version),
      deleted: deleted === 't' || deleted === 'true',
    }
  }

  seedOrdinaryReadGrant(resourceId: string): string {
    if (!this.ordinaryUserId || !UUID_RE.test(resourceId))
      throw new Error('unsafe ordinary grant fixture')
    const grantId = firstDataLine(
      runControlPostgresSql(`
        INSERT INTO gfs_grants(
          drive, resource_id, subject_type, subject_id, permissions, inherit, granted_by
        ) VALUES(
          'main', ${sqlLiteral(resourceId)}::uuid, 'user', ${sqlLiteral(this.ordinaryUserId)},
          ARRAY['read']::text[], false, 'e2e:ordinary-regression-precondition'
        )
        ON CONFLICT (drive, resource_id, subject_type, subject_id)
        DO UPDATE SET permissions = EXCLUDED.permissions, inherit = false,
                      granted_by = EXCLUDED.granted_by, updated_at = now()
        RETURNING id::text;
      `)
    )
    if (!UUID_RE.test(grantId)) throw new Error('ordinary read-grant fixture was not persisted')
    return grantId
  }

  removeFixtureGrant(grantId: string): void {
    if (!UUID_RE.test(grantId)) throw new Error(`unsafe fixture grant id ${grantId}`)
    runControlPostgresSql(`
      DELETE FROM gfs_grants
       WHERE id = ${sqlLiteral(grantId)}::uuid
         AND granted_by = 'e2e:ordinary-regression-precondition';
    `)
  }

  findGrant(resourceId: string): { id: string; grantedBy: string } | null {
    if (!this.ordinaryUserId) return null
    const row = firstDataLine(
      runControlPostgresSql(`
        SELECT id::text, granted_by
          FROM gfs_grants
         WHERE resource_id = ${sqlLiteral(resourceId)}::uuid
           AND subject_type = 'user'
           AND subject_id = ${sqlLiteral(this.ordinaryUserId)}
         LIMIT 1;
      `)
    )
    if (!row) return null
    const [id, grantedBy] = splitSqlRow(row)
    if (!UUID_RE.test(id)) throw new Error(`malformed grant row: ${row}`)
    return { id, grantedBy }
  }

  findShare(resourceId: string): { id: string; createdBy: string } | null {
    if (!this.ordinaryUserId) return null
    const row = firstDataLine(
      runControlPostgresSql(`
        SELECT id::text, created_by
          FROM gfs_shares
         WHERE resource_id = ${sqlLiteral(resourceId)}::uuid
           AND subject_type = 'user'
           AND subject_id = ${sqlLiteral(this.ordinaryUserId)}
         LIMIT 1;
      `)
    )
    if (!row) return null
    const [id, createdBy] = splitSqlRow(row)
    if (!UUID_RE.test(id)) throw new Error(`malformed share row: ${row}`)
    return { id, createdBy }
  }

  auditFloor(): number {
    return Number(
      firstDataLine(
        runControlPostgresSql(`SELECT coalesce(max(sequence_no), 0)::text FROM gfs_audit;`)
      )
    )
  }

  auditRowsAfter(sequenceNo: number, desktopUserId: string): GfsAuditRow[] {
    const output = runControlPostgresSql(`
      SELECT jsonb_build_object(
        'sequenceNo', sequence_no,
        'subject', subject,
        'actorOnBehalfOf', actor_on_behalf_of,
        'desktopUserId', desktop_user_id,
        'authoritySource', authority_source,
        'op', op,
        'outcome', outcome,
        'recordType', record_type,
        'mutationOutcome', mutation_outcome,
        'requestId', request_id,
        'gfsUri', gfs_uri
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

  readUnlinkLifecycleEvent(): { operatorSub: string; targetRef: string; detailRef: string } | null {
    if (!this.operatorLink) return null
    const targetRef = `gfs_desktop_operator_link:${this.operatorLink.desktopUserId}:${this.operatorLink.controlAdminId}`
    const row = firstDataLine(
      runControlPostgresSql(`
        SELECT operator_sub, target_ref, payload_metadata->>'detail_ref'
          FROM administrative_events
         WHERE action = 'permission_revoke'
           AND target_type = 'permission'
           AND target_ref = ${sqlLiteral(targetRef)}
           AND payload_metadata->>'status' = 'unlinked'
         ORDER BY occurred_at DESC
         LIMIT 1;
      `)
    )
    if (!row) return null
    const [operatorSub, persistedTargetRef, detailRef] = splitSqlRow(row)
    return { operatorSub, targetRef: persistedTargetRef, detailRef }
  }

  async loginControlUi(): Promise<Page> {
    const page = this.requiredControlPage()
    await page.goto('/')
    await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
    await page.getByLabel('Username or email').fill(this.operatorEmail)
    await page.getByLabel(/password/i).fill(this.operatorPassword)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
      timeout: 30_000,
    })
    const remindLater = page.getByRole('button', { name: 'Remind me later' })
    if ((await remindLater.count()) > 0) await remindLater.click()
    return page
  }

  async openControlAdmins(): Promise<Page> {
    const page = this.requiredControlPage()
    await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
    await expect(page).toHaveURL(/\/users-and-teams\/users(?:\?|$)/, { timeout: 20_000 })
    await page.getByRole('tab', { name: /^Admins(?: \(\d+\))?$/ }).click()
    await expect(page).toHaveURL(/\/users-and-teams\/admins(?:\?|$)/, { timeout: 20_000 })
    return page
  }

  async launchOperatorDesktop(): Promise<Page> {
    if (this.operatorApp) throw new Error('operator Electron process already launched')
    const outputRoot = this.workerInfo.project.outputDir
    this.operatorUserDataDir = path.join(outputRoot, `gfs-operator-user-data-${this.runTag}`)
    this.operatorVideoDir = path.join(outputRoot, `gfs-operator-video-${this.runTag}`)
    fs.mkdirSync(this.operatorUserDataDir, { recursive: true })
    fs.mkdirSync(this.operatorVideoDir, { recursive: true })
    this.operatorApp = await electron.launch({
      args: [`--user-data-dir=${this.operatorUserDataDir}`, MAIN_ENTRY],
      env: {
        ...process.env,
        EVENFIRE_RENDERER_URL: '',
        ELECTRON_RENDERER_URL: '',
        EXTERNAL_REST_API_BASE_URL: this.externalRestUrl,
        RPC_PROXY_BASE_URL: this.rpcProxyUrl,
        CLERUM_DESKTOP_CONFIG_PATH: path.join(this.operatorUserDataDir, 'runtime-config.json'),
      },
      recordVideo: { dir: this.operatorVideoDir, size: { width: 1280, height: 720 } },
    })
    this.operatorContext = this.operatorApp.context()
    if (this.activeTestInfo && !this.operatorTraceActive) {
      await this.operatorContext.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      })
      this.operatorTraceActive = true
    }
    this.operatorPage = await this.operatorApp.firstWindow()
    this.liveDesktopPages.add(this.operatorPage)
    await this.operatorPage.waitForLoadState('domcontentloaded')
    await this.loginDesktop(this.operatorPage, this.operatorEmail, this.operatorPassword)
    return this.operatorPage
  }

  async launchOrdinaryDesktop(testInfo: TestInfo): Promise<{
    app: ElectronApplication
    page: Page
    close(): Promise<void>
  }> {
    const userDataDir = testInfo.outputPath(`ordinary-user-data-${this.runTag}`)
    const videoDir = testInfo.outputPath(`ordinary-video-${this.runTag}`)
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.mkdirSync(videoDir, { recursive: true })
    const app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, MAIN_ENTRY],
      env: {
        ...process.env,
        EVENFIRE_RENDERER_URL: '',
        ELECTRON_RENDERER_URL: '',
        EXTERNAL_REST_API_BASE_URL: this.externalRestUrl,
        RPC_PROXY_BASE_URL: this.rpcProxyUrl,
        CLERUM_DESKTOP_CONFIG_PATH: path.join(userDataDir, 'runtime-config.json'),
      },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    })
    const page = await app.firstWindow()
    this.liveDesktopPages.add(page)
    await page.waitForLoadState('domcontentloaded')
    await this.loginDesktop(page, this.ordinaryEmail, this.ordinaryPassword)
    return {
      app,
      page,
      close: async () => {
        this.liveDesktopPages.delete(page)
        await app.close()
        const resolved = path.resolve(userDataDir)
        const allowedRoot = path.resolve(testInfo.outputDir)
        if (resolved.startsWith(`${allowedRoot}${path.sep}`)) {
          if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true })
        }
      },
    }
  }

  async loginDesktop(page: Page, email: string, password: string): Promise<void> {
    const emailInput = page.locator('#email-input')
    const passwordInput = page.locator('#password-input')
    await expect(emailInput).toBeVisible({ timeout: 30_000 })
    await expect(passwordInput).toBeVisible()
    await emailInput.fill(email)
    await passwordInput.fill(password)
    await page.getByRole('button', { name: /^Sign in$/ }).click()
    await expect(page.getByTestId('nav-settings-menu')).toBeVisible({ timeout: 45_000 })
  }

  async openFiles(page: Page): Promise<void> {
    await openResourcesNavItem(page, 'nav-files')
    await expect(page.getByRole('heading', { name: 'Files', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole('region', { name: 'Global File System browser' })).toBeVisible()
  }

  private requiredControlPage(): Page {
    if (!this.controlPage) throw new Error('Control UI page has not been initialized')
    return this.controlPage
  }
}

type GfsDesktopOperatorTestFixtures = {
  captureGfsOperatorFailureEvidence: void
}

type GfsDesktopOperatorWorkerFixtures = {
  operatorJourney: GfsDesktopOperatorJourney
}

export const test = base.extend<GfsDesktopOperatorTestFixtures, GfsDesktopOperatorWorkerFixtures>({
  operatorJourney: [
    async ({ browser }, use, workerInfo) => {
      const journey = new GfsDesktopOperatorJourney(browser, workerInfo)
      await journey.start()
      try {
        await use(journey)
      } finally {
        await journey.finish()
      }
    },
    { scope: 'worker' },
  ],
  captureGfsOperatorFailureEvidence: [
    async ({ operatorJourney }, use, testInfo) => {
      await operatorJourney.beginTest(testInfo)
      try {
        await use()
      } finally {
        await operatorJourney.endTest(testInfo)
      }
    },
    { auto: true },
  ],
})

export { expect }
