import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  canonicalizeDesktopRestEndpoint,
  sameDesktopRestEndpoint,
} from './desktopEnvironmentUrl.js'
import type {
  DesktopRuntimeConfig,
  DesktopRuntimeConfigOption,
  DesktopRuntimeConfigState,
} from './types.js'

type DesktopConfig = Omit<DesktopRuntimeConfig, 'appName' | 'rpcProxyBaseUrl'> & {
  rpcProxyBaseUrl: string
  memberRegistrationServiceBaseUrl: string
  desktopProfileUiBaseUrl: string
  desktopProfileUiBaseUrlExplicit: boolean
  deploymentDocsUrl: string
  hostedSignupUrl: string
  requestTimeoutMs: number
  gfsUploadTimeoutMs: number
  appName: string
}

type RuntimeConfigIndexEntry = {
  id: string
  appName: string
  fileName: string
  createdAt: string
  updatedAt: string
}

type RuntimeConfigIndex = {
  version: 1
  activeProfileId: string | null
  profiles: RuntimeConfigIndexEntry[]
}

type StoredRuntimeProfile = {
  id: string
  appName: string
  filePath: string
  createdAt: string
  updatedAt: string
  config: DesktopRuntimeConfig
}

const DEFAULT_APP_NAME = 'Evenfire'
const PROFILE_UI_BASE_URL_ORIGIN_ERROR =
  'PROFILE_UI_BASE_URL must be an origin URL with a root pathname and no search parameters'
const LOCALHOST_OPTION_ID = '__localhost__'
const LOCALHOST_EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:8091'
const LOCALHOST_RPC_PROXY_BASE_URL = 'http://127.0.0.1:8094'
// Where onboarding's self-hosted path sends the user. Self-hosting
// means any cluster the user controls — remote or local — so this must land on
// documentation that covers both shapes, never on the minikube quickstart
// alone. A build-time constant, overridable only where the dev env config gate
// already allows overrides, so a packaged build cannot be pointed elsewhere.
const DEFAULT_DEPLOYMENT_DOCS_URL =
  'https://github.com/evenfire-ai/evenfire#deploying-to-a-remote-cluster'
// Where onboarding's hosted path sends the user. Today this is the
// marketing site, not a signup endpoint: there is no tenant provisioning and no
// evenfire://desktop-environment handoff yet, so the hosted step links out and
// offers the manual-address fallback for when the user returns with a server.
// Same build-time-constant rule as the docs URL.
const DEFAULT_HOSTED_SIGNUP_URL = 'https://evenfire.ai'
const RUNTIME_CONFIG_DIR_NAME = 'runtime-configs'
/**
 * Dev switch for previewing the first-run onboarding flow on a
 * machine that already has environments configured. Defaults to false; only
 * the exact string "true" enables it.
 *
 * Onboarding is by definition the zero-environment state, so a developer whose
 * app is already configured — including anyone launched by `make local-app`,
 * which exports EXTERNAL_REST_API_BASE_URL and RPC_PROXY_BASE_URL — can never
 * reach it. Rather than fake the view, this makes the app genuinely start cold:
 * it reads and writes runtime config in a SEPARATE directory and ignores the
 * env-var runtime config. The wizard is real, saving an environment works, and
 * the developer's actual environments are neither read nor modified — unset the
 * variable and they are all still there.
 */
const ONBOARDING_PREVIEW = process.env.EVENFIRE_ONBOARDING_PREVIEW?.trim().toLowerCase() === 'true'
const ONBOARDING_PREVIEW_DIR_NAME = 'runtime-configs-onboarding-preview'
const activeRuntimeConfigDirName = ONBOARDING_PREVIEW
  ? ONBOARDING_PREVIEW_DIR_NAME
  : RUNTIME_CONFIG_DIR_NAME
const RUNTIME_CONFIG_INDEX_FILE = 'index.json'
const RUNTIME_CONFIG_TRANSACTION_FILE = '.runtime-config-transaction.json'
const RUNTIME_CONFIG_STAGE_PREFIX = '.runtime-config-stage-'
const PACKAGED_ENV_FILE = '.env.prod'
const MAX_PROFILE_FILE_ATTEMPTS = 1000

function defaultAppDataDirectoryPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming')
  }
  return path.join(os.homedir(), '.config')
}

function defaultUserDataDirectoryPath(): string {
  try {
    return path.join(app.getPath('appData'), DEFAULT_APP_NAME)
  } catch {
    return path.join(defaultAppDataDirectoryPath(), DEFAULT_APP_NAME)
  }
}

function hasExplicitUserDataDirectory(): boolean {
  return process.argv.some(
    argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir=')
  )
}

try {
  app?.setName?.(DEFAULT_APP_NAME)
  // Respect Electron's explicit user-data-dir switch. QA/E2E launches use an
  // isolated profile so local settings and sessions cannot leak from the
  // developer's normal Evenfire profile into a functional journey.
  if (!hasExplicitUserDataDirectory()) {
    app?.setPath?.('userData', defaultUserDataDirectoryPath())
  }
} catch {
  // Electron can be mocked in unit tests before the real app object is ready.
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function readEnvFile(filePath: string): void {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const assignment = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const separatorIndex = assignment.indexOf('=')
    if (separatorIndex <= 0) continue
    const key = assignment.slice(0, separatorIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (process.env[key]?.trim()) continue
    process.env[key] = parseEnvValue(assignment.slice(separatorIndex + 1))
  }
}

function loadPackagedEnv(): void {
  if (!app?.isPackaged) return
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, PACKAGED_ENV_FILE)] : []),
    path.join(__dirname, '..', PACKAGED_ENV_FILE),
  ]
  for (const candidate of candidates) {
    readEnvFile(candidate)
  }
}

loadPackagedEnv()

function explicitRuntimeConfigPath(): string {
  if (app?.isPackaged) return ''
  // The onboarding preview owns its own directory; an explicit config file
  // would hand it a configured environment and defeat the point.
  if (ONBOARDING_PREVIEW) return ''
  return process.env.CLERUM_DESKTOP_CONFIG_PATH?.trim() || ''
}

function requiredOrDefault(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value || fallback
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

function isLoopbackHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname)
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
}

function isPrivateIpLiteral(hostname: string): boolean {
  const host = normalizedHostname(hostname)
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (isIP(host) !== 6) return false
  const mappedIpv4 = host.match(/^::ffff:(.+)$/i)?.[1]
  if (mappedIpv4 && isIP(mappedIpv4) === 4) return isPrivateIpLiteral(mappedIpv4)
  if (mappedIpv4 && /^[0-9a-f:]+$/i.test(mappedIpv4)) {
    const groups = mappedIpv4.split(':').filter(Boolean)
    const low = Number.parseInt(groups.at(-1) || '0', 16)
    const high = Number.parseInt(groups.at(-2) || '0', 16)
    const mappedDotted = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
    if (isIP(mappedDotted) === 4) return isPrivateIpLiteral(mappedDotted)
  }
  return host === '::' || /^f[cd]/i.test(host) || /^fe[89a-f]/i.test(host)
}

export function validateProfileUiOrigin(rawValue: unknown, restEndpoint: string): string {
  if (typeof rawValue !== 'string') throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
  const raw = rawValue.trim()
  if (!raw || raw !== rawValue || /[\u0000-\u0020\u007f]/.test(raw)) {
    throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
  }
  let profileUrl: URL
  let restUrl: URL
  try {
    profileUrl = new URL(raw)
    restUrl = new URL(canonicalizeDesktopRestEndpoint(restEndpoint))
  } catch {
    throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
  }
  if (
    !/^https?:\/\//i.test(raw) ||
    !['http:', 'https:'].includes(profileUrl.protocol) ||
    profileUrl.username ||
    profileUrl.password ||
    !['', '/'].includes(profileUrl.pathname) ||
    profileUrl.search ||
    profileUrl.hash
  ) {
    throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
  }
  const profileLoopback = isLoopbackHostname(profileUrl.hostname)
  const restLoopback = isLoopbackHostname(restUrl.hostname)
  if (profileLoopback && !restLoopback) throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
  if (profileUrl.protocol !== 'https:' && !(profileLoopback && restLoopback)) {
    throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
  }
  if (!profileLoopback && isPrivateIpLiteral(profileUrl.hostname)) {
    throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
  }
  return profileUrl.origin
}

function deriveProfileUiBaseUrl(_externalRestApiBaseUrl: string): string {
  return process.env.PROFILE_UI_BASE_URL?.trim() || ''
}

