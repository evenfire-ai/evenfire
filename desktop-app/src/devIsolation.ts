/**
 * Desktop dev-isolation contract.
 *
 * Three PRs have to be able to run the desktop app side by side on one machine.
 * Today they cannot, because three pieces of state are machine-wide:
 *
 *   - the OS protocol handler. `registerCustomProtocols()` makes the *running*
 *     bundle the default handler for `evenfire:`/`clerum:`, so whoever launches
 *     last steals the deep links of everyone else — and a computer-use agent
 *     that resolves the app by name lands on an arbitrary instance.
 *   - the application name (`Evenfire`), which is exactly what a computer-use
 *     agent has to disambiguate between.
 *   - the user-data directory, which holds the Chromium profile, the stored
 *     runtime-config profiles and the session material.
 *
 * This module is the pure contract for the explicit, opt-in isolation mode that
 * removes that sharing. It owns:
 *
 *   - the opt-in itself (`--evenfire-dev-isolation` or
 *     `EVENFIRE_DEV_ISOLATION=1`), so that a normal launch can never drift into
 *     isolated behaviour and an isolated launch can never silently fall back to
 *     the shared profile;
 *   - validation of what the launcher declared: an absolute per-run directory, a
 *     template of paths under it, loopback endpoints with explicit ports and no
 *     embedded credentials, and a safe target slug;
 *   - the derived visible identity (`PR660 · Minikube30488` plus an ASCII app
 *     name) used for the process title, `app.setName` and the window title;
 *   - the runtime policy that states, in one place, that an isolated run must
 *     not register OS protocols and must not process deep links;
 *   - verification of the *effective* runtime (real userData, app path,
 *     endpoints, config storage path) against the declaration, so a divergence
 *     aborts instead of quietly reading a shared profile.
 *
 * The module performs no I/O, imports nothing from Electron, and never reads a
 * profile, a keychain entry, an environment dump or a secret: the caller passes
 * in what it observed. That keeps every security-relevant invariant testable
 * without launching a GUI.
 *
 * Nothing here changes the normal startup path. With no opt-in the only result
 * is `{ mode: 'normal' }`, and callers keep today's behaviour unchanged.
 */
import path from 'node:path'

/** Opt-in flag accepted on the command line. */
export const DEV_ISOLATION_FLAG = '--evenfire-dev-isolation'
/** Opt-in environment variable; `1`/`true` enable, `0`/`false`/unset do not. */
export const DEV_ISOLATION_ENABLE_ENV = 'EVENFIRE_DEV_ISOLATION'

/**
 * Payload the launcher declares. Only the run directory, the two endpoints, the
 * target slug and (optionally) the PR number and expected app path are needed;
 * every other value is derived here so the launcher and the app cannot disagree
 * about names or paths.
 */
export const DEV_ISOLATION_ENV = {
  runDir: 'EVENFIRE_DEV_ISOLATION_RUN_DIR',
  restUrl: 'EVENFIRE_DEV_ISOLATION_REST_URL',
  rpcUrl: 'EVENFIRE_DEV_ISOLATION_RPC_URL',
  target: 'EVENFIRE_DEV_ISOLATION_TARGET',
  pr: 'EVENFIRE_DEV_ISOLATION_PR',
  appPath: 'EVENFIRE_DEV_ISOLATION_APP_PATH',
} as const

export const DEV_ISOLATION_USER_DATA_DIR_NAME = 'user-data'
export const DEV_ISOLATION_CONFIG_FILE_NAME = 'runtime-config.json'
export const DEV_ISOLATION_RECORD_FILE_NAME = 'run.json'
export const DEV_ISOLATION_PID_FILE_NAME = 'run.pid'
/** Prefix of the shared default app name; an isolated name must extend it. */
export const DEV_ISOLATION_APP_NAME_PREFIX = 'Evenfire'

const ENABLED_VALUES = new Set(['1', 'true'])
const DISABLED_VALUES = new Set(['0', 'false'])
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PR_PATTERN = /^[0-9]{1,6}$/
// The visible label may contain the middle dot the operator reads; the app name
// stays plain ASCII because it becomes a process and application name.
const LABEL_PATTERN = /^[\x20-\x7e\u00b7]{1,80}$/
const APP_NAME_PATTERN = /^[\x20-\x7e]{1,64}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export type DevIsolationEnablement = 'disabled' | 'enabled' | 'invalid'

