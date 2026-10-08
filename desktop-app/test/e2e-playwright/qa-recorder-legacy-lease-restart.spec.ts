import { type ElectronApplication, type Page, type TestInfo, expect, test } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import {
  GFS_E2E_DRIVE,
  type GfsFileFixture,
  cleanupGfsFixture,
  getE2EUserId,
  gfsWriterPod,
  kubectlOut,
  ridOf,
  seedGfsFileFixture,
  seedGfsGrant,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import { discoverManagedGfsAgent } from './helpers/gfsAgentDiscovery'
import {
  FIXTURE_RESPONSE_KIND,
  IMAGE_CAPABILITY_FIXTURE_MODELS,
  type ImageCapabilityEvidenceSnapshot,
  appendedAttempts,
  readImageCapabilityEvidence,
  requireImageCapabilitiesFixtureEnv,
} from './helpers/imageCapabilityEvidence'
import {
  HOST,
  type Kubectl,
  LEGACY_DISCARD_COUNTER,
  type LegacyLeaseLaneMode,
  SCENARIOS,
  type Scenario,
  type ScenarioResult,
  downloadedRecord,
  ensureWorkloadsUp,
  hostFileDigest,
  kubectlFor,
  legacyLeaseRecoveryVerdict,
  parseMetricValue,
  readHostLogLines,
  readHostMetrics,
  readPods,
  readStoreLedger,
  requireLegacyLeaseLaneEnv,
  runScenario,
  vacuityStoreVerdict,
} from './helpers/legacyLeaseRestart'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  screenshotAndLog,
} from './qa-recorder-helpers'

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop chat, the agent switch, the model popover and
 * the approval card all travel over Electron IPC, so the renderer has no HTTP
 * request to await for any transition. The oracles are the visible chat (the
 * fixture's answer line and the approval card), the provider-boundary ledger of
 * the derived in-cluster fixture, and read-only reads of the Host's own store
 * ledger, logs, metrics and workspace file.
 *
 * Issue #1022: a processing lease written by a Host build before #1019 has no
 * writer session. A Host that boots on such a ledger must discard it at
 * initialize (log `discarded 1`, counter 1) or report that it could not confirm
 * the discard; either way the ledger it serves carries no `processingLeases`,
 * and a shell command plus a GFS download work. The pre-fix build treats the
 * lease as an inherited executor, so its shell refuses with `download_busy`.
 *
 * Each scenario stops HCC and the Host, seeds one foreign lease on the Host PVC
 * from a pod running as the Host's uid/gid, performs its own restarts, and
 * brings HCC and the Host back. Then the Desktop journey runs: the user sends a
 * journey line, approves `shell_exec` by clicking Approve, and the fixture asks
 * for `clerum__gfs_download` of a seeded GFS file. The answer on screen carries
 * the sha256 and byte count of the Host's receipt, which must equal the GFS
 * source, as must the file the Host wrote to its workspace.
 *
 * Setup shortcuts (named, outside the behaviour under test): the GFS file and
 * its grants are seeded with SQL and the writer blob with kubectl cp, and the
 * legacy lease is written by the seed pod. Only the external provider peer is
 * simulated; nothing is mocked inside the cluster or the app.
 */

const SCENARIO_TITLES: Record<Scenario, string> = {
  'S-crash':
    'S-crash: a Host killed without grace boots on a legacy lease and serves shell then download',
  'S-graceful':
    'S-graceful: a Host stopped and rolled out boots on a legacy lease and serves shell then download',
  'S-hcc':
    'S-hcc: an HCC restart with the Host boots on a legacy lease and serves shell then download',
  'S-gfs':
    'S-gfs: each GFS pod restarts while the Host boots on a legacy lease, then shell and download work',
  'S-update':
    'S-update: GFS, WRC, HCC then Host restart in upgrade order on a legacy lease, then shell and download work',
}

const JOURNEY_RESPONSE_TIMEOUT_MS = 240_000
const ANY_TERMINAL_ANSWER = /LEGACY-LEASE-FIXTURE-(?:OK|SHELL-FAILED|DOWNLOAD-FAILED)/

interface LaneContext {
  mode: LegacyLeaseLaneMode
  runId: string
  kubectl: Kubectl
  env: ReturnType<typeof requireImageCapabilitiesFixtureEnv>
  file: GfsFileFixture
  source: { sha256: string; bytes: number }
}

let lane: LaneContext | undefined

function requireLane(expected: LegacyLeaseLaneMode): LaneContext {
  if (!lane) throw new Error('legacy-lease-restart lane context was not prepared')
  // A mode mismatch is a runner defect: it fails, it never skips.
  if (lane.mode !== expected)
    throw new Error(
      `this test belongs to the ${expected} lane, but LEGACY_LEASE_LANE_MODE is ${lane.mode}`
    )
  return lane
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const env = requireImageCapabilitiesFixtureEnv()
  const laneEnv = requireLegacyLeaseLaneEnv()
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', env.externalRestApiBaseUrl)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', env.rpcProxyBaseUrl)
  const kubectl = kubectlFor(laneEnv.profile)

  // The GFS subject of the Host this lane drives: exactly the chatllm Host.
  const agent = discoverManagedGfsAgent()
  if (agent.namespace !== HOST.namespace || agent.name !== HOST.deployment)
    throw new Error(`GFS agent discovery returned ${agent.subjectId}, not the lane's Host`)
  const ownerUserId = getE2EUserId(desktopCredentials().email)

  const file = seedGfsFileFixture(uniqueGfsFixtureName('e2e-gfs-legacy-lease'))
  try {
    seedGfsGrant({
      resourceId: file.fileResourceId,
      subjectType: 'user',
      subjectId: ownerUserId,
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:legacy-lease-restart',
    })
    seedGfsGrant({
      resourceId: file.fileResourceId,
      subjectType: 'host',
      subjectId: agent.subjectId,
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:legacy-lease-restart',
    })
    // The source the journey must reproduce: the bytes the fixture seeded, and
    // the same digest read back from the writer's blob.
    const content = Buffer.from(`E2E GFS file fixture: ${file.name}\n`, 'utf8')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const blob = kubectlOut([
      '-n',
      'gfs',
      'exec',
      gfsWriterPod(),
      '--',
      'sha256sum',
      `/data/gfs/${ridOf(file.fileResourceId)}`,
    ]).trim()
    if (blob.split(/\s+/)[0] !== sha256)
      throw new Error(`writer blob digest ${blob} differs from the seeded ${sha256}`)
    lane = {
      mode: laneEnv.mode,
      runId: laneEnv.runId,
      kubectl,
      env,
      file,
      source: { sha256, bytes: content.length },
    }
  } catch (error) {
    cleanupGfsFixture(file.name)
    throw error
  }
})

