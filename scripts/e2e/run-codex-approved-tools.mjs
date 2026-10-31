import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS,
  APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS,
  APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS,
  APPROVED_TOOLS_RUNNER_KILL_GRACE_SECONDS,
  APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS,
  openOwnedFile,
  readOwnedDescriptor,
  validateRunDirectory,
} from './prepare-codex-approved-tools.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const playwright = path.join(repo, 'tests/e2e/playwright')
const specFile = 'codex-subscription-approved-tools.spec.ts'
const nativeWorkflowSpecFile = 'codex-native-workflow.spec.ts'
const modelStepSpecFile = 'model-step-retry-codex.spec.ts'
const hybridSpecFile = 'model-step-retry-codex-hybrid.spec.ts'
// #1048 MS-NW: the native workflow journey left the base group. It depends on
// the custom coordinator image, so it is its own suite run and its own spec.
export const nativeWorkflowTitle =
  'native workflow: visible approval, trigger, status and result artifact'
export const hybridRetryTitles = [
  'real hybrid R1: a confirmed fixture read survives four injected 503s and Retry completes',
  'real hybrid R2: approval inside the continuation executes the receipt once',
]
export const toolCallLimitTitle =
  'tool call limit: Desktop shows Too Many Tool Calls without retry or connector call'
export const toolCallLimitBoundaryTitle =
  'tool call limit boundary: Desktop completes a turn of exactly 256 tool calls'
// #1044: the visible preparation both model-step suites need. It runs once in
// its own project, which the suite's cases depend on: a `beforeAll` would run
// again in every worker Playwright starts after a failure, and the second Codex
// grant capture refuses to open (`approved-tools-connection-journal.mjs`).
// It is not a dependency on the approved-tools project: that suite is a
// different lane run (Addendum 21, decoupling).
export const modelStepRetrySetupTitle =
  'model step retry setup: the subscription grant and the model binding are visible'
// #1044: the model-step retry cases, run by their own Playwright project after
// the approved-tools spec, against the deterministic upstream only.
export const modelStepRetryTitles = [
  'model step retry C1: a 503 after a confirmed tool continues once without re-running the tool',
  'model step retry C2: a 503 before any tool offers only Resend, which answers the turn',
  'model step retry C3: a new message instead of the retry abandons the checkpoint',
  'model step retry C4: a double click on Retry model step runs one continuation',
  'model step retry C5: a continuation that meets a 503 again is offered for retry again',
  'model step retry C6: sending the same prompt starts a new turn instead of continuing',
  'model step retry C7: approval inside a continuation executes the receipt once',
  'model step retry C9: denying an approval inside a continuation releases the session',
  'model step retry C10: cancelling an approval inside a continuation releases the session',
  'model step retry C8: the checkpoint survives a Host restart between the 503 and the retry',
  'model step retry C11: three 503s after a confirmed search are absorbed by the automatic retries',
  'model step retry C12: the 60 s cap ends a held retry and Retry model step completes the turn',
]
// Aggregate business signals from the twelve deterministic Desktop journeys.
// Every journey that ends on the resumable notice fails its model step four
// times (the Host's default CLERUM_MODEL_STEP_AUTO_RETRIES=3 absorbs the first
// three 503s): C5 eight times, C2 once before any tool, C11's three outages are
// absorbed and C12 adds its one immediate and its one held outage.
export const modelStepRetryExpectedDelta = Object.freeze({
  turns: 12,
  markerSearches: 11,
  unavailableResponses: 46,
  zeroToolUnavailable: 1,
  continuationUnavailable: 4,
  continuations: 6,
  toolResults: 6,
  resends: 2,
  followUps: 3,
  unexpectedRetries: 0,
  approvalRequests: 3,
  approvalFinals: 1,
  absorbed: 1,
  cappedHeld: 1,
})