/**
 * Read the opt-in. An unrecognized value is `invalid` rather than `disabled`:
 * a typo must refuse the launch instead of quietly starting the shared-profile
 * app the operator was trying to avoid.
 */
export function readDevIsolationEnablement(
  env: NodeJS.ProcessEnv,
  argv: readonly string[]
): DevIsolationEnablement {
  const raw = String(env[DEV_ISOLATION_ENABLE_ENV] ?? '')
    .trim()
    .toLowerCase()
  const flagged = argv.includes(DEV_ISOLATION_FLAG)
  if (ENABLED_VALUES.has(raw) || flagged) return 'enabled'
  if (raw === '' || DISABLED_VALUES.has(raw)) return 'disabled'
  return 'invalid'
}

export type DevIsolationPaths = {
  runDir: string
  userDataDir: string
  configPath: string
  recordPath: string
  pidPath: string
}

/** Template of the per-run paths, derived from the run directory alone. */
export function devIsolationPaths(runDir: string): DevIsolationPaths {
  const root = path.resolve(runDir)
  return {
    runDir: root,
    userDataDir: path.join(root, DEV_ISOLATION_USER_DATA_DIR_NAME),
    configPath: path.join(root, DEV_ISOLATION_CONFIG_FILE_NAME),
    recordPath: path.join(root, DEV_ISOLATION_RECORD_FILE_NAME),
    pidPath: path.join(root, DEV_ISOLATION_PID_FILE_NAME),
  }
}

export type DevIsolationIdentity = {
  target: string
  pr: string | null
  /** Visible, non-ASCII-safe label, e.g. `PR660 · Minikube30488`. */
  label: string
  /** Process and application name, e.g. `Evenfire PR660 Minikube30488`. */
  appName: string
}

function titleCaseToken(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(token => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join('')
}

/**
 * Derive the unique visible identity from the target slug and the optional PR
 * number. Deterministic: the launcher and the app compute the same value from
 * the same inputs, so a drifted name is a detectable divergence, not a silent
 * difference.
 */
export function deriveDevIsolationIdentity(input: {
  target: string
  pr?: string | null
}): DevIsolationIdentity {
  const target = String(input.target ?? '').trim()
  const pr = typeof input.pr === 'string' && input.pr.trim() ? input.pr.trim() : null
  const targetLabel = titleCaseToken(target) || 'Target'
  const prLabel = pr ? `PR${pr}` : ''
  const label = prLabel ? `${prLabel} \u00b7 ${targetLabel}` : targetLabel
  const appName = `${DEV_ISOLATION_APP_NAME_PREFIX} ${[prLabel, targetLabel]
    .filter(Boolean)
    .join(' ')}`
  return { target, pr, label, appName }
}

/**
 * A loopback endpoint with an explicit port and no embedded credentials. This
 * is deliberately strict: an isolated run must not be pointable at a shared or
 * remote deployment by a mistyped or hostile input, and a URL that carries a
 * user/password must never reach the public run record.
 */
export function isLoopbackEndpointUrl(value: string): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false
  if (!url.port) return false
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (url.pathname !== '/' || url.search || url.hash) return false
  return true
}

/** Strict containment: a path equal to `parent` is not "inside" it. */
export function isPathInside(parent: string, child: string): boolean {
  const from = path.resolve(parent)
  const to = path.resolve(child)
  if (from === to) return false
  const prefix = from.endsWith(path.sep) ? from : `${from}${path.sep}`
  return to.startsWith(prefix)
}

export type DevIsolationPlan = DevIsolationPaths & {
  restUrl: string
  rpcUrl: string
  appPath: string | null
  identity: DevIsolationIdentity
  label: string
  appName: string
}

export type DevIsolationRefusal = { code: string; message: string }
export type DevIsolationPlanResult =
  | { ok: true; plan: DevIsolationPlan }
  | ({ ok: false } & DevIsolationRefusal)

/**
 * Validate the launcher's declaration and build the plan. Every failure is a
 * refusal, never a fallback: the caller aborts.
 */