test.afterAll(async () => {
  if (lane) cleanupGfsFixture(lane.file.name)
})

/** Reach the authenticated shell through the real sign-in form. */
async function signIn(page: Page) {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
  const emailInput = page.locator('#email-input')
  const settingsMenu = page.getByTestId('nav-settings-menu')
  await expect(emailInput.or(settingsMenu)).toBeVisible({ timeout: 30_000 })
  if (await settingsMenu.isVisible()) {
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') await settingsMenu.click()
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true')
    await page.getByTestId('logout-btn').click()
  }
  await expect(emailInput).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('nav-chat')).toHaveCount(0)
  await login(page, desktopCredentials())
  await expect(page.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
}

async function openFixtureChat(page: Page, hostRef: string) {
  const escaped = hostRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page.getByTestId('nav-chat').click()
  const switchAgent = page.getByRole('button', { name: 'Switch chat agent' })
  await expect(switchAgent).toBeVisible({ timeout: 30_000 })
  await switchAgent.click()
  const item = page.getByRole('menuitem', { name: new RegExp(`^${escaped}$`, 'i') })
  await expect(item).toHaveCount(1)
  await item.click()
  await expect(switchAgent).toContainText(new RegExp(escaped, 'i'))

  await page.getByTestId('nav-new-chat').click()
  const composer = page.getByRole('textbox', { name: 'Agent message composer' })
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(0, { timeout: 20_000 })

  const model = IMAGE_CAPABILITY_FIXTURE_MODELS.supported
  const chip = page.getByTestId('selected-chat-model')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await chip.click()
  await expect(page.getByRole('menu', { name: 'Select model' })).toBeVisible({ timeout: 20_000 })
  const row = page.getByTestId(`model-option-${model}`)
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(chip).toHaveAttribute('data-model-id', model)
  return composer
}

interface JourneyOutcome {
  answer: string
  approvals: string[]
  before: ImageCapabilityEvidenceSnapshot
  after: ImageCapabilityEvidenceSnapshot
}

/**
 * Sends the journey line and approves every tool approval the Host raises by
 * clicking Approve, until the fixture's terminal answer is on screen. Returns
 * the answer text and the input preview of each approval clicked.
 */