// The Grok lane runs only the three cases that prove something Grok-specific:
// C1 (a dispatched 503 after a confirmed tool, then Retry model step), C2 (a 503
// before any tool, only Resend) and C11 (three 503s absorbed by the Host's
// automatic retries). The other cases exercise provider-independent Host and UI code.
export const grokModelStepRetryTitles = [
  modelStepRetryTitles[0],
  modelStepRetryTitles[1],
  modelStepRetryTitles[10],
]
// C1 fails its step four times and continues once; C2 fails once before any tool
// and answers through Resend; C11's three outages are absorbed. Grok has no C12,
// so its held-retry counter stays where it was.
export const grokModelStepRetryExpectedDelta = Object.freeze({
  turns: 3,
  markerSearches: 2,
  unavailableResponses: 8,
  zeroToolUnavailable: 1,
  continuationUnavailable: 0,
  continuations: 1,
  toolResults: 1,
  resends: 1,
  followUps: 0,
  unexpectedRetries: 0,
  approvalRequests: 0,
  approvalFinals: 0,
  absorbed: 1,
  cappedHeld: 0,
})

function validateProvider(provider) {
  if (!['codex', 'grok'].includes(provider))
    throw new Error('Select the codex or grok approved-tools provider explicitly')
  return provider
}

// The lane splits into three suite runs that never share a fixture run
// directory: `approved-tools` (the seven base journeys and the limit probes),
// `native-workflow` (the one workflow case) and `model-step-retry` (the visible
// setup plus the retry cases). Each run selects exactly one, so a base-spec
// defect cannot decide the retry cases' verdict.
export const approvedToolsSuites = ['approved-tools', 'native-workflow', 'model-step-retry']

export function validateSuite(suite) {
  if (!approvedToolsSuites.includes(suite))
    throw new Error(
      'Select the approved-tools, native-workflow or model-step-retry suite explicitly'
    )
  return suite
}

function validateMode(mode) {
  if (!['deterministic', 'real', 'real-hybrid'].includes(mode))
    throw new Error('Select deterministic, real or real-hybrid upstream mode explicitly')
  return mode
}

// The tool-call limit cases exist only in deterministic mode: only the
// deterministic upstream can emit more function calls than the contract allows,
// or exactly that many. validateReport compares this registry against the report
// by count as well as by title, so a case the spec declares and this list omits
// fails the entire lane without ever naming it.
export function expectedTitles(mode, provider = 'codex', suite) {
  validateProvider(provider)
  validateSuite(suite)
  validateMode(mode)
  if (provider === 'grok') {
    if (suite !== 'model-step-retry')
      throw new Error('The Grok lane runs only the model-step-retry suite')
    if (mode !== 'deterministic') throw new Error('The Grok lane runs only in deterministic mode')
    return [modelStepRetrySetupTitle, ...grokModelStepRetryTitles]
  }
  if (suite === 'model-step-retry') {
    if (mode !== 'deterministic')
      throw new Error('The Codex model-step-retry suite runs only in deterministic mode')
    return [modelStepRetrySetupTitle, ...modelStepRetryTitles]
  }
  if (suite === 'native-workflow') {
    if (mode !== 'deterministic')
      throw new Error('The Codex native-workflow suite runs only in deterministic mode')
    return [nativeWorkflowTitle]
  }
  if (mode === 'real-hybrid') return hybridRetryTitles
  return [
    'unauthenticated agent route guard prevents connector use',
    'authenticated user without agent access cannot select the protected agents',
    ...[83, 150, 250].map(
      size => `approved tools ${size}: ordinary discovery, reuse, approval decisions and revocation`
    ),
    ...(mode === 'deterministic' ? [toolCallLimitTitle, toolCallLimitBoundaryTitle] : []),
  ]
}

/**
 * The preconditions each suite run reads. The model-step suites run neither the
 * native workflow nor the unauthorized-user journey, and both of those keys are
 * still prepared (the identity keeps two users), so requiring them there would
 * describe a case that cannot run.
 */