function sameProfileUiPairingRestEndpoint(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(canonicalizeDesktopRestEndpoint(left))
    const rightUrl = new URL(canonicalizeDesktopRestEndpoint(right))
    const hostsMatch =
      leftUrl.hostname === rightUrl.hostname ||
      (isLoopbackHostname(leftUrl.hostname) && isLoopbackHostname(rightUrl.hostname))

    return (
      hostsMatch &&
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.port === rightUrl.port &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search
    )
  } catch {
    return false
  }
}

/** Resolve the Profile origin paired with the currently active Desktop deployment. */
export function getActiveDeploymentProfileUiBaseUrl(): string {
  assertRuntimeConfigAvailable()
  const externalRestApiBaseUrl = config.externalRestApiBaseUrl
  const explicitPairMatches =
    config.desktopProfileUiBaseUrlExplicit &&
    configuredProfileUiRestBaseUrl &&
    sameProfileUiPairingRestEndpoint(externalRestApiBaseUrl, configuredProfileUiRestBaseUrl)

  if (explicitPairMatches) {
    try {
      return validateProfileUiOrigin(config.desktopProfileUiBaseUrl, externalRestApiBaseUrl)
    } catch {
      throw new Error('operator_profile_ui_origin_invalid')
    }
  }
  const profileUiBaseUrl = currentRuntimeConfig().profileUiBaseUrl
  if (typeof profileUiBaseUrl === 'string') {
    try {
      return validateProfileUiOrigin(profileUiBaseUrl, externalRestApiBaseUrl)
    } catch {
      throw new Error('saved_profile_origin_invalid')
    }
  }
  if (Object.prototype.hasOwnProperty.call(currentRuntimeConfig(), 'profileUiBaseUrl')) {
    throw new Error('saved_profile_origin_invalid')
  }
  throw new Error('profile_ui_origin_missing')
}

function hasExplicitProfileUiBaseUrl(): boolean {
  return Boolean(process.env.PROFILE_UI_BASE_URL?.trim())
}

const configuredProfileUiRestBaseUrl = process.env.EXTERNAL_REST_API_BASE_URL?.trim() || null

function runtimeConfigDirectoryPath(): string {
  const explicit = explicitRuntimeConfigPath()
  if (explicit) return path.dirname(explicit)

  if (app?.isReady()) {
    return path.join(app.getPath('userData'), activeRuntimeConfigDirName)
  }

  // Keep a deterministic fallback before Electron is ready.
  return path.join(defaultUserDataDirectoryPath(), activeRuntimeConfigDirName)
}

function runtimeConfigIndexPath(): string {
  return path.join(runtimeConfigDirectoryPath(), RUNTIME_CONFIG_INDEX_FILE)
}

function toOptionalTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function normalizeRuntimeConfig(
  value: Partial<DesktopRuntimeConfig> | null | undefined
): DesktopRuntimeConfig | null {
  if (!value) return null
  const externalRestApiBaseUrl = toOptionalTrimmed(value.externalRestApiBaseUrl)
  const rpcProxyBaseUrl = toOptionalTrimmed(value.rpcProxyBaseUrl) || ''
  if (!externalRestApiBaseUrl) {
    return null
  }
  return {
    externalRestApiBaseUrl,
    rpcProxyBaseUrl,
    appName: toOptionalTrimmed(value.appName) || DEFAULT_APP_NAME,
    ...(Object.prototype.hasOwnProperty.call(value, 'profileUiBaseUrl')
      ? {
          // Keep malformed persisted data distinct from a legacy absent key.
          profileUiBaseUrl:
            typeof value.profileUiBaseUrl === 'string' ? value.profileUiBaseUrl : null,
        }
      : {}),
  }
}

function readRuntimeConfigFileSync(filePath: string): DesktopRuntimeConfig | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DesktopRuntimeConfig>
    return normalizeRuntimeConfig(parsed)
  } catch {
    return null
  }
}

type RuntimeConfigFileTransaction = {
  version: 1
  writes: Array<{ filePath: string; contents: string }>
  deletes: string[]
}

let configMutationRecoveryRequired = false
let runtimeConfigMutationAdmissionOpen = true
let configMutationQueue: Promise<void> = Promise.resolve()

function writeFileAtomicSync(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, contents, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch {
      // Preserve the original write error.
    }
    throw error
  }
}

function allowedTransactionTarget(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  const explicit = explicitRuntimeConfigPath()
  return (
    resolved === path.resolve(runtimeConfigDirectoryPath()) ||
    path.dirname(resolved) === path.resolve(runtimeConfigDirectoryPath()) ||
    (Boolean(explicit) && resolved === path.resolve(explicit))
  )
}

function applyFileTransactionSync(transaction: RuntimeConfigFileTransaction): void {
  if (
    transaction.version !== 1 ||
    !Array.isArray(transaction.writes) ||
    !Array.isArray(transaction.deletes)
  ) {
    throw new Error('runtime_config_transaction_invalid')
  }
  for (const write of transaction.writes) {
    if (!allowedTransactionTarget(write.filePath) || typeof write.contents !== 'string') {
      throw new Error('runtime_config_transaction_invalid')
    }
    writeFileAtomicSync(write.filePath, write.contents)
  }
  for (const filePath of transaction.deletes) {
    if (!allowedTransactionTarget(filePath)) throw new Error('runtime_config_transaction_invalid')
    fs.rmSync(filePath, { force: true })
  }
}