async function runJourney(page: Page, ctx: LaneContext, marker: string): Promise<JourneyOutcome> {
  const composer = await openFixtureChat(page, ctx.env.hostRef)
  const line = `LEGACY_LEASE_JOURNEY marker=${marker} drive=${GFS_E2E_DRIVE} resourceId=${ridOf(ctx.file.fileResourceId)}`
  const before = readImageCapabilityEvidence(ctx.env)
  expect(before.runId).toBe(ctx.env.runId)
  await composer.fill(line)
  const send = page.getByTestId('send-button')
  await expect(send).toBeEnabled({ timeout: 20_000 })
  await send.click()

  const approve = page.getByTestId('approval-approve-btn')
  const preview = page.getByTestId('approval-input-preview')
  const response = page.getByTestId('agent-response').locator('.message-block.markdown-content')
  const terminal = response.filter({ hasText: ANY_TERMINAL_ANSWER })
  const approvals: string[] = []
  // The journey has at most two approvable tools (shell, then download).
  for (let round = 0; round < 3; round += 1) {
    await expect(approve.or(terminal)).toBeVisible({ timeout: JOURNEY_RESPONSE_TIMEOUT_MS })
    if ((await terminal.count()) > 0) break
    if (round === 2) throw new Error('more approvals than the journey has tools')
    await expect(preview).toBeVisible({ timeout: 20_000 })
    const shown = await preview.innerText()
    approvals.push(shown)
    await approve.click()
    // The clicked card leaves, or is replaced by the next tool's approval.
    await expect
      .poll(
        async () =>
          (await approve.count()) === 0 ||
          ((await preview.count()) > 0 && (await preview.innerText()) !== shown),
        { timeout: 60_000 }
      )
      .toBe(true)
  }
  await expect(terminal).toHaveCount(1)
  const answer = (await terminal.innerText()).trim()
  const after = readImageCapabilityEvidence(ctx.env)
  return { answer, approvals, before, after }
}

/** The shell approval the user clicked is the fixture's command for this marker. */
function expectShellApproved(approvals: string[], marker: string) {
  expect(approvals.length).toBeGreaterThanOrEqual(1)
  expect(approvals[0]).toContain('printf')
  expect(approvals[0]).toContain(marker)
}

async function withDesktop(
  testInfo: TestInfo,
  label: string,
  body: (page: Page) => Promise<void>
): Promise<void> {
  let app: ElectronApplication | undefined
  let recordedPage: Page | undefined
  try {
    const launched = await launchDesktopApp(
      testInfo,
      `issue1022-${label}-minikube${new URL(EXTERNAL_REST_API_BASE_URL).port}`
    )
    app = launched.app
    recordedPage = launched.page
    await signIn(launched.page)
    await body(launched.page)
    await screenshotAndLog(launched.page, testInfo, `desktop-legacy-lease-${label}`)
  } catch (error) {
    if (recordedPage && !recordedPage.isClosed()) {
      await recordedPage
        .screenshot({ path: testInfo.outputPath('failure.png') })
        .catch(() => undefined)
    }
    throw error
  } finally {
    await finalizeRecording(app, recordedPage)
  }
}

/** The Host pod that booted on the seeded ledger is still the only Ready one. */
function expectHostUnchanged(ctx: LaneContext, result: ScenarioResult) {
  const pods = readPods(ctx.kubectl, HOST.namespace, HOST.selector).filter(p => !p.terminating)
  expect(pods.map(p => p.uid)).toEqual([result.host.uid])
  expect(pods[0]?.ready).toBe(true)
  expect(result.host.uid).not.toBe(result.previousHostUid)
}

function attachScenario(testInfo: TestInfo, data: unknown) {
  return testInfo.attach('scenario.json', {
    body: JSON.stringify(data, null, 2),
    contentType: 'application/json',
  })
}