export function requiredRunnerKeys(mode, provider = 'codex', suite) {
  validateProvider(provider)
  validateSuite(suite)
  validateMode(mode)
  const keys = [
    'MINIKUBE_PROFILE',
    'CONTROL_API_REAL_PG_CONTEXT',
    'CONTROL_UI_URL',
    'EXTERNAL_REST_API_BASE_URL',
    'RPC_PROXY_BASE_URL',
    'APPROVED_TOOLS_SCENARIOS',
  ]
  // The Grok lane has no workflow or unauthorized-user journey; it needs the
  // name of the connection the user created in the Control UI.
  if (provider === 'grok') return [...keys, 'APPROVED_TOOLS_GROK_CONNECTION_NAME']
  // Only the native-workflow run prepares a workflow scenario, and only the base
  // run creates the unauthorized user that its negative case selects.
  if (suite === 'native-workflow') return [...keys, 'APPROVED_TOOLS_WORKFLOW_SCENARIO']
  if (suite === 'model-step-retry' || mode === 'real-hybrid') return keys
  return [...keys, 'APPROVED_TOOLS_UNAUTHORIZED_EMAIL', 'APPROVED_TOOLS_UNAUTHORIZED_PASSWORD']
}

/**
 * Whether this run compares the upstream model-step block before and after
 * Playwright. Only the model-step suite moves those counters now; real-hybrid
 * keeps reading the same block for its injection counters.
 */
export function readsModelStepEvidence(mode, suite) {
  validateSuite(suite)
  validateMode(mode)
  return suite === 'model-step-retry' || mode === 'real-hybrid'
}

// The spec file that owns each registered title: a title found in another file
// is not the registered case.
export function specFileFor(title) {
  if (title === modelStepRetrySetupTitle) return modelStepSpecFile
  if (title === nativeWorkflowTitle) return nativeWorkflowSpecFile
  if (hybridRetryTitles.includes(title)) return hybridSpecFile
  return modelStepRetryTitles.includes(title) ? modelStepSpecFile : specFile
}

export function validateHybridEvidence(before, after) {
  for (const field of [
    'forwarded',
    'injected503',
    'r1',
    'r2',
    'r1DistinctToolResults',
    'r2DistinctToolResults',
  ]) {
    if (
      !Number.isSafeInteger(before?.[field]) ||
      !Number.isSafeInteger(after?.[field]) ||
      before[field] < 0 ||
      after[field] < before[field]
    )
      throw new Error(`Real-hybrid evidence missing or reset: ${field}`)
  }
  for (const [field, expected] of Object.entries({
    // R1 and R2 each fail one model step four times; the counters move per
    // injected response, so both journeys move by four.
    injected503: 8,
    r1: 4,
    r2: 4,
    // R1: search, describe, physical read. R2 also discovers and calls a new receipt.
    r1DistinctToolResults: 3,
    r2DistinctToolResults: 6,
  })) {
    if (after[field] - before[field] !== expected)
      throw new Error(`Real-hybrid evidence ${field} did not move by ${expected}`)
  }
  if (after.forwarded <= before.forwarded)
    throw new Error('Real-hybrid mode did not forward real provider requests')
  return { forwarded: after.forwarded - before.forwarded, injected503: 8 }
}

/**
 * Compares the upstream model-step evidence read before and after Playwright
 * against the expected change of every counter. A counter missing from either
 * read fails, so an upstream that stopped reporting the block cannot pass.
 */
export function validateModelStepEvidence(before, after, provider = 'codex') {
  const expectedDelta =
    validateProvider(provider) === 'grok'
      ? grokModelStepRetryExpectedDelta
      : modelStepRetryExpectedDelta
  const delta = {}
  for (const [field, expected] of Object.entries(expectedDelta)) {
    const from = before?.modelStepRetry?.[field]
    const to = after?.modelStepRetry?.[field]
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from)
      throw new Error(`Model-step retry evidence missing or reset: ${field}`)
    delta[field] = to - from
    if (delta[field] !== expected)
      throw new Error(
        `Model-step retry evidence ${field} moved by ${delta[field]}, expected ${expected}`
      )
  }
  return delta
}

