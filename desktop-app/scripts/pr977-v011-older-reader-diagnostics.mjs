const SAFE_PHASES = new Set([
  'runner-principal-profile',
  'release-executable-verification',
  'credential-selector-preflight',
  'synthetic-endpoint-startup',
  'isolated-user-data-profile',
  'debug-port-allocation',
  'packaged-process-start',
  'packaged-cdp-attachment',
  'packaged-renderer-readiness',
  'synthetic-password-login',
  'synthetic-credential-readback',
  'owned-process-tree-stop',
  'baseline-getme-restore',
  'baseline-authenticated-ui',
  'publish-lp-marker',
  'lp-restore-observation',
  'reset-lp-before-v2',
  'lp-credential-state-before-v2',
  'reseed-synthetic-credential',
  'publish-v2-pending-state',
  'read-v2-pending-receipt',
  'v2-restore-observation',
  'evaluate-compatibility',
  'cleanup-owned-resources',
  'orchestration',
])

const SAFE_SCENARIOS = new Set(['initial-login', 'baseline', 'lp', 'v2'])

const OBSERVATION_KEYS = Object.freeze({
  'runner-principal-profile': ['principalProfileVerified'],
  'release-executable-verification': [
    'executablePresent',
    'productVersionVerified',
    'executableIntegrityReadable',
  ],
  'credential-selector-preflight': ['credentialReadSucceeded', 'preexistingSelectorCount'],
  'synthetic-endpoint-startup': ['restEndpointListening', 'rpcEndpointListening'],
  'isolated-user-data-profile': ['isolatedProfileObserved'],
  'debug-port-allocation': ['debugPortAllocated'],
  'packaged-process-start': ['processSpawnAttempted', 'processSpawned', 'processAlive'],
  'packaged-cdp-attachment': ['processSpawned', 'processAlive', 'cdpAttached'],
  'packaged-renderer-readiness': ['cdpAttached', 'rendererReady'],
  'synthetic-password-login': [
    'rendererReady',
    'loginSubmitted',
    'passwordLoginRequestCount',
    'authenticatedUi',
  ],
  'synthetic-credential-readback': ['syntheticCredentialPresent', 'credentialSelectorCount'],
  'owned-process-tree-stop': ['processTreeStopRequested', 'processStopped'],
  'baseline-getme-restore': ['getMeRequestCount', 'syntheticTokenGetMeCount'],
  'baseline-authenticated-ui': ['authenticatedUi', 'syntheticCredentialPresent'],
  'publish-lp-marker': ['logoutMarkerPublished', 'logoutMarkerRevisionVerified'],
  'lp-restore-observation': [
    'processSpawned',
    'cdpAttached',
    'rendererReady',
    'restoreDecisionReached',
    'loginFormVisible',
    'getMeRequestCount',
    'syntheticTokenGetMeCount',
    'authenticatedUi',
    'credentialChanged',
  ],
  'reset-lp-before-v2': ['logoutMarkerRemoved', 'authorityDirectoryRemoved', 'journalRemoved'],
  'lp-credential-state-before-v2': [
    'credentialReadSucceeded',
    'syntheticCredentialPresent',
    'credentialSelectorCount',
  ],
  'reseed-synthetic-credential': ['syntheticCredentialPresent'],
  'publish-v2-pending-state': [
    'writerStarted',
    'writerClosed',
    'writerTerminationRequested',
    'writerExitCodeKnown',
    'writerExitCode',
    'writerTerminatedBySignal',
  ],
  'read-v2-pending-receipt': [
    'authorityFrameVerified',
    'projectionIntentMatched',
    'candidateDenialVerified',
    'markerReceiptMatched',
    'legacyJournalSnapshotMatched',
    'syntheticCredentialPresent',
  ],
  'v2-restore-observation': [
    'processSpawned',
    'cdpAttached',
    'rendererReady',
    'restoreDecisionReached',
    'loginFormVisible',
    'getMeRequestCount',
    'syntheticTokenGetMeCount',
    'authenticatedUi',
    'credentialChanged',
  ],
  'evaluate-compatibility': ['baselineRestoreSucceeded', 'lpCaseDenied', 'v2CaseDenied'],
  'cleanup-owned-resources': [
    'processStopped',
    'writerStopped',
    'syntheticCredentialRemoved',
    'remainingTargetSelectorCount',
    'restEndpointClosed',
    'rpcEndpointClosed',
    'taskDirectoryRemoved',
  ],
  orchestration: [],
})