export function buildDevIsolationPlan(env: NodeJS.ProcessEnv): DevIsolationPlanResult {
  const rawRunDir = String(env[DEV_ISOLATION_ENV.runDir] ?? '').trim()
  if (!rawRunDir) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_RUN_DIR_REQUIRED',
      message: `${DEV_ISOLATION_ENV.runDir} is required`,
    }
  }
  if (!path.isAbsolute(rawRunDir)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_RUN_DIR_NOT_ABSOLUTE',
      message: `${DEV_ISOLATION_ENV.runDir} must be an absolute path`,
    }
  }

  const rawTarget = String(env[DEV_ISOLATION_ENV.target] ?? '').trim()
  if (!TARGET_PATTERN.test(rawTarget)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_TARGET_INVALID',
      message: `${DEV_ISOLATION_ENV.target} must match ${TARGET_PATTERN.source}`,
    }
  }

  const rawPr = String(env[DEV_ISOLATION_ENV.pr] ?? '').trim()
  if (rawPr && !PR_PATTERN.test(rawPr)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_PR_INVALID',
      message: `${DEV_ISOLATION_ENV.pr} must be digits only`,
    }
  }

  const rawRestUrl = String(env[DEV_ISOLATION_ENV.restUrl] ?? '').trim()
  if (!isLoopbackEndpointUrl(rawRestUrl)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_REST_URL_INVALID',
      message: `${DEV_ISOLATION_ENV.restUrl} must be an http(s) loopback URL with an explicit port and no credentials`,
    }
  }
  const rawRpcUrl = String(env[DEV_ISOLATION_ENV.rpcUrl] ?? '').trim()
  if (!isLoopbackEndpointUrl(rawRpcUrl)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_RPC_URL_INVALID',
      message: `${DEV_ISOLATION_ENV.rpcUrl} must be an http(s) loopback URL with an explicit port and no credentials`,
    }
  }

  const rawAppPath = String(env[DEV_ISOLATION_ENV.appPath] ?? '').trim()
  if (rawAppPath && !path.isAbsolute(rawAppPath)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_APP_PATH_NOT_ABSOLUTE',
      message: `${DEV_ISOLATION_ENV.appPath} must be an absolute path when set`,
    }
  }

  const identity = deriveDevIsolationIdentity({ target: rawTarget, pr: rawPr || null })
  if (!LABEL_PATTERN.test(identity.label)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_LABEL_INVALID',
      message: 'derived isolation label must be 1-80 printable characters',
    }
  }
  if (!APP_NAME_PATTERN.test(identity.appName)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_APP_NAME_INVALID',
      message: 'derived isolation app name must be 1-64 printable ASCII characters',
    }
  }
  if (identity.appName === DEV_ISOLATION_APP_NAME_PREFIX) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_APP_NAME_NOT_UNIQUE',
      message: `an isolated app name must extend ${DEV_ISOLATION_APP_NAME_PREFIX}, not collide with it`,
    }
  }

  const paths = devIsolationPaths(rawRunDir)
  return {
    ok: true,
    plan: {
      ...paths,
      restUrl: rawRestUrl,
      rpcUrl: rawRpcUrl,
      appPath: rawAppPath || null,
      identity,
      label: identity.label,
      appName: identity.appName,
    },
  }
}

export type DevIsolationDecision =
  | { mode: 'normal' }
  | { mode: 'isolated'; plan: DevIsolationPlan }
  | ({ mode: 'refused' } & DevIsolationRefusal)

/**
 * Total decision for the main process: normal, isolated, or refused. Refused is
 * a distinct outcome on purpose — an isolation request that cannot be honoured
 * must never continue as a shared-profile launch.
 */