function modelStepEvidenceUrl() {
  const parsed = JSON.parse(required('APPROVED_TOOLS_SCENARIOS'))
  if (!Array.isArray(parsed)) throw new Error('APPROVED_TOOLS_SCENARIOS must be an array')
  const rows = parsed.filter(row => row?.catalogSize === 83)
  if (rows.length !== 1) throw new Error('Exactly one 83-tool approved-tools scenario required')
  const url = new URL('/approved-tools/evidence', rows[0].upstreamEvidenceUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port)
    throw new Error('Upstream evidence must be a profile-owned loopback origin with port')
  return url
}

async function readModelStepEvidence(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Upstream evidence returned ${response.status}`)
  return response.json()
}

// MS-1 (runner part): the layer that stopped a Retry click, persisted in the run
// directory before the restore, pass or fail. Counts and closed tokens only:
// no log body, no request or response body, no credential. The proxy and Host
// markers are the two hops between the Desktop and the model; the admission
// counters are the login cost the lane paid to get there.
export const retryLayerProxyMarkers = Object.freeze({
  continueRequests: 'method=continue-model-step',
  forwardFailed: 'continue model step forward failed',
})
export const retryLayerHostMarkers = Object.freeze({
  admissionFailed: 'Model-step continuation admission failed',
  continueFailed: 'Error continuing model-step checkpoint',
  hostDraining: 'host_draining',
})
export const RETRY_LAYER_FILE = 'retry-layer.json'
export const ADMISSION_FILE = 'admission.json'

export function countMarkerLines(text, marker) {
  if (typeof text !== 'string') throw new Error('Retry layer evidence requires the log text')
  return text.split('\n').filter(line => line.includes(marker)).length
}

/**
 * The Host's admission refusal carries its `code` on the structured line. Only
 * that closed token and the count leave this function; the message body does not.
 */
export function admissionFailureCodes(text) {
  if (typeof text !== 'string') throw new Error('Retry layer evidence requires the log text')
  const codes = {}
  for (const line of text.split('\n')) {
    if (!line.includes(retryLayerHostMarkers.admissionFailed)) continue
    const match = /"(?:code|errCode)"\s*:\s*"([A-Za-z0-9_.-]{1,80})"/.exec(line)
    const code = match ? match[1] : 'unnamed'
    codes[code] = (codes[code] ?? 0) + 1
  }
  return codes
}

/** `password_admission_denials_total{reason="…"} <count>` lines only. */
export function parseAdmissionCounters(text) {
  if (typeof text !== 'string') throw new Error('Admission evidence requires the metrics text')
  const counters = {}
  for (const line of text.split('\n')) {
    const match = /^password_admission_denials_total\{reason="([a-z_]+)"\}\s+([0-9]+)$/.exec(
      line.trim()
    )
    if (match) counters[match[1]] = Number(match[2])
  }
  return counters
}

/** Per-reason change between the two reads; a reason absent before reads as 0. */
export function admissionDelta(before, after) {
  const delta = {}
  for (const reason of Object.keys(after)) delta[reason] = after[reason] - (before[reason] ?? 0)
  return delta
}

/** The bounded stage names the fixture recorded, in first-seen order. */
export function evidenceStages(evidence) {
  const stages = []
  for (const request of evidence?.requests ?? []) {
    if (typeof request?.stage === 'string' && !stages.includes(request.stage))
      stages.push(request.stage)
  }
  return stages
}

/** The fixture's model-step counters, copied as counts only. */
export function evidenceCounters(evidence) {
  const counters = evidence?.modelStepRetry
  if (!counters || typeof counters !== 'object') return {}
  const copy = {}
  for (const [field, value] of Object.entries(counters))
    if (Number.isSafeInteger(value)) copy[field] = value
  return copy
}

/** The fixture's ordinary-journey counters, copied from a closed field list. */
export function evidenceOrdinaryCounters(evidence) {
  const copy = {}
  for (const field of [
    'completions',
    'searchCalls',
    'describeCalls',
    'businessCalls',
    'finalResponses',
    'deniedResponses',
    'rejected',
  ]) {
    const value = evidence?.[field]
    if (Number.isSafeInteger(value) && value >= 0) copy[field] = value
  }
  return copy
}

/** Per-stage request counts; stage names are fixture constants, never payload. */
export function evidenceStageCounts(evidence) {
  const counts = {}
  for (const request of evidence?.requests ?? []) {
    const stage = request?.stage
    if (typeof stage !== 'string' || !/^[a-z0-9_]{1,80}$/.test(stage)) continue
    if (counts[stage] === undefined && Object.keys(counts).length >= 32) continue
    counts[stage] = (counts[stage] ?? 0) + 1
  }
  return counts
}

/**
 * The fixture's rejection counts by bounded internal error name, so a 422 in
 * the persisted evidence names its exact throw. Only fixture-constant names
 * with safe-integer counts are copied; anything else is dropped.
 */
export function evidenceRejections(evidence) {
  const rejections = evidence?.rejections
  if (!rejections || typeof rejections !== 'object' || Array.isArray(rejections)) return {}
  const copy = {}
  for (const [name, value] of Object.entries(rejections)) {
    if (Object.keys(copy).length >= 32) break
    if (/^[a-z0-9_]{1,80}$/.test(name) && Number.isSafeInteger(value) && value > 0)
      copy[name] = value
  }
  return copy
}

/** The one loopback evidence origin every prepared scenario shares. */
export function upstreamEvidenceOrigin(rows) {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error('Retry layer evidence requires at least one prepared scenario')
  const origins = new Set()
  for (const row of rows) {
    const url = new URL('/approved-tools/evidence', row?.upstreamEvidenceUrl)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port)
      throw new Error('Upstream evidence must be a profile-owned loopback origin with port')
    origins.add(url.origin)
  }
  if (origins.size !== 1) throw new Error('Prepared scenarios disagree on the evidence origin')
  return new URL('/approved-tools/evidence', [...origins][0] + '/')
}

export function scenarioRows(scenarios, workflowScenario) {
  const rows = Array.isArray(scenarios) ? scenarios : []
  return workflowScenario ? [...rows, workflowScenario] : rows
}

/**
 * Collects the retry-layer record and the admission record from injected reads,
 * so the shape is testable without a cluster. `since` is the lane start the two
 * log reads are bounded by.
 */
export async function observeRetryLayer({
  provider,
  suite,
  mode,
  since,
  scenarioRows: rows,
  hostDeployment,
  readProxyLog,
  readHostLog,
  readAdmission,
  readFixtureEvidence,
  admissionBefore,
}) {
  const proxyLog = await readProxyLog(since)
  const hostLog = await readHostLog(hostDeployment, since)
  const admissionAfter = await readAdmission()
  const evidence = await readFixtureEvidence(upstreamEvidenceOrigin(rows))
  return {
    retryLayer: {
      lane: { provider, suite, upstream: mode },
      window: { since },
      proxy: {
        continueRequests: countMarkerLines(proxyLog, retryLayerProxyMarkers.continueRequests),
        forwardFailed: countMarkerLines(proxyLog, retryLayerProxyMarkers.forwardFailed),
      },
      host: {
        deployment: hostDeployment,
        admissionFailed: countMarkerLines(hostLog, retryLayerHostMarkers.admissionFailed),
        admissionCodes: admissionFailureCodes(hostLog),
        continueFailed: countMarkerLines(hostLog, retryLayerHostMarkers.continueFailed),
        hostDraining: countMarkerLines(hostLog, retryLayerHostMarkers.hostDraining),
      },
      fixture: {
        counters: evidenceCounters(evidence),
        ordinaryCounters: evidenceOrdinaryCounters(evidence),
        stages: evidenceStages(evidence),
        stageCounts: evidenceStageCounts(evidence),
        rejections: evidenceRejections(evidence),
      },
    },
    admission: {
      counters: 'password_admission_denials_total',
      before: admissionBefore,
      after: admissionAfter,
      delta: admissionDelta(admissionBefore, admissionAfter),
    },
  }
}

/** Writes both files into the run directory; the only place they are created. */
export function persistRetryLayer(evidenceDirectory, record) {
  for (const [name, value] of [
    [RETRY_LAYER_FILE, record.retryLayer],
    [ADMISSION_FILE, record.admission],
  ]) {
    const body = JSON.stringify(value, null, 2) + '\n'
    if (Buffer.byteLength(body) > 128 * 1024)
      throw new Error(`Retry layer evidence exceeds its byte budget: ${name}`)
    fs.writeFileSync(path.join(evidenceDirectory, name), body, { flag: 'wx', mode: 0o600 })
  }
}

/**
 * Runs one lane phase and persists its layer evidence before the caller decides
 * the report verdict. A capture failure is deferred, never substituted: the
 * phase's own error (or the report verdict) is decided first, and the capture
 * error is thrown only when that verdict is green. This is the `finally` the
 * runner's main uses; keeping it here makes the ordering testable.
 */
export async function runLane({ runPhase, capture, validate }) {
  let captureError
  try {
    runPhase()
  } finally {
    try {
      await capture()
    } catch (error) {
      captureError = error
    }
  }
  const verdict = validate()
  if (captureError) throw captureError
  return verdict
}

// The in-pod admission read: the Control API metrics endpoint is internal to the
// cluster and needs no credential, so one `kubectl exec` returns exactly the
// password-admission lines. The program is fixed; only the port is read.
export const admissionProbeScript = `fetch('http://127.0.0.1:' + (process.env.CONTROL_API_PORT || '8090') + '/metrics').then(response => { if (!response.ok) throw new Error('metrics returned ' + response.status); return response.text() }).then(text => { process.stdout.write(text.split('\\n').filter(line => line.startsWith('password_admission_denials_total')).join('\\n')) }).catch(error => { process.stderr.write(String(error && error.message ? error.message : error).slice(0, 256) + '\\n'); process.exit(1) })`

export function runPhaseTimeouts() {
  return {
    playwright: APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS,
    electronCheck: APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS,
    staticAudit: APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS,
    playwrightSpawnGrace: APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS,
  }
}

export function validateReport(report, mode, provider = 'codex', suite) {
  const titles = expectedTitles(mode, provider, suite)
  const specs = []
  function collect(suites) {
    if (!Array.isArray(suites)) throw new Error('Incomplete Playwright suites')
    for (const suite of suites) {
      specs.push(...(suite.specs ?? []))
      collect(suite.suites ?? [])
    }
  }
  collect(report.suites)
  if (
    report.errors?.length ||
    report.stats?.unexpected !== 0 ||
    report.stats?.skipped !== 0 ||
    report.stats?.flaky !== 0 ||
    report.stats?.expected !== titles.length ||
    specs.length !== titles.length
  ) {
    throw new Error('Incomplete, failed, flaky or skipped approved-tools report')
  }
  for (const title of titles) {
    const file = specFileFor(title)
    const matches = specs.filter(
      spec =>
        spec.title === title &&
        [file, `desktop/${file}`, path.join(playwright, 'desktop', file)].includes(spec.file)
    )
    if (matches.length !== 1) throw new Error(`Required case missing or duplicated: ${title}`)
    const spec = matches[0]
    if (!spec.ok || spec.tests?.length !== 1) throw new Error(`Case not green: ${title}`)
    const test = spec.tests[0]
    if (
      test.expectedStatus !== 'passed' ||
      test.status !== 'expected' ||
      test.results?.length !== 1 ||
      test.results[0].status !== 'passed' ||
      test.results[0].errors?.length
    ) {
      throw new Error(`Case did not pass once without retries: ${title}`)
    }
  }
  return { tests: specs.length, skipped: 0, failed: 0 }
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required precondition: ${name}`)
  return value
}