const SAFE_INCONCLUSIVE_CATEGORIES = new Set([
  'requires-fresh-github-hosted-windows-runner',
  'runner-profile-identity-unavailable',
  'windows-principal-profile-could-not-be-verified',
  'debug-port-unavailable',
  'packaged-binary-process-start-timeout',
  'windows-system-root-unavailable',
  'packaged-child-environment-not-sanitized',
  'packaged-binary-process-launch-failed',
  'packaged-binary-exited-before-renderer',
  'packaged-renderer-debug-endpoint-not-available',
  'packaged-renderer-root-not-ready',
  'packaged-renderer-page-missing',
  'packaged-electron-cdp-connection-failed',
  'owned-packaged-process-tree-did-not-stop',
  'owned-packaged-process-did-not-exit',
  'packaged-binary-did-not-use-the-isolated-user-data-profile',
  'synthetic-password-login-endpoint-not-reached',
  'v011-password-login-did-not-persist-to-isolated-keytar',
  'v011-cold-restart-did-not-read-synthetic-keytar-credential',
  'v011-baseline-restart-not-authenticated',
  'current-v2-repository-did-not-produce-matching-pending-state',
  'verified-v011-packaged-executable-not-available',
  'packaged-executable-integrity-not-readable',
  'isolated-windows-credential-manager-unavailable',
  'fresh-runner-evenfire-credential-selector-was-not-empty',
  'synthetic-profile-escaped-runner-temp',
  'synthetic-local-endpoint-port-unavailable',
  'current-lp-marker-writer-did-not-publish-durable-revision',
  'v011-lp-startup-did-not-reach-a-restore-decision',
  'v011-lp-startup-did-not-reach-a-stable-authentication-surface',
  'task-owned-lp-marker-could-not-be-cleared-for-next-case',
  'v011-could-not-reseed-synthetic-credential-for-v2-case',
  'v011-lp-case-left-an-unexpected-credential-selector-state',
  'current-v2-repository-writer-did-not-exit-expectedly',
  'current-v2-repository-writer-did-not-exit',
  'current-v2-repository-writer-exceeded-timeout',
  'child-process-terminated-by-signal',
  'child-process-exit-state-unknown',
  'synthetic-denied-token-missing-before-v2-restore',
  'v011-v2-startup-did-not-reach-a-restore-decision',
  'v011-v2-startup-did-not-reach-a-stable-authentication-surface',
  'owned-packaged-process-tree-did-not-stop',
  'owned-packaged-process-did-not-exit',
  'cleanup-verification-failed',
  'older-reader-denial-assertion-not-reached',
  'older-binary-login-form-not-reached',
  'older-binary-login-did-not-authenticate',
  'current-v2-repository-did-not-produce-matching-pending-state',
  'packaged-binary-did-not-use-the-isolated-user-data-profile',
  'local-test-server-did-not-close',
])

const SAFE_PLATFORM_CODES = Object.freeze({
  EACCES: 'platform-access-denied',
  EADDRINUSE: 'platform-address-in-use',
  ECONNREFUSED: 'platform-connection-refused',
  EPIPE: 'platform-pipe-closed',
  ETIMEDOUT: 'platform-timeout',
  ENOENT: 'platform-file-not-found',
  ENOSPC: 'platform-no-space',
  EPERM: 'platform-operation-not-permitted',
  EMFILE: 'platform-process-handle-limit',
  ENFILE: 'platform-system-handle-limit',
  ERR_CHILD_PROCESS_STDIO_MAXBUFFER: 'child-output-limit',
})

const SAFE_ERROR_NAMES = Object.freeze({
  TimeoutError: 'playwright-timeout',
  TargetClosedError: 'playwright-target-closed',
  ProtocolError: 'playwright-protocol-error',
  AbortError: 'operation-aborted',
})

const SAFE_FAILURE_CATEGORIES = new Set([
  ...SAFE_INCONCLUSIVE_CATEGORIES,
  ...Object.values(SAFE_PLATFORM_CODES),
  ...Object.values(SAFE_ERROR_NAMES),
  'unexpected-error',
  'unsafe-older-reader-behavior',
])

const SAFE_PHASE_STATUSES = new Set(['STARTED', 'PASS', 'INCONCLUSIVE', 'FAIL'])
const MAX_ELAPSED_MS = 4 * 60 * 60 * 1000
const MAX_OBSERVATION_COUNT = 10_000

export class InconclusiveError extends Error {
  constructor(category) {
    super('compatibility experiment did not reach a verified outcome')
    this.name = 'InconclusiveError'
    this.category = category
  }
}

export class UnsafeOlderReaderBehaviorError extends Error {
  constructor() {
    super('older reader violated the tested denial contract')
    this.name = 'UnsafeOlderReaderBehaviorError'
  }
}