export function resolveDevIsolation(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  isPackaged = false
): DevIsolationDecision {
  const enablement = readDevIsolationEnablement(env, argv)
  if (enablement === 'disabled') return { mode: 'normal' }
  if (enablement === 'invalid') {
    return {
      mode: 'refused',
      code: 'DEV_ISOLATION_ENABLE_INVALID',
      message: `${DEV_ISOLATION_ENABLE_ENV} must be 1/true/0/false or unset, or ${DEV_ISOLATION_FLAG} must be passed`,
    }
  }
  if (isPackaged) {
    return {
      mode: 'refused',
      code: 'DEV_ISOLATION_PACKAGED',
      message: 'Isolation is development-only',
    }
  }
  const plan = buildDevIsolationPlan(env)
  if (!plan.ok) return { mode: 'refused', code: plan.code, message: plan.message }
  const inline = argv.find(argument => argument.startsWith('--user-data-dir='))
  const index = argv.indexOf('--user-data-dir')
  const userData = inline?.slice('--user-data-dir='.length) ?? (index >= 0 ? argv[index + 1] : '')
  if (
    !userData ||
    !path.isAbsolute(userData) ||
    path.resolve(userData) !== plan.plan.userDataDir ||
    env.CLERUM_DESKTOP_CONFIG_PATH !== plan.plan.configPath ||
    env.EXTERNAL_REST_API_BASE_URL !== plan.plan.restUrl ||
    env.RPC_PROXY_BASE_URL !== plan.plan.rpcUrl
  ) {
    return {
      mode: 'refused',
      code: 'DEV_ISOLATION_LAUNCH_MISMATCH',
      message:
        'Explicit user data, config path and effective endpoints must match the isolation plan',
    }
  }
  return { mode: 'isolated', plan: plan.plan }
}

export type DevIsolationRuntimePolicy = {
  isolate: boolean
  /** Isolated runs leave the machine-wide protocol handler untouched. */
  registerOsProtocols: boolean
  /** Isolated runs never route deep links, including another session's. */
  acceptDeepLinks: boolean
  /** Isolated runs keep their label as the window title. */
  pinWindowTitle: boolean
  /** Unique process/application name, or null to keep the shipped name. */
  appName: string | null
  /** Visible window title, or null to keep the derived production title. */
  windowTitle: string | null
}

/**
 * The single place that decides what an isolated run may do with machine-wide
 * state. With no plan every field is the production value, so the normal path
 * stays unchanged.
 */
export function devIsolationRuntimePolicy(
  plan: DevIsolationPlan | null
): DevIsolationRuntimePolicy {
  if (!plan) {
    return {
      isolate: false,
      registerOsProtocols: true,
      acceptDeepLinks: true,
      pinWindowTitle: false,
      appName: null,
      windowTitle: null,
    }
  }
  return {
    isolate: true,
    registerOsProtocols: false,
    acceptDeepLinks: false,
    pinWindowTitle: true,
    appName: plan.appName,
    windowTitle: plan.label,
  }
}

export type DevIsolationObservation = {
  pid: number
  /** Real (`realpath`) userData directory Electron resolved. */
  userDataDir: string
  /** Real app path the process is running from. */
  appPath: string
  /** Effective endpoints after config hydration. */
  restUrl: string
  rpcUrl: string
  /** Effective runtime-config storage path after hydration. */
  configStoragePath: string
  /** Derived environment key of the hydrated runtime. */
  envKey: string
}

export type DevIsolationMismatch = {
  field: 'userDataDir' | 'appPath' | 'restUrl' | 'rpcUrl' | 'configStoragePath'
  expected: string
  actual: string
}

export type DevIsolationVerdict = { ok: true } | { ok: false; mismatches: DevIsolationMismatch[] }

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

/**
 * Compare what the app actually resolved against what the launcher declared.
 *
 * The config storage path is compared exactly, not by containment: it is the
 * proof that the runtime-config layer pointed at the isolated file instead of
 * the developer's shared `runtime-configs` directory. Callers pass `realpath`
 * results for the paths, so a symlinked parent cannot fake a match.
 */
export function verifyDevIsolationRuntime(
  plan: DevIsolationPlan,
  observed: DevIsolationObservation
): DevIsolationVerdict {
  const mismatches: DevIsolationMismatch[] = []
  if (!samePath(plan.userDataDir, observed.userDataDir)) {
    mismatches.push({
      field: 'userDataDir',
      expected: plan.userDataDir,
      actual: observed.userDataDir,
    })
  }
  if (plan.appPath && !samePath(plan.appPath, observed.appPath)) {
    mismatches.push({ field: 'appPath', expected: plan.appPath, actual: observed.appPath })
  }
  if (plan.restUrl !== observed.restUrl) {
    mismatches.push({ field: 'restUrl', expected: plan.restUrl, actual: observed.restUrl })
  }
  if (plan.rpcUrl !== observed.rpcUrl) {
    mismatches.push({ field: 'rpcUrl', expected: plan.rpcUrl, actual: observed.rpcUrl })
  }
  if (!samePath(plan.configPath, observed.configStoragePath)) {
    mismatches.push({
      field: 'configStoragePath',
      expected: plan.configPath,
      actual: observed.configStoragePath,
    })
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches }
}