function runNode(args, cwd, env, timeout) {
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS
  )
    throw new Error('Invalid browser deadline')
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, 'scripts/minikube/run-with-deadline.mjs'),
      '--timeout-seconds',
      String(Math.ceil(timeout / 1000)),
      '--kill-grace-seconds',
      String(APPROVED_TOOLS_RUNNER_KILL_GRACE_SECONDS),
      '--label',
      'approved-tools-playwright',
      '--',
      process.execPath,
      ...args,
    ],
    {
      cwd,
      env,
      stdio: 'inherit',
      timeout: timeout + APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS,
      killSignal: 'SIGTERM',
    }
  )
  if (result.error || result.signal || result.status !== 0)
    throw new Error('Approved-tools process failed, timed out or was interrupted')
}

async function main() {
  if (process.versions.node.split('.')[0] !== '24')
    throw new Error('Desktop certification requires Node 24')
  const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
  if (!['deterministic', 'real', 'real-hybrid'].includes(mode))
    throw new Error('Select deterministic, real or real-hybrid upstream mode explicitly')
  const provider = validateProvider(required('APPROVED_TOOLS_PROVIDER'))
  const suite = validateSuite(required('APPROVED_TOOLS_SUITE'))
  // Fails before any browser work when the provider, mode and suite do not combine.
  expectedTitles(mode, provider, suite)
  for (const key of requiredRunnerKeys(mode, provider, suite)) required(key)
  if (mode !== 'deterministic' && process.env.CODEX_REAL_UPSTREAM_CONFIRM !== '1')
    throw new Error('Real subscription use requires explicit confirmation')
  const evidence = validateRunDirectory(
    required('APPROVED_TOOLS_CANONICAL_ROOT'),
    required('APPROVED_TOOLS_EVIDENCE_DIR')
  )
  const report = path.join(evidence, `approved-tools-${mode}.json`)
  const artifacts = path.join(evidence, `artifacts-${mode}`)
  process.umask(0o077)
  // Playwright's JSON reporter writes this reserved inode with writeFile. Keep
  // the descriptor until verification; a replacement path cannot supply proof.
  const reportFile = openOwnedFile(evidence, path.basename(report), {
    create: true,
    maxBytes: 16 * 1024 * 1024,
  })
  try {
    fs.mkdirSync(artifacts, { mode: 0o700 })
    const env = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      PLAYWRIGHT_DESKTOP_BUILT: 'true',
      APPROVED_TOOLS_REPORT: report,
      APPROVED_TOOLS_ARTIFACTS: artifacts,
    }
    // Run the repository invariant; a dependency install exit code is insufficient.
    const electronCheck = spawnSync('npm', ['run', 'verify:electron'], {
      cwd: path.join(repo, 'desktop-app'),
      env,
      stdio: 'inherit',
      timeout: APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS,
    })
    if (electronCheck.error || electronCheck.signal || electronCheck.status !== 0)
      throw new Error('Desktop Electron verification failed')
    if (!fs.statSync(path.join(repo, 'desktop-app/dist/main.js')).isFile())
      throw new Error('Desktop build missing')
    const audit = spawnSync(
      'python3',
      [
        'tools/e2e_static_audit.py',
        `tests/e2e/playwright/desktop/${specFile}`,
        `tests/e2e/playwright/desktop/${nativeWorkflowSpecFile}`,
        `tests/e2e/playwright/desktop/${modelStepSpecFile}`,
        `tests/e2e/playwright/desktop/${hybridSpecFile}`,
        'tests/e2e/playwright/helpers/approved-tools-chat.ts',
        'tests/e2e/playwright/helpers/approved-tools-scenarios.ts',
        'tests/e2e/playwright/helpers/approved-tools-workflow.ts',
        'tests/e2e/playwright/helpers/approved-tools-subscription.ts',
      ],
      { cwd: repo, env, stdio: 'inherit', timeout: APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS }
    )
    if (audit.error || audit.signal || audit.status !== 0)
      throw new Error('E2E Guardian audit failed')
    const evidenceUrl = readsModelStepEvidence(mode, suite) ? modelStepEvidenceUrl() : undefined
    const evidenceBefore = evidenceUrl ? await readModelStepEvidence(evidenceUrl) : undefined
    const preparedScenarios = JSON.parse(required('APPROVED_TOOLS_SCENARIOS'))
    const workflowScenario = process.env.APPROVED_TOOLS_WORKFLOW_SCENARIO
      ? JSON.parse(required('APPROVED_TOOLS_WORKFLOW_SCENARIO'))
      : undefined
    const rows = scenarioRows(preparedScenarios, workflowScenario)
    // MS-1: the lane start bounds both log reads, and the admission counters are
    // read before the first Desktop login so the delta is this lane's own cost.
    const laneStartedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()
    const cluster = {
      profile: required('MINIKUBE_PROFILE'),
      kubectl: (args, timeout = 60_000) => {
        const result = spawnSync(
          'kubectl',
          ['--context', required('MINIKUBE_PROFILE'), '--request-timeout=30s', ...args],
          { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }
        )
        if (result.error || result.signal || result.status !== 0)
          throw new Error('Retry layer observation failed')
        return result.stdout
      },
    }
    const readAdmission = async () =>
      parseAdmissionCounters(
        cluster.kubectl([
          '-n',
          'control-plane',
          'exec',
          'deployment/control-api',
          '--',
          'node',
          '-e',
          admissionProbeScript,
        ])
      )
    const admissionBefore = await readAdmission()
    const hostDeployment = rows.find(row => row?.catalogSize === 83)?.agentName
    if (typeof hostDeployment !== 'string' || !hostDeployment)
      throw new Error('Retry layer evidence requires the prepared 83-tool agent')
    let capturedEvidence
    const verified = await runLane({
      runPhase: () =>
        runNode(
          [
            path.join(playwright, 'node_modules/@playwright/test/cli.js'),
            'test',
            '--config=playwright.codex-approved-tools.config.ts',
          ],
          playwright,
          env,
          APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS
        ),
      capture: async () => {
        const record = await observeRetryLayer({
          provider,
          suite,
          mode,
          since: laneStartedAt,
          scenarioRows: rows,
          hostDeployment,
          readProxyLog: since =>
            cluster.kubectl([
              '-n',
              'rpc-proxy',
              'logs',
              'deploy/rpc-proxy',
              `--since-time=${since}`,
            ]),
          readHostLog: (deploymentName, since) =>
            cluster.kubectl([
              '-n',
              'mcp-host',
              'logs',
              `deploy/${deploymentName}`,
              `--since-time=${since}`,
            ]),
          readAdmission,
          readFixtureEvidence: async url => {
            capturedEvidence = await readModelStepEvidence(url)
            return capturedEvidence
          },
          admissionBefore,
        })
        persistRetryLayer(evidence, record)
      },
      validate: () =>
        validateReport(JSON.parse(readOwnedDescriptor(reportFile)), mode, provider, suite),
    })
    const evidenceAfter = evidenceUrl ? capturedEvidence : undefined
    const modelStepRetry =
      suite === 'model-step-retry'
        ? validateModelStepEvidence(evidenceBefore, evidenceAfter, provider)
        : mode === 'real-hybrid'
          ? validateHybridEvidence(evidenceBefore, evidenceAfter)
          : undefined
    process.stdout.write(
      `${JSON.stringify({ lane: 'Playwright', provider, suite, upstream: mode, ...verified, modelStepRetry, report })}\n`
    )
  } finally {
    fs.closeSync(reportFile.fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