export function waitForOwnedChildClose(
  child,
  { timeoutMs, terminationGraceMs = 10_000, onTerminationRequested = () => {} }
) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false })
      return
    }

    let settled = false
    let timedOut = false
    let timer
    let terminationTimer
    const finish = callback => value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (terminationTimer) clearTimeout(terminationTimer)
      child.off('close', onClose)
      child.off('error', onError)
      callback(value)
    }
    const close = finish(resolve)
    const onClose = (code, signal) => close({ code, signal, timedOut })
    const onError = finish(reject)
    timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      try {
        onTerminationRequested()
        child.kill()
      } catch {
        finish(() => reject(new InconclusiveError('current-v2-repository-writer-did-not-exit')))()
        return
      }
      if (settled) return
      terminationTimer = setTimeout(() => {
        finish(() => reject(new InconclusiveError('current-v2-repository-writer-did-not-exit')))()
      }, terminationGraceMs)
    }, timeoutMs)
    child.once('close', onClose)
    child.once('error', onError)
  })
}

export async function runWhenOwnedProcessesStopped(state, operation) {
  if (state?.processStopped !== true || state?.writerStopped !== true) return false
  await operation()
  return true
}

export function classifyDiagnosticFailure(error) {
  if (error instanceof UnsafeOlderReaderBehaviorError) {
    return { status: 'FAIL', category: 'unsafe-older-reader-behavior' }
  }
  if (error instanceof InconclusiveError) {
    return {
      status: 'INCONCLUSIVE',
      category: SAFE_INCONCLUSIVE_CATEGORIES.has(error.category)
        ? error.category
        : 'unexpected-error',
    }
  }
  if (error && typeof error === 'object') {
    if (typeof error.code === 'string' && Object.hasOwn(SAFE_PLATFORM_CODES, error.code)) {
      return { status: 'INCONCLUSIVE', category: SAFE_PLATFORM_CODES[error.code] }
    }
    if (typeof error.name === 'string' && Object.hasOwn(SAFE_ERROR_NAMES, error.name)) {
      return { status: 'INCONCLUSIVE', category: SAFE_ERROR_NAMES[error.name] }
    }
  }
  return { status: 'INCONCLUSIVE', category: 'unexpected-error' }
}

function sanitizeObservations(phase, observations) {
  const permitted = OBSERVATION_KEYS[phase]
  const safe = {}
  if (!permitted || !observations || typeof observations !== 'object') return safe
  for (const key of permitted) {
    const value = observations[key]
    if (typeof value === 'boolean') safe[key] = value
    else if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_OBSERVATION_COUNT
    ) {
      safe[key] = value
    }
  }
  return safe
}

function createPhaseRecord(phase, status, elapsedMs, options = {}) {
  const boundedElapsedMs = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.min(MAX_ELAPSED_MS, Math.floor(elapsedMs)))
    : 0
  const record = {
    kind: 'compatibility-phase',
    phase,
    status,
    elapsedMs: boundedElapsedMs,
    observations: sanitizeObservations(phase, options.observations?.()),
  }
  if (options.scenario && SAFE_SCENARIOS.has(options.scenario)) record.scenario = options.scenario
  if (options.failureCategory)
    record.failureCategory = SAFE_FAILURE_CATEGORIES.has(options.failureCategory)
      ? options.failureCategory
      : 'unexpected-error'
  return record
}

export async function runDiagnosticPhase(
  phase,
  operation,
  {
    scenario,
    observations = () => ({}),
    report = record => console.log(JSON.stringify(record)),
    now = Date.now,
  } = {}
) {
  if (!SAFE_PHASES.has(phase)) throw new TypeError('phase is not allowlisted')
  if (scenario && !SAFE_SCENARIOS.has(scenario)) throw new TypeError('scenario is not allowlisted')
  if (typeof operation !== 'function') throw new TypeError('phase operation must be a function')
  const startedAt = now()
  report(createPhaseRecord(phase, 'STARTED', 0, { scenario, observations }))
  try {
    const result = await operation()
    report(createPhaseRecord(phase, 'PASS', now() - startedAt, { scenario, observations }))
    return result
  } catch (error) {
    const failure = classifyDiagnosticFailure(error)
    report(
      createPhaseRecord(phase, failure.status, now() - startedAt, {
        scenario,
        observations,
        failureCategory: failure.category,
      })
    )
    throw error
  }
}

export function classifyUncaughtExperimentFailure(error, phase = 'orchestration') {
  const failure = classifyDiagnosticFailure(error)
  return {
    kind: 'compatibility-experiment-result',
    status: failure.status,
    failedPhase: SAFE_PHASES.has(phase) ? phase : 'orchestration',
    failureCategory: failure.category,
  }
}

export function attachFinalCleanupObservations(summary, observations) {
  if (!summary) return null
  return {
    ...summary,
    cleanup: sanitizeObservations('cleanup-owned-resources', observations),
  }
}