/** Keys a public run record may contain. Nothing else is ever serialized. */
export const DEV_ISOLATION_RECORD_FIELDS = [
  'kind',
  'pid',
  'label',
  'appName',
  'target',
  'envKey',
  'runDir',
  'userDataDir',
  'configPath',
  'configStoragePath',
  'appPath',
  'restUrl',
  'rpcUrl',
] as const

/**
 * Public metadata for one isolated run: the identity, the pid and the paths and
 * endpoints the operator asked to see. Built from an allow-list so a caller
 * cannot leak an environment dump, a token or a credential into the record, and
 * so the record is byte-identical between the launcher and the app.
 */
export function publicDevIsolationRecord(
  plan: DevIsolationPlan,
  observed: DevIsolationObservation
): Record<string, string | number> {
  if (!verifyDevIsolationRuntime(plan, observed).ok) {
    throw new Error('Isolation metadata is unavailable before runtime verification')
  }
  return {
    kind: 'evenfire-dev-isolation',
    pid: observed.pid,
    label: plan.label,
    appName: plan.appName,
    target: plan.identity.target,
    envKey: observed.envKey,
    runDir: plan.runDir,
    userDataDir: observed.userDataDir,
    configPath: plan.configPath,
    configStoragePath: observed.configStoragePath,
    appPath: observed.appPath,
    restUrl: observed.restUrl,
    rpcUrl: observed.rpcUrl,
  }
}

function singleLineValue(value: string | number | undefined): string {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '')
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One log line, deterministic order, never multi-line. */
export function formatDevIsolationLogLine(record: Record<string, string | number>): string {
  const fields = Object.keys(record)
    .sort()
    .map(key => `${key}=${singleLineValue(record[key])}`)
  return `[Desktop][dev-isolation] ${fields.join(' ')}`
}

export type IsolationBaseDirDecision =
  | { ok: true; baseDir: string }
  | ({ ok: false } & DevIsolationRefusal)

/** Platform default parent directory for per-run directories. */
export function defaultIsolationBaseDir(input: {
  platform: NodeJS.Platform
  homedir: string
  env: NodeJS.ProcessEnv
}): string {
  if (input.platform === 'darwin') {
    return path.join(
      input.homedir,
      'Library',
      'Application Support',
      `${DEV_ISOLATION_APP_NAME_PREFIX} Dev Isolation`
    )
  }
  if (input.platform === 'win32') {
    const localAppData = String(input.env.LOCALAPPDATA ?? '').trim()
    return path.join(
      localAppData || path.join(input.homedir, 'AppData', 'Local'),
      `${DEV_ISOLATION_APP_NAME_PREFIX} Dev Isolation`
    )
  }
  const stateHome = String(input.env.XDG_STATE_HOME ?? '').trim()
  return path.join(
    stateHome || path.join(input.homedir, '.local', 'state'),
    'evenfire-dev-isolation'
  )
}

/**
 * Admit the parent directory of the per-run directories. A requested directory
 * must be absolute and outside the repository: run state holds credentials-side
 * material (the Chromium profile), and it must never land in the worktree where
 * it could be committed or copied into notes.
 */
export function admitIsolationBaseDir(input: {
  requested?: string
  repoRoot: string
  platform: NodeJS.Platform
  homedir: string
  env: NodeJS.ProcessEnv
}): IsolationBaseDirDecision {
  const requested = String(input.requested ?? '').trim()
  if (requested && !path.isAbsolute(requested)) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_BASE_DIR_NOT_ABSOLUTE',
      message: 'the isolation base directory must be an absolute path',
    }
  }
  const baseDir = requested
    ? path.resolve(requested)
    : defaultIsolationBaseDir({
        platform: input.platform,
        homedir: input.homedir,
        env: input.env,
      })
  if (isPathInside(input.repoRoot, baseDir) || path.resolve(input.repoRoot) === baseDir) {
    return {
      ok: false,
      code: 'DEV_ISOLATION_BASE_DIR_INSIDE_REPO',
      message: 'the isolation base directory must be outside the repository',
    }
  }
  return { ok: true, baseDir }
}