for (const scenario of SCENARIOS) {
  test(`legacy-lease-restart fixture: ${SCENARIO_TITLES[scenario]}`, async ({}, testInfo) => {
    const ctx = requireLane('fixed')
    try {
      const result = await runScenario(ctx.kubectl, { scenario, runId: ctx.runId })
      expect(result.seed.leaseId).toBe(result.lease.leaseId)

      // Signal 2: the store the new Host serves has no legacy lease, and it
      // reports one of the two recovery outcomes.
      const ledgerAtBoot = readStoreLedger(ctx.kubectl, result.host.name)
      const metrics = readHostMetrics(ctx.kubectl, result.host.name)
      const outcome = legacyLeaseRecoveryVerdict({
        ledger: ledgerAtBoot,
        logLines: readHostLogLines(ctx.kubectl, result.host.name),
        counter: parseMetricValue(metrics, LEGACY_DISCARD_COUNTER),
      })
      await attachScenario(testInfo, { ...result, outcome })

      // Signal 3: the Desktop journey on that Host.
      const marker = `legacy-lease-${randomBytes(8).toString('hex')}`
      await withDesktop(testInfo, scenario.toLowerCase(), async page => {
        const journey = await runJourney(page, ctx, marker)
        expectShellApproved(journey.approvals, marker)
        expect(journey.answer).toContain(
          `LEGACY-LEASE-FIXTURE-OK marker=${marker} sha256=${ctx.source.sha256} bytes=${ctx.source.bytes}`
        )
        const rows = appendedAttempts(journey.before, journey.after)
        const kinds = rows.map(row => row.responseKind)
        expect(
          kinds.filter(k => k === FIXTURE_RESPONSE_KIND.legacyLeaseShellRequested)
        ).toHaveLength(1)
        expect(
          kinds.filter(k => k === FIXTURE_RESPONSE_KIND.legacyLeaseDownloadRequested)
        ).toHaveLength(1)
        const answers = rows.filter(
          row => row.responseKind === FIXTURE_RESPONSE_KIND.legacyLeaseAnswer
        )
        expect(answers).toHaveLength(1)
        expect(answers[0]?.downloadSha256).toBe(ctx.source.sha256)
        expect(answers[0]?.downloadBytes).toBe(ctx.source.bytes)
        const delta = (key: keyof ImageCapabilityEvidenceSnapshot['counters']) =>
          journey.after.counters[key] - journey.before.counters[key]
        expect(delta('legacyLeaseShellRequests')).toBe(1)
        expect(delta('legacyLeaseDownloadRequests')).toBe(1)
        expect(delta('legacyLeaseAnswers')).toBe(1)
        expect(delta('legacyLeaseFailures')).toBe(0)
      })

      // The store recorded exactly this download, and the workspace file holds
      // the GFS source bytes.
      const ledgerAfter = readStoreLedger(ctx.kubectl, result.host.name)
      const record = downloadedRecord(ledgerAtBoot, ledgerAfter, ctx.source)
      expect(hostFileDigest(ctx.kubectl, result.host.name, record.hostPath)).toEqual(ctx.source)
      expect(Object.hasOwn(ledgerAfter, 'processingLeases')).toBe(false)
      expectHostUnchanged(ctx, result)
    } finally {
      ensureWorkloadsUp(ctx.kubectl)
    }
  })
}

test('legacy-lease-restart vacuity: S-crash on base 74e0d81d9 fails at the shell with download_busy', async ({}, testInfo) => {
  const ctx = requireLane('vacuity')
  try {
    const result = await runScenario(ctx.kubectl, { scenario: 'S-crash', runId: ctx.runId })
    const ledgerAtBoot = readStoreLedger(ctx.kubectl, result.host.name)
    const verdict = vacuityStoreVerdict({
      ledger: ledgerAtBoot,
      logLines: readHostLogLines(ctx.kubectl, result.host.name),
      counter: parseMetricValue(
        readHostMetrics(ctx.kubectl, result.host.name),
        LEGACY_DISCARD_COUNTER
      ),
      leaseId: result.lease.leaseId,
    })
    await attachScenario(testInfo, { ...result, verdict })

    const marker = `legacy-lease-${randomBytes(8).toString('hex')}`
    await withDesktop(testInfo, 'vacuity', async page => {
      const journey = await runJourney(page, ctx, marker)
      expectShellApproved(journey.approvals, marker)
      expect(journey.answer).toContain('LEGACY-LEASE-FIXTURE-SHELL-FAILED code=download_busy')
      const rows = appendedAttempts(journey.before, journey.after)
      const shellFailed = rows.filter(
        row => row.responseKind === FIXTURE_RESPONSE_KIND.legacyLeaseShellFailed
      )
      // Positive witness first: the shell step ran and failed with the store code.
      expect(shellFailed).toHaveLength(1)
      expect(shellFailed[0]?.failureCode).toBe('download_busy')
      expect(
        rows.filter(row => row.responseKind === FIXTURE_RESPONSE_KIND.legacyLeaseShellRequested)
      ).toHaveLength(1)
      expect(
        rows.filter(row => row.responseKind === FIXTURE_RESPONSE_KIND.legacyLeaseDownloadRequested)
      ).toHaveLength(0)
      expect(
        rows.filter(row => row.responseKind === FIXTURE_RESPONSE_KIND.legacyLeaseAnswer)
      ).toHaveLength(0)
    })
    expectHostUnchanged(ctx, result)
  } finally {
    ensureWorkloadsUp(ctx.kubectl)
  }
})
