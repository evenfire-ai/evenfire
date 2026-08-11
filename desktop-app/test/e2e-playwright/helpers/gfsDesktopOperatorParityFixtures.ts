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
import {
  GFS_OPERATOR_SETUP_PATH,
  type GfsOperatorGenerationChainExpectation,
  type GfsOperatorLinkGeneration,
  assertGenerationChain as assertGenerationChainContract,
  requireGfsOperatorRunId,
} from '../gfsDesktopOperatorParityContract'
import { openResourcesNavItem } from '../navigationHelpers'

const DESKTOP_APP_ROOT = path.resolve(__dirname, '../../..')
const MAIN_ENTRY = path.join(DESKTOP_APP_ROOT, 'dist/main.js')

function configuredUrl(label: string, candidates: Array<string | undefined>): string {
  const value = candidates.find(candidate => candidate?.trim())?.trim()
  if (!value) throw new Error(`[GFS-OPERATOR-E2E] ${label} is required.`)
  return value.replace(/\/$/, '')
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

export interface GfsOperatorLifecycleEvent {
  eventId: string
  action: 'permission_grant' | 'permission_revoke'
  outcome: string
  operatorSub: string | null
  targetRef: string
  sourceAuditRef: string | null
  status: string | null
  detailRef: string | null
  requestId: string | null
  operationId: string | null
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[GFS-OPERATOR-E2E] ${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[GFS-OPERATOR-E2E] ${label}.${field} must be a non-empty string`)
  }
  return value
}

function nullableString(
  record: Record<string, unknown>,
  field: string,
  label: string
): string | null {
  const value = record[field]
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new Error(`[GFS-OPERATOR-E2E] ${label}.${field} must be a string or null`)
  }
  return value
}

function requiredUuid(record: Record<string, unknown>, field: string, label: string): string {
  const value = requiredString(record, field, label)
  if (!UUID_RE.test(value)) {
    throw new Error(`[GFS-OPERATOR-E2E] ${label}.${field} must be a UUID`)
  }
  return value
}

function nullableUuid(
  record: Record<string, unknown>,
  field: string,
  label: string
): string | null {
  const value = nullableString(record, field, label)
  if (value !== null && !UUID_RE.test(value)) {
    throw new Error(`[GFS-OPERATOR-E2E] ${label}.${field} must be a UUID or null`)
  }
  return value
}

function positiveInteger(record: Record<string, unknown>, field: string, label: string): number {
  const raw = record[field]
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`[GFS-OPERATOR-E2E] ${label}.${field} must be a positive integer`)
  }
  return value
}

function parseLinkGeneration(value: unknown): GfsOperatorLinkGeneration {
  const row = asRecord(value, 'operator-link history')
  const state = requiredString(row, 'state', 'operator-link history')
  if (state !== 'active' && state !== 'revoked') {
    throw new Error(`[GFS-OPERATOR-E2E] operator-link history.state is unsupported: ${state}`)
  }
  const revokedByType = nullableString(row, 'revokedByType', 'operator-link history')
  if (
    revokedByType !== null &&
    revokedByType !== 'control_admin' &&
    revokedByType !== 'platform_user'
  ) {
    throw new Error(
      `[GFS-OPERATOR-E2E] operator-link history.revokedByType is unsupported: ${revokedByType}`
    )
  }
  return {
    id: requiredUuid(row, 'id', 'operator-link history'),
    lineageId: requiredUuid(row, 'lineageId', 'operator-link history'),
    generation: positiveInteger(row, 'generation', 'operator-link history'),
    predecessorId: nullableUuid(row, 'predecessorId', 'operator-link history'),
    state,
    desktopUserId: requiredUuid(row, 'desktopUserId', 'operator-link history'),
    controlAdminId: requiredUuid(row, 'controlAdminId', 'operator-link history'),
    source: requiredString(row, 'source', 'operator-link history'),
    createdByControlAdminId: requiredUuid(row, 'createdByControlAdminId', 'operator-link history'),
    rowVersion: positiveInteger(row, 'rowVersion', 'operator-link history'),
    revokedAt: nullableString(row, 'revokedAt', 'operator-link history'),
    revokedByType,
    revokedById: nullableUuid(row, 'revokedById', 'operator-link history'),
    revokedByControlAdminId: nullableUuid(row, 'revokedByControlAdminId', 'operator-link history'),
    revokedByDesktopUserId: nullableUuid(row, 'revokedByDesktopUserId', 'operator-link history'),
    revocationReason: nullableString(row, 'revocationReason', 'operator-link history'),
  }
}

function parseLifecycleEvent(value: unknown): GfsOperatorLifecycleEvent {
  const row = asRecord(value, 'operator-link lifecycle event')
  const action = requiredString(row, 'action', 'operator-link lifecycle event')
  if (action !== 'permission_grant' && action !== 'permission_revoke') {
    throw new Error(`[GFS-OPERATOR-E2E] unsupported lifecycle action: ${action}`)
  }
  return {
    eventId: requiredUuid(row, 'eventId', 'operator-link lifecycle event'),
    action,
    outcome: requiredString(row, 'outcome', 'operator-link lifecycle event'),
    operatorSub: nullableString(row, 'operatorSub', 'operator-link lifecycle event'),
    targetRef: requiredString(row, 'targetRef', 'operator-link lifecycle event'),
    sourceAuditRef: nullableString(row, 'sourceAuditRef', 'operator-link lifecycle event'),
    status: nullableString(row, 'status', 'operator-link lifecycle event'),
    detailRef: nullableString(row, 'detailRef', 'operator-link lifecycle event'),
    requestId: nullableString(row, 'requestId', 'operator-link lifecycle event'),
    operationId: nullableUuid(row, 'operationId', 'operator-link lifecycle event'),
  }
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
  operatorDownloadsDir: string | null = null
  private operatorSessionSequence = 0
  private readonly operatorUserDataDirs = new Set<string>()
  private readonly operatorDownloadsDirs = new Set<string>()
  operatorLink: OperatorLinkRow | null = null
  ordinaryUserId: string | null = null
  ordinaryTeamId: string | null = null
  rootResourceId: string | null = null
  resources = new Map<string, GfsResourceRow>()
  successfulCreateAuditFloor = 0
  deniedAuditFloor = 0

  private readonly liveDesktopPages = new Set<Page>()

  constructor(
    private readonly browser: Browser,
    private readonly workerInfo: WorkerInfo
  ) {}

  async start(): Promise<void> {
    this.controlContext = await this.browser.newContext({ baseURL: this.controlUiUrl })
    this.controlPage = await this.controlContext.newPage()
  }

  async endTest(testInfo: TestInfo): Promise<void> {
    const failed = testInfo.status !== testInfo.expectedStatus
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
    // Independent journeys must not inherit an authenticated Electron or
    // Control UI session. Keep the same Electron process only inside the
    // revoke/reactivate journey itself, which intentionally proves live
    // denial and recovery for one session.
    await this.closeOperatorDesktop()
    await this.closeControlUi()
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
    await this.closeOperatorDesktop().catch(error => cleanupErrors.push(error))
    await this.closeControlUi().catch(error => cleanupErrors.push(error))
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
    for (const userDataDir of this.operatorUserDataDirs) {
      try {
        const resolved = path.resolve(userDataDir)
        const allowedRoot = path.resolve(this.workerInfo.project.outputDir)
        if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) {
          throw new Error(`refusing to remove user data outside ${allowedRoot}`)
        }
        if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    for (const downloadsDir of this.operatorDownloadsDirs) {
      try {
        const resolved = path.resolve(downloadsDir)
        const allowedRoot = path.resolve(this.workerInfo.project.outputDir)
        if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) {
          throw new Error(`refusing to remove downloads outside ${allowedRoot}`)
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
    // The service base remains root-scoped so the global setup can probe
    // /health; application routes are mounted under the production /api/v1
    // prefix and must use that supported path explicitly.
    const response = await fetch(`${this.controlApiUrl}${GFS_OPERATOR_SETUP_PATH}`, {
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
        `[GFS-OPERATOR-E2E] ${GFS_OPERATOR_SETUP_PATH} returned 409. This one-shot journey requires a fresh, branch-owned profile whose bootstrap has not been consumed; no database reset or link insertion is performed by the suite.`
      )
    }
    if (response.status !== 200 || !UUID_RE.test(body.me?.id ?? '')) {
      throw new Error(
        `[GFS-OPERATOR-E2E] ${GFS_OPERATOR_SETUP_PATH} returned HTTP ${response.status}: ${body.error ?? JSON.stringify(body)}`
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
           AND state = 'active'
         ORDER BY generation DESC
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

  /** Counts current authority only; revoked generations remain readable history. */
  countActiveLinks(): number {
    const link = this.requireOperatorLink()
    const value = firstDataLine(
      runControlPostgresSql(`
        SELECT count(*)::text
          FROM gfs_desktop_operator_links
         WHERE user_id = ${sqlLiteral(link.desktopUserId)}::uuid
           AND control_admin_id = ${sqlLiteral(link.controlAdminId)}::uuid
           AND state = 'active';
      `)
    )
    const count = Number(value)
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`[GFS-OPERATOR-E2E] invalid active operator-link count: ${value}`)
    }
    return count
  }

  /**
   * Read-only proof for the immutable lineage after a visible lifecycle action.
   * This is intentionally separate from countActiveLinks() so retained
   * tombstones cannot be mistaken for present authority.
   */
  readLinkHistory(): GfsOperatorLinkGeneration[] {
    const link = this.requireOperatorLink()
    const output = runControlPostgresSql(`
      SELECT jsonb_build_object(
        'id', id::text,
        'lineageId', lineage_id::text,
        'generation', generation,
        'predecessorId', predecessor_id::text,
        'state', state,
        'desktopUserId', user_id::text,
        'controlAdminId', control_admin_id::text,
        'source', source,
        'createdByControlAdminId', created_by::text,
        'rowVersion', row_version,
        'revokedAt', revoked_at::text,
        'revokedByType', revoked_by_type,
        'revokedById', revoked_by_id::text,
        'revokedByControlAdminId', revoked_by_control_admin_id::text,
        'revokedByDesktopUserId', revoked_by_desktop_user_id::text,
        'revocationReason', revocation_reason
      )::text
        FROM gfs_desktop_operator_links
       WHERE user_id = ${sqlLiteral(link.desktopUserId)}::uuid
         AND control_admin_id = ${sqlLiteral(link.controlAdminId)}::uuid
       ORDER BY generation ASC, id ASC;
    `)
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('{') && line.endsWith('}'))
      .map(line => parseLinkGeneration(JSON.parse(line) as unknown))
  }

  assertGenerationChain(
    expected: Omit<
      GfsOperatorGenerationChainExpectation,
      'desktopUserId' | 'controlAdminId' | 'source'
    >
  ): GfsOperatorLinkGeneration[] {
    const link = this.requireOperatorLink()
    const history = this.readLinkHistory()
    assertGenerationChainContract(history, {
      desktopUserId: link.desktopUserId,
      controlAdminId: link.controlAdminId,
      source: link.source,
      ...expected,
    })
    return history
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

  /** Read-only governed evidence for the exact pair, ordered by occurrence. */
  readLinkLifecycleEvents(): GfsOperatorLifecycleEvent[] {
    const link = this.requireOperatorLink()
    const targetRef = `gfs_desktop_operator_link:${link.desktopUserId}:${link.controlAdminId}`
    const sourceAuditRef = `gfs_desktop_operator_link_source:${link.source}`
    const output = runControlPostgresSql(`
      SELECT jsonb_build_object(
        'eventId', event_id::text,
        'action', action,
        'outcome', outcome,
        'operatorSub', operator_sub,
        'targetRef', target_ref,
        'sourceAuditRef', source_audit_ref,
        'status', payload_metadata->>'status',
        'detailRef', payload_metadata->>'detail_ref',
        'requestId', request_id,
        'operationId', operation_id::text
      )::text
        FROM administrative_events
       WHERE target_type = 'permission'
         AND target_ref = ${sqlLiteral(targetRef)}
         AND source_audit_ref = ${sqlLiteral(sourceAuditRef)}
       ORDER BY occurred_at ASC, event_id ASC;
    `)
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('{') && line.endsWith('}'))
      .map(line => parseLifecycleEvent(JSON.parse(line) as unknown))
  }

  async loginControlUi(): Promise<Page> {
    // A fresh browser context per journey prevents the Control UI session
    // cookie from becoming shared fixture state across the serial scenarios.
    await this.closeControlUi()
    this.controlContext = await this.browser.newContext({ baseURL: this.controlUiUrl })
    this.controlPage = await this.controlContext.newPage()
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
    this.operatorSessionSequence += 1
    const sessionTag = `${this.runTag}-${this.operatorSessionSequence}`
    this.operatorUserDataDir = path.join(outputRoot, `gfs-operator-user-data-${sessionTag}`)
    this.operatorVideoDir = path.join(outputRoot, `gfs-operator-video-${sessionTag}`)
    this.operatorDownloadsDir = path.join(outputRoot, `gfs-operator-downloads-${sessionTag}`)
    this.operatorUserDataDirs.add(this.operatorUserDataDir)
    this.operatorDownloadsDirs.add(this.operatorDownloadsDir)
    fs.mkdirSync(this.operatorUserDataDir, { recursive: true })
    fs.mkdirSync(this.operatorVideoDir, { recursive: true })
    fs.mkdirSync(this.operatorDownloadsDir, { recursive: true })
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
    const configuredDownloadsDir = await this.operatorApp.evaluate(
      ({ app: electronApp }, downloadsDir) => {
        electronApp.setPath('downloads', downloadsDir)
        return electronApp.getPath('downloads')
      },
      this.operatorDownloadsDir
    )
    if (path.resolve(configuredDownloadsDir) !== path.resolve(this.operatorDownloadsDir)) {
      throw new Error(
        `[GFS-OPERATOR-E2E] Electron did not honor the isolated downloads directory: expected ${this.operatorDownloadsDir}, got ${configuredDownloadsDir}`
      )
    }
    this.operatorContext = this.operatorApp.context()
    this.operatorPage = await this.operatorApp.firstWindow()
    this.liveDesktopPages.add(this.operatorPage)
    await this.operatorPage.waitForLoadState('domcontentloaded')
    await this.loginDesktop(this.operatorPage, this.operatorEmail, this.operatorPassword)
    return this.operatorPage
  }

  readDownloadedArtifact(
    expectedName: string,
    expectedBytes: Buffer
  ): {
    filename: string
    size: number
    sha256: string
    relativePath: string
  } | null {
    if (!this.operatorDownloadsDir) {
      throw new Error('[GFS-OPERATOR-E2E] operator downloads directory is not initialized')
    }
    const entries = fs.readdirSync(this.operatorDownloadsDir, { withFileTypes: true })
    const files = entries.filter(entry => entry.isFile()).map(entry => entry.name)
    if (files.length !== 1 || files[0] !== expectedName) return null
    const filePath = path.join(this.operatorDownloadsDir, expectedName)
    const bytes = fs.readFileSync(filePath)
    if (!bytes.equals(expectedBytes)) return null
    return {
      filename: expectedName,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      relativePath: path.relative(this.workerInfo.project.outputDir, filePath),
    }
  }

  async closeOperatorDesktop(): Promise<void> {
    const app = this.operatorApp
    const page = this.operatorPage
    this.operatorApp = null
    this.operatorPage = null
    this.operatorContext = null
    if (page) this.liveDesktopPages.delete(page)
    await app?.close()
  }

  async closeControlUi(): Promise<void> {
    const context = this.controlContext
    this.controlContext = null
    this.controlPage = null
    await context?.close()
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
    // macOS keytar is shared across Electron user-data directories. A previous
    // visible login can therefore restore an authenticated shell in the next
    // isolated journey even though its filesystem profile is fresh. Resolve
    // that supported session state through the real logout UI; never mutate
    // keychain/storage from the E2E harness.
    const emailInput = page.locator('#email-input')
    const passwordInput = page.locator('#password-input')
    const settingsMenu = page.getByTestId('nav-settings-menu')
    const authenticatedShell = settingsMenu
      .or(page.getByRole('textbox', { name: 'Agent message composer' }))
      .first()

    await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
    await expect(emailInput.or(authenticatedShell)).toBeVisible({ timeout: 30_000 })
    if (!(await emailInput.isVisible().catch(() => false))) {
      if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
        await settingsMenu.click()
      }
      const logoutButton = page.getByTestId('logout-btn')
      await expect(logoutButton).toBeVisible({ timeout: 15_000 })
      await logoutButton.click()
      await expect(emailInput).toBeVisible({ timeout: 30_000 })
    }
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

  private requireOperatorLink(): OperatorLinkRow {
    if (!this.operatorLink) throw new Error('operator link is not initialized')
    return this.operatorLink
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
  // Tracing is configured with Playwright's `retain-on-failure` policy. The
  // fixture only adds screenshots so it cannot start a second trace on a
  // context that Playwright already owns.
  captureGfsOperatorFailureEvidence: [
    async ({ operatorJourney }, use, testInfo) => {
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