function recoverRuntimeConfigTransactionSync(): void {
  const journalPath = path.join(runtimeConfigDirectoryPath(), RUNTIME_CONFIG_TRANSACTION_FILE)
  if (fs.existsSync(journalPath)) {
    try {
      const transaction = JSON.parse(
        fs.readFileSync(journalPath, 'utf8')
      ) as RuntimeConfigFileTransaction
      applyFileTransactionSync(transaction)
      fs.rmSync(journalPath)
      configMutationRecoveryRequired = false
    } catch {
      configMutationRecoveryRequired = true
      throw new Error('runtime_config_recovery_required')
    }
  } else {
    configMutationRecoveryRequired = false
  }
  try {
    for (const entry of fs.readdirSync(runtimeConfigDirectoryPath())) {
      if (/^\.runtime-config-stage-[0-9a-f-]+\.json$/i.test(entry)) {
        fs.rmSync(path.join(runtimeConfigDirectoryPath(), entry), {
          force: true,
        })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function assertRuntimeConfigAvailable(): void {
  if (!runtimeConfigMutationAdmissionOpen) throw new Error('desktop_shutting_down')
  if (configMutationRecoveryRequired) throw new Error('runtime_config_recovery_required')
}

export function closeDesktopRuntimeConfigMutationAdmission(): void {
  runtimeConfigMutationAdmissionOpen = false
}

function installFileTransactionSync(transaction: RuntimeConfigFileTransaction): void {
  assertRuntimeConfigAvailable()
  const journalPath = path.join(runtimeConfigDirectoryPath(), RUNTIME_CONFIG_TRANSACTION_FILE)
  writeFileAtomicSync(journalPath, JSON.stringify(transaction))
  try {
    applyFileTransactionSync(transaction)
    fs.rmSync(journalPath)
  } catch {
    configMutationRecoveryRequired = true
    throw new Error('runtime_config_commit_pending_recovery')
  }
}

function withRuntimeConfigCommit<T>(operation: () => T): Promise<T> {
  const result = configMutationQueue.then(operation, operation)
  configMutationQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function readRuntimeConfigIndexSync(): RuntimeConfigIndex {
  try {
    const filePath = runtimeConfigIndexPath()
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RuntimeConfigIndex>
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : []
    const normalizedProfiles: RuntimeConfigIndexEntry[] = profiles
      .map(profile => {
        const id = toOptionalTrimmed(profile?.id)
        const appName = toOptionalTrimmed(profile?.appName)
        const fileName = toOptionalTrimmed(profile?.fileName)
        const createdAt = toOptionalTrimmed(profile?.createdAt)
        const updatedAt = toOptionalTrimmed(profile?.updatedAt)
        if (!id || !appName || !fileName || !createdAt || !updatedAt) return null
        return { id, appName, fileName, createdAt, updatedAt }
      })
      .filter((profile): profile is RuntimeConfigIndexEntry => profile !== null)
    return {
      version: 1,
      activeProfileId: toOptionalTrimmed(parsed.activeProfileId) || null,
      profiles: normalizedProfiles,
    }
  } catch {
    return { version: 1, activeProfileId: null, profiles: [] }
  }
}

function toAppSlug(appName: string): string {
  const normalized = appName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'app'
}

function displayHost(value: string): string {
  try {
    const parsed = new URL(value)
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    return value
  }
}

function loadStoredProfilesSync(): {
  profiles: StoredRuntimeProfile[]
  activeProfileId: string | null
} {
  // The onboarding preview starts cold on EVERY launch. Selecting Localhost or
  // saving an environment writes to the preview directory, which would leave
  // the next launch configured — the switch would show onboarding once and
  // then silently stop, which is exactly the confusion it exists to prevent.
  // Reads are dropped rather than the directory deleted: writes still work, so
  // the wizard can be completed and used for the rest of the session.
  if (ONBOARDING_PREVIEW) return { profiles: [], activeProfileId: null }

  const explicitPath = explicitRuntimeConfigPath()
  if (explicitPath) {
    const configFromFile = readRuntimeConfigFileSync(explicitPath)
    if (!configFromFile) return { profiles: [], activeProfileId: null }
    return {
      profiles: [
        {
          id: 'custom-file',
          appName: configFromFile.appName?.trim() || DEFAULT_APP_NAME,
          filePath: explicitPath,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          config: configFromFile,
        },
      ],
      activeProfileId: 'custom-file',
    }
  }

  const index = readRuntimeConfigIndexSync()
  const directoryPath = runtimeConfigDirectoryPath()
  const loadedProfiles: StoredRuntimeProfile[] = []
  for (const profileEntry of index.profiles) {
    const filePath = path.join(directoryPath, profileEntry.fileName)
    const configFromFile = readRuntimeConfigFileSync(filePath)
    if (!configFromFile) continue
    loadedProfiles.push({
      id: profileEntry.id,
      appName: profileEntry.appName,
      filePath,
      createdAt: profileEntry.createdAt,
      updatedAt: profileEntry.updatedAt,
      config: configFromFile,
    })
  }

  if (loadedProfiles.length > 0) {
    const hasActive = loadedProfiles.some(profile => profile.id === index.activeProfileId)
    if (index.activeProfileId === LOCALHOST_OPTION_ID) {
      return {
        profiles: loadedProfiles,
        activeProfileId: LOCALHOST_OPTION_ID,
      }
    }
    return {
      profiles: loadedProfiles,
      activeProfileId: hasActive
        ? index.activeProfileId
        : loadedProfiles[loadedProfiles.length - 1]?.id || null,
    }
  }

  return {
    profiles: [],
    activeProfileId: index.activeProfileId === LOCALHOST_OPTION_ID ? LOCALHOST_OPTION_ID : null,
  }
}

function configsMatch(a: DesktopRuntimeConfig, b: DesktopRuntimeConfig): boolean {
  return (
    runtimeEndpointsMatch(a, b) &&
    (a.appName?.trim() || DEFAULT_APP_NAME) === (b.appName?.trim() || DEFAULT_APP_NAME)
  )
}

function runtimeEndpointsMatch(a: DesktopRuntimeConfig, b: DesktopRuntimeConfig): boolean {
  return (
    sameDesktopRestEndpoint(a.externalRestApiBaseUrl, b.externalRestApiBaseUrl) &&
    a.rpcProxyBaseUrl === b.rpcProxyBaseUrl
  )
}

function isLocalhostUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.trim().toLowerCase()
    return host === 'localhost' || host === '127.0.0.1'
  } catch {
    return false
  }
}

function isLocalhostRuntimeConfig(value: DesktopRuntimeConfig): boolean {
  return isLocalhostUrl(value.externalRestApiBaseUrl) && isLocalhostUrl(value.rpcProxyBaseUrl || '')
}

function isRuntimeConfigSelectorVisible(): boolean {
  return true
}

function buildRuntimeConfigOptions(
  profiles: StoredRuntimeProfile[],
  localhostConfig: DesktopRuntimeConfig,
  includeLocalhostOption: boolean
): DesktopRuntimeConfigOption[] {
  const options: DesktopRuntimeConfigOption[] = profiles.map(profile => ({
    id: profile.id,
    label: `${profile.appName} (${displayHost(profile.config.externalRestApiBaseUrl)})`,
    source: 'file',
    configPath: profile.filePath,
    externalRestApiBaseUrl: profile.config.externalRestApiBaseUrl,
    rpcProxyBaseUrl: profile.config.rpcProxyBaseUrl || '',
    appName: profile.config.appName?.trim() || DEFAULT_APP_NAME,
  }))

  if (includeLocalhostOption) {
    options.push({
      id: LOCALHOST_OPTION_ID,
      label: 'Localhost',
      source: 'localhost',
      configPath: null,
      externalRestApiBaseUrl: localhostConfig.externalRestApiBaseUrl,
      rpcProxyBaseUrl: localhostConfig.rpcProxyBaseUrl || '',
      appName: localhostConfig.appName?.trim() || DEFAULT_APP_NAME,
    })
  }

  return options
}

function nextProfileFilePath(directoryPath: string, appName: string): string {
  const slug = toAppSlug(appName)
  for (let index = 0; index < MAX_PROFILE_FILE_ATTEMPTS; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const candidate = path.join(directoryPath, `runtime-config-${slug}${suffix}.json`)
    if (!fs.existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(`could not allocate runtime config file after ${MAX_PROFILE_FILE_ATTEMPTS} tries`)
}

function resolveActiveProfile(
  profiles: StoredRuntimeProfile[],
  activeProfileId: string | null
): StoredRuntimeProfile | null {
  if (activeProfileId === LOCALHOST_OPTION_ID) return null
  if (activeProfileId) {
    const direct = profiles.find(profile => profile.id === activeProfileId)
    if (direct) return direct
  }
  if (!profiles.length) return null
  return profiles[profiles.length - 1] || null
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function validateRpcProxyBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !isHttpUrl(value.trim())) {
    throw new Error('rpcProxyBaseUrl must be a valid http(s) URL')
  }
  return value.trim()
}

function validateRuntimeConfig(next: DesktopRuntimeConfig): DesktopRuntimeConfig {
  const normalized = {
    externalRestApiBaseUrl: next.externalRestApiBaseUrl.trim(),
    rpcProxyBaseUrl: (next.rpcProxyBaseUrl || '').trim(),
    appName: next.appName?.trim() || DEFAULT_APP_NAME,
    ...(Object.prototype.hasOwnProperty.call(next, 'profileUiBaseUrl')
      ? { profileUiBaseUrl: next.profileUiBaseUrl }
      : {}),
  }

  if (!isHttpUrl(normalized.externalRestApiBaseUrl)) {
    throw new Error('externalRestApiBaseUrl must be a valid http(s) URL')
  }
  if (normalized.rpcProxyBaseUrl) {
    normalized.rpcProxyBaseUrl = validateRpcProxyBaseUrl(normalized.rpcProxyBaseUrl)
  }
  return normalized
}

const localhostRuntimeConfig = validateRuntimeConfig({
  externalRestApiBaseUrl: LOCALHOST_EXTERNAL_REST_API_BASE_URL,
  rpcProxyBaseUrl: LOCALHOST_RPC_PROXY_BASE_URL,
  appName: DEFAULT_APP_NAME,
})
const envRuntimeConfig = validateRuntimeConfig({
  externalRestApiBaseUrl: requiredOrDefault(
    'EXTERNAL_REST_API_BASE_URL',
    LOCALHOST_EXTERNAL_REST_API_BASE_URL
  ),
  rpcProxyBaseUrl: requiredOrDefault('RPC_PROXY_BASE_URL', LOCALHOST_RPC_PROXY_BASE_URL),
  appName: requiredOrDefault('DESKTOP_APP_NAME', DEFAULT_APP_NAME),
})
const desktopDevPackageRuntimeConfigEnabled =
  process.argv.includes('--evenfire-desktop-dev-package') &&
  runtimeEndpointsMatch(envRuntimeConfig, localhostRuntimeConfig)
const canUseEnvRuntimeConfig = !app?.isPackaged || desktopDevPackageRuntimeConfigEnabled
const envRuntimeConfigured = Boolean(
  // `make local-app` exports both of these, which would mark the app
  // configured and skip the wizard the preview exists to show.
  !ONBOARDING_PREVIEW &&
  canUseEnvRuntimeConfig &&
  process.env.EXTERNAL_REST_API_BASE_URL?.trim() &&
  process.env.RPC_PROXY_BASE_URL?.trim()
)
const envMatchesLocalhostOption = runtimeEndpointsMatch(envRuntimeConfig, localhostRuntimeConfig)

function shouldPreferLocalhostByDefault(): boolean {
  const explicitDevelopmentLaunch = app?.isPackaged
    ? desktopDevPackageRuntimeConfigEnabled
    : Boolean(process.env.EVENFIRE_RENDERER_URL?.trim())
  return explicitDevelopmentLaunch && envRuntimeConfigured && envMatchesLocalhostOption
}
try {
  recoverRuntimeConfigTransactionSync()
} catch {
  // A pending journal fences mutation and origin readers until recovery succeeds.
}
const loadedProfilesState = loadStoredProfilesSync()
let storedProfiles = loadedProfilesState.profiles
let profileIncarnations = new Map(
  storedProfiles.map(profile => [profile.id, randomUUID()] as const)
)
const preferLocalhostRuntimeByDefault = shouldPreferLocalhostByDefault()
let activeRuntimeOptionId = preferLocalhostRuntimeByDefault
  ? LOCALHOST_OPTION_ID
  : loadedProfilesState.activeProfileId
const activeStoredProfile = preferLocalhostRuntimeByDefault
  ? null
  : resolveActiveProfile(storedProfiles, activeRuntimeOptionId)
if (
  !preferLocalhostRuntimeByDefault &&
  !activeStoredProfile &&
  activeRuntimeOptionId !== LOCALHOST_OPTION_ID &&
  envRuntimeConfigured &&
  envMatchesLocalhostOption
) {
  activeRuntimeOptionId = LOCALHOST_OPTION_ID
}
let desktopRuntimeConfigured = Boolean(
  activeStoredProfile || envRuntimeConfigured || activeRuntimeOptionId === LOCALHOST_OPTION_ID
)

/**
 * Diagnostic for "why did the app open on this screen?".
 *
 * `configured` decides sign-in vs. the first-run onboarding wizard, and it is
 * resolved twice: once at module load, then again by
 * `hydrateDesktopRuntimeConfig` once Electron is ready. Only the second value
 * reaches the renderer, so this is logged from there — logging the module-load
 * value instead reports a screen the user never sees. No URLs, tokens or paths
 * beyond the config directory name; nothing secret.
 */
function logRuntimeConfigResolution(): void {
  if (process.env.VITEST) return
  console.log(
    '[evenfire] runtime config:',
    JSON.stringify({
      configured: desktopRuntimeConfigured,
      screen: desktopRuntimeConfigured ? 'sign-in' : 'onboarding',
      onboardingPreview: ONBOARDING_PREVIEW,
      onboardingPreviewRaw: process.env.EVENFIRE_ONBOARDING_PREVIEW ?? '(unset)',
      activeOptionId: activeRuntimeOptionId,
      configDir: activeRuntimeConfigDirName,
      isPackaged: Boolean(app?.isPackaged),
      devPackageLaunch: desktopDevPackageRuntimeConfigEnabled,
    })
  )
}

const initialRuntimeConfig =
  activeRuntimeOptionId === LOCALHOST_OPTION_ID
    ? localhostRuntimeConfig
    : activeStoredProfile?.config || envRuntimeConfig

export const config: DesktopConfig = {
  externalRestApiBaseUrl: initialRuntimeConfig.externalRestApiBaseUrl,
  rpcProxyBaseUrl: initialRuntimeConfig.rpcProxyBaseUrl || '',
  memberRegistrationServiceBaseUrl: requiredOrDefault(
    'MEMBER_REGISTRATION_SERVICE_BASE_URL',
    'https://registration.evenfire.ai'
  ),
  desktopProfileUiBaseUrl: deriveProfileUiBaseUrl(initialRuntimeConfig.externalRestApiBaseUrl),
  desktopProfileUiBaseUrlExplicit: hasExplicitProfileUiBaseUrl(),
  deploymentDocsUrl: canUseEnvRuntimeConfig
    ? requiredOrDefault('DEPLOYMENT_DOCS_URL', DEFAULT_DEPLOYMENT_DOCS_URL)
    : DEFAULT_DEPLOYMENT_DOCS_URL,
  hostedSignupUrl: canUseEnvRuntimeConfig
    ? requiredOrDefault('HOSTED_SIGNUP_URL', DEFAULT_HOSTED_SIGNUP_URL)
    : DEFAULT_HOSTED_SIGNUP_URL,
  requestTimeoutMs: Number(requiredOrDefault('REQUEST_TIMEOUT_MS', '60000')),
  // Generous deadline for legacy JSON GFS uploads: a 16 MiB file is a ~22.4 MiB
  // base64 body, ~60s alone on a slow uplink. v2 streams binary indexed parts and
  // has its own per-part/finalization deadlines.
  // Keep legacy parity with control-ui GFS_UPLOAD_TIMEOUT_MS while each v2 part
  // remains bounded by the upload protocol timeout.
  gfsUploadTimeoutMs: Number(requiredOrDefault('GFS_UPLOAD_TIMEOUT_MS', '300000')),
  appName: initialRuntimeConfig.appName?.trim() || DEFAULT_APP_NAME,
}

function applyRuntimeConfig(next: DesktopRuntimeConfig, markConfigured: boolean): void {
  config.externalRestApiBaseUrl = next.externalRestApiBaseUrl
  config.rpcProxyBaseUrl = next.rpcProxyBaseUrl || ''
  config.appName = next.appName?.trim() || DEFAULT_APP_NAME
  config.desktopProfileUiBaseUrl = deriveProfileUiBaseUrl(next.externalRestApiBaseUrl)
  config.desktopProfileUiBaseUrlExplicit = hasExplicitProfileUiBaseUrl()
  if (markConfigured) desktopRuntimeConfigured = true
}

function currentRuntimeConfig(): DesktopRuntimeConfig {
  const profile = storedProfiles.find(candidate => candidate.id === activeRuntimeOptionId)
  return {
    externalRestApiBaseUrl: config.externalRestApiBaseUrl,
    rpcProxyBaseUrl: config.rpcProxyBaseUrl,
    appName: config.appName,
    ...(profile && Object.prototype.hasOwnProperty.call(profile.config, 'profileUiBaseUrl')
      ? { profileUiBaseUrl: profile.config.profileUiBaseUrl }
      : {}),
  }
}

let runtimeConfigHydrated = false

export function hydrateDesktopRuntimeConfig(): void {
  // Config is imported before Electron is ready. Re-load profiles once the app is ready so
  // dev builds can see packaged configs under userData, and dev env vars can override.
  if (runtimeConfigHydrated) return
  if (!app?.isReady()) return
  recoverRuntimeConfigTransactionSync()
  runtimeConfigHydrated = true
  resolveHydratedRuntimeConfig()
  logRuntimeConfigResolution()
}

function resolveHydratedRuntimeConfig(): void {
  const loaded = loadStoredProfilesSync()
  storedProfiles = loaded.profiles
  profileIncarnations = new Map(storedProfiles.map(profile => [profile.id, randomUUID()] as const))
  const preserveLocalhostRuntime =
    // The onboarding preview must not be pulled back onto the Localhost
    // option here. `make local-app` satisfies every condition below — it
    // passes --evenfire-desktop-dev-package and points the env endpoints at
    // 127.0.0.1 — which would re-mark the app configured after boot and land
    // the developer on sign-in, the exact screen the preview exists to bypass.
    !ONBOARDING_PREVIEW &&
    (preferLocalhostRuntimeByDefault ||
      (desktopDevPackageRuntimeConfigEnabled &&
        envMatchesLocalhostOption &&
        isLocalhostRuntimeConfig(currentRuntimeConfig())))
  activeRuntimeOptionId = preserveLocalhostRuntime ? LOCALHOST_OPTION_ID : loaded.activeProfileId

  const selectedProfile = resolveActiveProfile(storedProfiles, activeRuntimeOptionId)
  if (selectedProfile) {
    activeRuntimeOptionId = selectedProfile.id
    applyRuntimeConfig(selectedProfile.config, true)
    return
  }

  if (
    activeRuntimeOptionId === LOCALHOST_OPTION_ID &&
    isLocalhostRuntimeConfig(localhostRuntimeConfig)
  ) {
    applyRuntimeConfig(localhostRuntimeConfig, true)
    return
  }

  if (envRuntimeConfigured) {
    activeRuntimeOptionId = envMatchesLocalhostOption ? LOCALHOST_OPTION_ID : null
    applyRuntimeConfig(envRuntimeConfig, true)
    return
  }

  if (shouldPreferLocalhostByDefault()) {
    activeRuntimeOptionId = LOCALHOST_OPTION_ID
    desktopRuntimeConfigured = true
    applyRuntimeConfig(localhostRuntimeConfig, true)
    return
  }

  activeRuntimeOptionId = null
  desktopRuntimeConfigured = false
  applyRuntimeConfig(envRuntimeConfig, false)
}

export function isDesktopRuntimeConfigured(): boolean {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  return desktopRuntimeConfigured
}

export type PreparedRuntimeConfigSave = {
  id: string
  profileId: string
  created: boolean
}

type PreparedRuntimeConfigMutation = {
  checkIndexRevision: boolean
  expectedIndexRevision: string | null
  expectedFileRevisions: Array<{ filePath: string; revision: string | null }>
  transaction: RuntimeConfigFileTransaction
  profilesAfter: StoredRuntimeProfile[]
  activeProfileAfter: string | null
  configAfter?: DesktopRuntimeConfig
  rotateIncarnations: string[]
  removeIncarnations: string[]
  activate: boolean
  markConfigured: boolean
  expectedProfiles: Array<RuntimeConfigProfileIdentity>
  applyConfigIfActive: boolean
  mergeProfileOriginPaths: string[]
  stagePath?: string
  stagePromise?: Promise<void>
  stageComplete?: boolean
}

const preparedRuntimeConfigMutations = new Map<string, PreparedRuntimeConfigMutation>()

function fileRevision(filePath: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function serializeRuntimeConfigIndex(
  profiles: StoredRuntimeProfile[],
  activeProfileId: string | null
): string {
  const directoryPath = runtimeConfigDirectoryPath()
  const index: RuntimeConfigIndex = {
    version: 1,
    activeProfileId,
    profiles: profiles
      .filter(profile => path.dirname(profile.filePath) === directoryPath)
      .map(profile => ({
        id: profile.id,
        appName: profile.appName,
        fileName: path.basename(profile.filePath),
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })),
  }
  return JSON.stringify(index, null, 2)
}

function prepareRuntimeConfigSave(next: DesktopRuntimeConfig): {
  ticket: PreparedRuntimeConfigSave
  mutation: PreparedRuntimeConfigMutation
} {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  const validated = validateRuntimeConfig(next)
  validated.externalRestApiBaseUrl = canonicalizeDesktopRestEndpoint(
    validated.externalRestApiBaseUrl
  )
  const timestamp = new Date().toISOString()
  const explicitPath = explicitRuntimeConfigPath()
  const existing = explicitPath
    ? storedProfiles.find(profile => profile.id === 'custom-file')
    : storedProfiles.find(profile =>
        sameDesktopRestEndpoint(
          profile.config.externalRestApiBaseUrl,
          validated.externalRestApiBaseUrl
        )
      )
  const sameRest = Boolean(
    existing &&
    sameDesktopRestEndpoint(
      existing.config.externalRestApiBaseUrl,
      validated.externalRestApiBaseUrl
    )
  )
  const configAfter: DesktopRuntimeConfig = {
    externalRestApiBaseUrl: validated.externalRestApiBaseUrl,
    rpcProxyBaseUrl: validated.rpcProxyBaseUrl || '',
    appName: validated.appName?.trim() || DEFAULT_APP_NAME,
    ...(sameRest &&
    existing &&
    Object.prototype.hasOwnProperty.call(existing.config, 'profileUiBaseUrl')
      ? { profileUiBaseUrl: existing.config.profileUiBaseUrl }
      : {}),
  }
  let profileAfter: StoredRuntimeProfile
  let profilesAfter: StoredRuntimeProfile[]
  let targetPath: string
  let expectedProfile: { filePath: string; revision: string | null } | null = null
  let rotateIncarnations: string[] = []
  if (explicitPath) {
    targetPath = explicitPath
    expectedProfile = {
      filePath: targetPath,
      revision: fileRevision(targetPath),
    }
    profileAfter = {
      id: 'custom-file',
      appName: configAfter.appName || DEFAULT_APP_NAME,
      filePath: explicitPath,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      config: configAfter,
    }
    profilesAfter = [profileAfter]
    if (!sameRest) rotateIncarnations = ['custom-file']
  } else if (existing) {
    targetPath = existing.filePath
    expectedProfile = {
      filePath: targetPath,
      revision: fileRevision(targetPath),
    }
    profileAfter = {
      ...existing,
      appName: configAfter.appName || DEFAULT_APP_NAME,
      updatedAt: timestamp,
      config: configAfter,
    }
    profilesAfter = storedProfiles.map(profile =>
      profile.id === existing.id ? profileAfter : profile
    )
  } else {
    const directoryPath = runtimeConfigDirectoryPath()
    targetPath = nextProfileFilePath(directoryPath, configAfter.appName || DEFAULT_APP_NAME)
    expectedProfile = { filePath: targetPath, revision: null }
    profileAfter = {
      id: `${toAppSlug(configAfter.appName || DEFAULT_APP_NAME)}-${randomUUID()}`,
      appName: configAfter.appName || DEFAULT_APP_NAME,
      filePath: targetPath,
      createdAt: timestamp,
      updatedAt: timestamp,
      config: configAfter,
    }
    profilesAfter = [...storedProfiles, profileAfter]
    rotateIncarnations = [profileAfter.id]
  }
  const activeProfileAfter = profileAfter.id
  const writes = [{ filePath: targetPath, contents: JSON.stringify(configAfter, null, 2) }]
  if (!explicitPath) {
    writes.push({
      filePath: runtimeConfigIndexPath(),
      contents: serializeRuntimeConfigIndex(profilesAfter, activeProfileAfter),
    })
  }
  const ticket = {
    id: randomUUID(),
    profileId: profileAfter.id,
    created: !existing || Boolean(existing && !sameRest),
  }
  const mutation: PreparedRuntimeConfigMutation = {
    checkIndexRevision: !explicitPath,
    expectedIndexRevision: explicitPath ? null : fileRevision(runtimeConfigIndexPath()),
    expectedFileRevisions: expectedProfile ? [expectedProfile] : [],
    transaction: { version: 1, writes, deletes: [] },
    profilesAfter,
    activeProfileAfter,
    configAfter,
    rotateIncarnations,
    removeIncarnations: [],
    activate: true,
    markConfigured: true,
    applyConfigIfActive: false,
    expectedProfiles: existing
      ? [
          {
            profileId: existing.id,
            incarnation: profileIncarnations.get(existing.id) || '',
            externalRestApiBaseUrl: canonicalizeDesktopRestEndpoint(
              existing.config.externalRestApiBaseUrl
            ),
          },
        ]
      : [],
    mergeProfileOriginPaths: existing && sameRest ? [targetPath] : [],
  }
  return { ticket, mutation }
}

export function prepareDesktopRuntimeConfigSave(
  next: DesktopRuntimeConfig
): PreparedRuntimeConfigSave {
  const { ticket, mutation } = prepareRuntimeConfigSave(next)
  preparedRuntimeConfigMutations.set(ticket.id, mutation)
  return ticket
}

function prepareIndexMutation(input: {
  profilesAfter: StoredRuntimeProfile[]
  activeProfileAfter: string | null
  configAfter?: DesktopRuntimeConfig
  markConfigured?: boolean
  deletes?: string[]
  expectedFiles?: Array<{ filePath: string; revision: string | null }>
  expectedProfiles?: RuntimeConfigProfileIdentity[]
  removeIncarnations?: string[]
  activate?: boolean
}): PreparedRuntimeConfigSave {
  const explicitPath = Boolean(explicitRuntimeConfigPath())
  const writes = explicitPath
    ? []
    : [
        {
          filePath: runtimeConfigIndexPath(),
          contents: serializeRuntimeConfigIndex(input.profilesAfter, input.activeProfileAfter),
        },
      ]
  const ticket = {
    id: randomUUID(),
    profileId: input.activeProfileAfter || '',
    created: false,
  }
  preparedRuntimeConfigMutations.set(ticket.id, {
    checkIndexRevision: !explicitPath,
    expectedIndexRevision: explicitPath ? null : fileRevision(runtimeConfigIndexPath()),
    expectedFileRevisions: input.expectedFiles || [],
    transaction: { version: 1, writes, deletes: input.deletes || [] },
    profilesAfter: input.profilesAfter,
    activeProfileAfter: input.activeProfileAfter,
    ...(input.configAfter ? { configAfter: input.configAfter } : {}),
    rotateIncarnations: [],
    removeIncarnations: input.removeIncarnations || [],
    activate: input.activate ?? true,
    markConfigured: input.markConfigured ?? true,
    expectedProfiles: input.expectedProfiles || [],
    applyConfigIfActive: false,
    mergeProfileOriginPaths: [],
  })
  return ticket
}

export function prepareRuntimeProfileRpcProjection(
  identity: RuntimeConfigProfileIdentity,
  rpcProxyBaseUrl: string,
  appName: string
): PreparedRuntimeConfigSave {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  const profile = storedProfiles.find(candidate => candidate.id === identity.profileId)
  if (
    !profile ||
    profileIncarnations.get(identity.profileId) !== identity.incarnation ||
    !sameDesktopRestEndpoint(profile.config.externalRestApiBaseUrl, identity.externalRestApiBaseUrl)
  ) {
    throw new Error('stale_runtime_profile')
  }
  const normalizedRpcProxyBaseUrl = validateRpcProxyBaseUrl(rpcProxyBaseUrl)
  const nextConfig: DesktopRuntimeConfig = {
    ...profile.config,
    rpcProxyBaseUrl: normalizedRpcProxyBaseUrl,
    appName: appName.trim() || profile.appName,
  }
  const parsed = JSON.parse(fs.readFileSync(profile.filePath, 'utf8')) as Record<string, unknown>
  if (
    typeof parsed.externalRestApiBaseUrl !== 'string' ||
    !sameDesktopRestEndpoint(parsed.externalRestApiBaseUrl, identity.externalRestApiBaseUrl)
  ) {
    throw new Error('stale_runtime_profile')
  }
  const diskConfig = {
    ...parsed,
    rpcProxyBaseUrl: normalizedRpcProxyBaseUrl,
    appName: nextConfig.appName,
  }
  const profileAfter: StoredRuntimeProfile = {
    ...profile,
    appName: nextConfig.appName || profile.appName,
    config: nextConfig,
  }
  const ticket = { id: randomUUID(), profileId: profile.id, created: false }
  preparedRuntimeConfigMutations.set(ticket.id, {
    checkIndexRevision: false,
    expectedIndexRevision: null,
    expectedFileRevisions: [
      { filePath: profile.filePath, revision: fileRevision(profile.filePath) },
    ],
    transaction: {
      version: 1,
      writes: [
        {
          filePath: profile.filePath,
          contents: JSON.stringify(diskConfig, null, 2),
        },
      ],
      deletes: [],
    },
    profilesAfter: storedProfiles.map(candidate =>
      candidate.id === profile.id ? profileAfter : candidate
    ),
    activeProfileAfter: profile.id,
    configAfter: nextConfig,
    rotateIncarnations: [],
    removeIncarnations: [],
    activate: false,
    markConfigured: true,
    expectedProfiles: [identity],
    applyConfigIfActive: true,
    mergeProfileOriginPaths: [profile.filePath],
  })
  return ticket
}

export function prepareDesktopRuntimeConfigSelection(optionId: string): PreparedRuntimeConfigSave {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  const id = String(optionId || '').trim()
  if (!id) throw new Error('runtime configuration id is required')
  if (id === LOCALHOST_OPTION_ID) {
    return prepareIndexMutation({
      profilesAfter: storedProfiles,
      activeProfileAfter: LOCALHOST_OPTION_ID,
      configAfter: localhostRuntimeConfig,
    })
  }
  const selected = storedProfiles.find(profile => profile.id === id)
  if (!selected) throw new Error('runtime configuration not found')
  return prepareIndexMutation({
    profilesAfter: storedProfiles,
    activeProfileAfter: selected.id,
    configAfter: selected.config,
    expectedProfiles: [
      {
        profileId: selected.id,
        incarnation: profileIncarnations.get(selected.id) || '',
        externalRestApiBaseUrl: canonicalizeDesktopRestEndpoint(
          selected.config.externalRestApiBaseUrl
        ),
      },
    ],
  })
}

export function prepareClearDesktopRuntimeConfigSelection(): PreparedRuntimeConfigSave {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  return prepareIndexMutation({
    profilesAfter: storedProfiles,
    activeProfileAfter: null,
    configAfter: envRuntimeConfig,
    markConfigured: false,
    activate: true,
  })
}

export function prepareDeleteDesktopRuntimeConfigOption(
  optionId: string
): PreparedRuntimeConfigSave {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  const id = String(optionId || '').trim()
  if (!id) throw new Error('runtime configuration id is required')
  const selected = storedProfiles.find(profile => profile.id === id)
  if (!selected) throw new Error('runtime configuration not found')
  const profilesAfter = storedProfiles.filter(profile => profile.id !== id)
  let activeProfileAfter = activeRuntimeOptionId
  let configAfter: DesktopRuntimeConfig | undefined
  let markConfigured = true
  if (activeRuntimeOptionId === id) {
    const fallbackProfile = resolveActiveProfile(profilesAfter, null)
    if (fallbackProfile) {
      activeProfileAfter = fallbackProfile.id
      configAfter = fallbackProfile.config
    } else if (envRuntimeConfigured) {
      activeProfileAfter = envMatchesLocalhostOption ? LOCALHOST_OPTION_ID : null
      configAfter = envRuntimeConfig
    } else if (shouldPreferLocalhostByDefault()) {
      activeProfileAfter = LOCALHOST_OPTION_ID
      configAfter = localhostRuntimeConfig
    } else {
      activeProfileAfter = null
      configAfter = envRuntimeConfig
      markConfigured = false
    }
  }
  return prepareIndexMutation({
    profilesAfter,
    activeProfileAfter,
    ...(configAfter ? { configAfter } : {}),
    markConfigured,
    deletes: [selected.filePath],
    expectedFiles: [
      {
        filePath: selected.filePath,
        revision: fileRevision(selected.filePath),
      },
    ],
    expectedProfiles: [
      {
        profileId: selected.id,
        incarnation: profileIncarnations.get(selected.id) || '',
        externalRestApiBaseUrl: canonicalizeDesktopRestEndpoint(
          selected.config.externalRestApiBaseUrl
        ),
      },
    ],
    removeIncarnations: [selected.id],
  })
}

export async function commitPreparedDesktopRuntimeConfigMutation(
  ticket: PreparedRuntimeConfigSave
): Promise<void> {
  const mutation = preparedRuntimeConfigMutations.get(ticket.id)
  if (!mutation) throw new Error('runtime_config_stage_missing')
  if (!mutation.stageComplete) throw new Error('runtime_config_stage_not_settled')
  preparedRuntimeConfigMutations.delete(ticket.id)
  try {
    await withRuntimeConfigCommit(() => {
      assertRuntimeConfigAvailable()
      if (
        mutation.checkIndexRevision &&
        fileRevision(runtimeConfigIndexPath()) !== mutation.expectedIndexRevision
      ) {
        throw new Error('stale_runtime_config_index')
      }
      for (const expected of mutation.expectedFileRevisions) {
        if (mutation.mergeProfileOriginPaths.includes(expected.filePath)) continue
        if (fileRevision(expected.filePath) !== expected.revision) {
          throw new Error('stale_runtime_config_file')
        }
      }
      for (const expected of mutation.expectedProfiles) {
        const current = storedProfiles.find(profile => profile.id === expected.profileId)
        if (
          !current ||
          profileIncarnations.get(expected.profileId) !== expected.incarnation ||
          !sameDesktopRestEndpoint(
            current.config.externalRestApiBaseUrl,
            expected.externalRestApiBaseUrl
          )
        ) {
          throw new Error('stale_runtime_profile')
        }
      }
      let profilesAfter = mutation.profilesAfter
      for (const filePath of mutation.mergeProfileOriginPaths) {
        const write = mutation.transaction.writes.find(candidate => candidate.filePath === filePath)
        if (!write) throw new Error('runtime_config_stage_invalid')
        const currentDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
        const currentRest =
          typeof currentDisk.externalRestApiBaseUrl === 'string'
            ? currentDisk.externalRestApiBaseUrl
            : ''
        const stagedConfig = JSON.parse(write.contents) as Record<string, unknown>
        if (
          !sameDesktopRestEndpoint(currentRest, String(stagedConfig.externalRestApiBaseUrl || ''))
        ) {
          throw new Error('stale_runtime_profile')
        }
        if (Object.prototype.hasOwnProperty.call(currentDisk, 'profileUiBaseUrl')) {
          stagedConfig.profileUiBaseUrl = currentDisk.profileUiBaseUrl
        } else {
          delete stagedConfig.profileUiBaseUrl
        }
        write.contents = JSON.stringify(stagedConfig, null, 2)
        const profile = profilesAfter.find(candidate => candidate.filePath === filePath)
        if (profile) {
          const profileConfig = { ...profile.config }
          if (Object.prototype.hasOwnProperty.call(currentDisk, 'profileUiBaseUrl')) {
            profileConfig.profileUiBaseUrl =
              typeof currentDisk.profileUiBaseUrl === 'string' ? currentDisk.profileUiBaseUrl : null
          } else {
            delete profileConfig.profileUiBaseUrl
          }
          const updatedProfile = { ...profile, config: profileConfig }
          profilesAfter = profilesAfter.map(candidate =>
            candidate.id === profile.id ? updatedProfile : candidate
          )
        }
      }
      const journalPath = path.join(runtimeConfigDirectoryPath(), RUNTIME_CONFIG_TRANSACTION_FILE)
      if (!mutation.stagePath) throw new Error('runtime_config_stage_missing')
      fs.writeFileSync(mutation.stagePath, JSON.stringify(mutation.transaction), {
        encoding: 'utf8',
        mode: 0o600,
      })
      fs.renameSync(mutation.stagePath, journalPath)
      try {
        applyFileTransactionSync(mutation.transaction)
        fs.rmSync(journalPath)
      } catch {
        configMutationRecoveryRequired = true
        throw new Error('runtime_config_commit_pending_recovery')
      }
      storedProfiles = profilesAfter
      for (const profileId of mutation.removeIncarnations) profileIncarnations.delete(profileId)
      for (const profileId of mutation.rotateIncarnations) {
        profileIncarnations.set(profileId, randomUUID())
      }
      if (mutation.activate) {
        activeRuntimeOptionId = mutation.activeProfileAfter
      }
      if (
        mutation.configAfter &&
        (mutation.activate ||
          (mutation.applyConfigIfActive && activeRuntimeOptionId === mutation.activeProfileAfter))
      ) {
        applyRuntimeConfig(mutation.configAfter, mutation.markConfigured)
      } else if (mutation.activate && !mutation.markConfigured) {
        desktopRuntimeConfigured = false
      }
    })
  } finally {
    if (mutation.stagePath && fs.existsSync(mutation.stagePath)) {
      try {
        fs.rmSync(mutation.stagePath)
      } catch {
        // A remaining inert stage is reaped during startup recovery.
      }
    }
  }
}

/** Complete inert filesystem staging before acquiring either transaction queue. */
export async function stagePreparedDesktopRuntimeConfigMutation(
  ticket: PreparedRuntimeConfigSave
): Promise<void> {
  assertRuntimeConfigAvailable()
  const mutation = preparedRuntimeConfigMutations.get(ticket.id)
  if (!mutation) throw new Error('runtime_config_stage_missing')
  if (mutation.stageComplete) return
  if (!mutation.stagePromise) {
    const stagePath = path.join(
      runtimeConfigDirectoryPath(),
      `${RUNTIME_CONFIG_STAGE_PREFIX}${ticket.id}.json`
    )
    mutation.stagePath = stagePath
    mutation.stagePromise = fsp
      .mkdir(path.dirname(stagePath), { recursive: true })
      .then(() =>
        fsp.writeFile(stagePath, JSON.stringify(mutation.transaction), {
          flag: 'wx',
          mode: 0o600,
        })
      )
      .then(() => {
        assertRuntimeConfigAvailable()
        mutation.stageComplete = true
      })
  }
  try {
    await mutation.stagePromise
  } catch (error) {
    cancelPreparedDesktopRuntimeConfigMutation(ticket)
    throw error
  }
}

export function cancelPreparedDesktopRuntimeConfigMutation(
  ticket: PreparedRuntimeConfigSave
): void {
  const mutation = preparedRuntimeConfigMutations.get(ticket.id)
  preparedRuntimeConfigMutations.delete(ticket.id)
  if (mutation?.stagePath && mutation.stageComplete && runtimeConfigMutationAdmissionOpen) {
    try {
      fs.rmSync(mutation.stagePath, { force: true })
    } catch {
      // An inert stage is reaped during the next startup recovery pass.
    }
  }
}

export async function saveDesktopRuntimeConfig(next: DesktopRuntimeConfig): Promise<void> {
  const ticket = prepareDesktopRuntimeConfigSave(next)
  await stagePreparedDesktopRuntimeConfigMutation(ticket)
  return commitPreparedDesktopRuntimeConfigMutation(ticket)
}

/**
 * Derive the environment namespacing key from a runtime config's external-rest-api
 * and rpc-proxy base origins. Same REST origin + different RPC
 * origin is a different runtime boundary because desktop session tokens are
 * accepted by the RPC proxy, not by external-rest-api alone.
 *
 * The raw identity is not filesystem/keychain-safe (it carries `://`, `:`), so we
 * emit a stable, collision-resistant slug: a lowercase `scheme_host_port`
 * fragment for human debuggability, suffixed with a 12-hex sha256 of the full
 * identity so distinct origins can never collide even when the slug is truncated.
 */
function resolveOriginKeyPart(value: string): string {
  const raw = String(value || '').trim()
  try {
    return new URL(raw).origin
  } catch {
    return raw || 'unknown'
  }
}

export function resolveEnvKey(externalRestApiBaseUrl: string, rpcProxyBaseUrl = ''): string {
  const restOrigin = resolveOriginKeyPart(externalRestApiBaseUrl)
  const rpcOrigin = rpcProxyBaseUrl.trim() ? resolveOriginKeyPart(rpcProxyBaseUrl) : ''
  const identity = rpcOrigin ? `${restOrigin}|rpc=${rpcOrigin}` : restOrigin
  const slugSource = rpcOrigin ? `${restOrigin}_${rpcOrigin}` : restOrigin
  const slug = slugSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  return `${slug || 'env'}-${hash}`
}

/** Hydrated active profile identity without constructing the diagnostics projection. */
export function getActiveRuntimeConfigOptionId(): string | null {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  return activeRuntimeOptionId
}

export type RuntimeConfigProfileIdentity = {
  profileId: string
  incarnation: string
  externalRestApiBaseUrl: string
  profileUiBaseUrl?: string | null
}

export function getActiveRuntimeConfigProfileIdentity(): RuntimeConfigProfileIdentity | null {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  const profileId = activeRuntimeOptionId
  if (!profileId || profileId === LOCALHOST_OPTION_ID) return null
  const profile = storedProfiles.find(candidate => candidate.id === profileId)
  const incarnation = profileIncarnations.get(profileId)
  if (!profile || !incarnation) return null
  return {
    profileId,
    incarnation,
    externalRestApiBaseUrl: canonicalizeDesktopRestEndpoint(profile.config.externalRestApiBaseUrl),
    ...(Object.prototype.hasOwnProperty.call(profile.config, 'profileUiBaseUrl')
      ? { profileUiBaseUrl: profile.config.profileUiBaseUrl }
      : {}),
  }
}

function awaitWithProfileOriginDeadline<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(new Error('profile_ui_action_timeout'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('profile_ui_action_timeout'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** Persist a validated Profile origin without selecting a profile or touching auth state. */
export async function persistProfileUiOrigin(
  identity: RuntimeConfigProfileIdentity,
  rawOrigin: unknown,
  signal?: AbortSignal
): Promise<string> {
  hydrateDesktopRuntimeConfig()
  const origin = validateProfileUiOrigin(rawOrigin, identity.externalRestApiBaseUrl)
  assertRuntimeConfigAvailable()
  const stagedProfile = storedProfiles.find(candidate => candidate.id === identity.profileId)
  if (
    !stagedProfile ||
    profileIncarnations.get(identity.profileId) !== identity.incarnation ||
    !sameDesktopRestEndpoint(
      stagedProfile.config.externalRestApiBaseUrl,
      identity.externalRestApiBaseUrl
    )
  ) {
    throw new Error('stale_runtime_profile')
  }
  if (Object.prototype.hasOwnProperty.call(stagedProfile.config, 'profileUiBaseUrl')) {
    if (typeof stagedProfile.config.profileUiBaseUrl === 'string') {
      return validateProfileUiOrigin(
        stagedProfile.config.profileUiBaseUrl,
        stagedProfile.config.externalRestApiBaseUrl
      )
    }
    throw new Error('saved_profile_origin_invalid')
  }
  const raw = fs.readFileSync(stagedProfile.filePath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const diskRest =
    typeof parsed.externalRestApiBaseUrl === 'string' ? parsed.externalRestApiBaseUrl : ''
  if (!sameDesktopRestEndpoint(diskRest, identity.externalRestApiBaseUrl)) {
    throw new Error('stale_runtime_profile')
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'profileUiBaseUrl')) {
    throw new Error('saved_profile_origin_changed')
  }
  const stagePath = path.join(
    runtimeConfigDirectoryPath(),
    `${RUNTIME_CONFIG_STAGE_PREFIX}${randomUUID()}.json`
  )
  const transaction: RuntimeConfigFileTransaction = {
    version: 1,
    writes: [
      {
        filePath: stagedProfile.filePath,
        contents: JSON.stringify({ ...parsed, profileUiBaseUrl: origin }, null, 2),
      },
    ],
    deletes: [],
  }
  let stageRevoked = false
  const stagePromise = fsp
    .mkdir(path.dirname(stagePath), { recursive: true })
    .then(() => {
      if (stageRevoked || signal?.aborted) {
        throw new Error('profile_ui_action_timeout')
      }
      return fsp.writeFile(stagePath, JSON.stringify(transaction), {
        flag: 'wx',
        mode: 0o600,
      })
    })
    .then(() => {
      if (stageRevoked || signal?.aborted) {
        fs.rmSync(stagePath, { force: true })
        throw new Error('profile_ui_action_timeout')
      }
    })
  try {
    await awaitWithProfileOriginDeadline(stagePromise, signal)
    const commit = withRuntimeConfigCommit(() => {
      assertRuntimeConfigAvailable()
      if (stageRevoked || signal?.aborted) {
        throw new Error('profile_ui_action_timeout')
      }
      const profile = storedProfiles.find(candidate => candidate.id === identity.profileId)
      if (
        !profile ||
        profileIncarnations.get(identity.profileId) !== identity.incarnation ||
        !sameDesktopRestEndpoint(
          profile.config.externalRestApiBaseUrl,
          identity.externalRestApiBaseUrl
        )
      ) {
        throw new Error('stale_runtime_profile')
      }
      if (Object.prototype.hasOwnProperty.call(profile.config, 'profileUiBaseUrl')) {
        if (typeof profile.config.profileUiBaseUrl === 'string') {
          return validateProfileUiOrigin(
            profile.config.profileUiBaseUrl,
            profile.config.externalRestApiBaseUrl
          )
        }
        throw new Error('saved_profile_origin_invalid')
      }
      const currentDisk = JSON.parse(fs.readFileSync(profile.filePath, 'utf8')) as Record<
        string,
        unknown
      >
      const currentRest =
        typeof currentDisk.externalRestApiBaseUrl === 'string'
          ? currentDisk.externalRestApiBaseUrl
          : ''
      if (!sameDesktopRestEndpoint(currentRest, identity.externalRestApiBaseUrl)) {
        throw new Error('stale_runtime_profile')
      }
      if (Object.prototype.hasOwnProperty.call(currentDisk, 'profileUiBaseUrl')) {
        if (typeof currentDisk.profileUiBaseUrl === 'string') {
          const currentOrigin = validateProfileUiOrigin(
            currentDisk.profileUiBaseUrl,
            identity.externalRestApiBaseUrl
          )
          profile.config = {
            ...profile.config,
            profileUiBaseUrl: currentOrigin,
          }
          return currentOrigin
        }
        throw new Error('saved_profile_origin_invalid')
      }
      const profileWrite = transaction.writes[0]
      if (!profileWrite || profileWrite.filePath !== profile.filePath) {
        throw new Error('runtime_config_stage_invalid')
      }
      // RPC and Profile projections may stage together. Merge only the
      // metadata field at commit time so either writer order preserves the
      // latest same-profile RPC/App fields without overwriting unrelated data.
      profileWrite.contents = JSON.stringify({ ...currentDisk, profileUiBaseUrl: origin }, null, 2)
      fs.writeFileSync(stagePath, JSON.stringify(transaction), {
        encoding: 'utf8',
        mode: 0o600,
      })
      const journalPath = path.join(runtimeConfigDirectoryPath(), RUNTIME_CONFIG_TRANSACTION_FILE)
      fs.renameSync(stagePath, journalPath)
      try {
        applyFileTransactionSync(transaction)
        fs.rmSync(journalPath)
      } catch {
        configMutationRecoveryRequired = true
        throw new Error('runtime_config_commit_pending_recovery')
      }
      profile.config = { ...profile.config, profileUiBaseUrl: origin }
      return origin
    })
    return await awaitWithProfileOriginDeadline(commit, signal)
  } catch (error) {
    stageRevoked = true
    throw error
  } finally {
    if (fs.existsSync(stagePath)) {
      try {
        fs.rmSync(stagePath)
      } catch {
        // A remaining inert stage is reaped during startup recovery.
      }
    }
  }
}

/** Env key for the CURRENTLY active runtime config (main-process surfaces). */
export function getActiveEnvKey(): string {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  return resolveEnvKey(config.externalRestApiBaseUrl, config.rpcProxyBaseUrl)
}

/**
 * Legacy env key from the pre-RPC-origin namespace. Used only for one-shot
 * upgrade migration into the current REST+RPC namespace.
 */
export function getActiveLegacyRestOnlyEnvKey(): string {
  hydrateDesktopRuntimeConfig()
  return resolveEnvKey(config.externalRestApiBaseUrl)
}

/**
 * Return the pre-RPC-origin namespace only when it maps to one configured
 * environment. Two profiles sharing REST but using different RPC origins
 * cannot safely claim the same legacy token or chat tree.
 */
export function getActiveLegacyEnvKeys(): string[] {
  hydrateDesktopRuntimeConfig()
  const envKey = getActiveEnvKey()
  const legacyEnvKey = getActiveLegacyRestOnlyEnvKey()
  if (legacyEnvKey === envKey) return []

  const matchingEnvironmentKeys = new Set(
    buildRuntimeConfigOptions(storedProfiles, localhostRuntimeConfig, true)
      .filter(option => resolveEnvKey(option.externalRestApiBaseUrl) === legacyEnvKey)
      .map(option => resolveEnvKey(option.externalRestApiBaseUrl, option.rpcProxyBaseUrl))
  )
  return matchingEnvironmentKeys.size > 1 ? [] : [legacyEnvKey]
}

export function getDesktopRuntimeConfigState(): DesktopRuntimeConfigState {
  hydrateDesktopRuntimeConfig()
  assertRuntimeConfigAvailable()
  const current = currentRuntimeConfig()
  const isLocalhost = isLocalhostRuntimeConfig(current)
  const selectorVisible = isRuntimeConfigSelectorVisible()
  const options = buildRuntimeConfigOptions(storedProfiles, localhostRuntimeConfig, true)
  const selectedUnconfiguredOptionId = options.some(option => option.id === activeRuntimeOptionId)
    ? activeRuntimeOptionId
    : null
  const activeOptionId = desktopRuntimeConfigured
    ? options.some(option => option.id === activeRuntimeOptionId)
      ? activeRuntimeOptionId
      : null
    : selectedUnconfiguredOptionId
  return {
    configured: desktopRuntimeConfigured,
    isLocalhost,
    selectorVisible,
    activeOptionId,
    currentConfig: {
      externalRestApiBaseUrl: current.externalRestApiBaseUrl,
      rpcProxyBaseUrl: current.rpcProxyBaseUrl,
      appName: current.appName,
    },
    envKey: resolveEnvKey(current.externalRestApiBaseUrl, current.rpcProxyBaseUrl),
    storagePath: explicitRuntimeConfigPath() || runtimeConfigDirectoryPath(),
    options,
  }
}

export async function selectDesktopRuntimeConfigOption(optionId: string): Promise<void> {
  const ticket = prepareDesktopRuntimeConfigSelection(optionId)
  await stagePreparedDesktopRuntimeConfigMutation(ticket)
  await commitPreparedDesktopRuntimeConfigMutation(ticket)
}

export async function clearDesktopRuntimeConfigSelection(): Promise<void> {
  const ticket = prepareClearDesktopRuntimeConfigSelection()
  await stagePreparedDesktopRuntimeConfigMutation(ticket)
  await commitPreparedDesktopRuntimeConfigMutation(ticket)
}

export async function deleteDesktopRuntimeConfigOption(optionId: string): Promise<void> {
  const ticket = prepareDeleteDesktopRuntimeConfigOption(optionId)
  await stagePreparedDesktopRuntimeConfigMutation(ticket)
  await commitPreparedDesktopRuntimeConfigMutation(ticket)
}
