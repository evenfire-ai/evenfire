import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
const LOCALHOST_OPTION_ID = '__localhost__'
const LOCALHOST_EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:8091'
const LOCALHOST_RPC_PROXY_BASE_URL = 'http://127.0.0.1:8094'
const RUNTIME_CONFIG_DIR_NAME = 'runtime-configs'
const RUNTIME_CONFIG_INDEX_FILE = 'index.json'
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
  return process.env.CLERUM_DESKTOP_CONFIG_PATH?.trim() || ''
}

function requiredOrDefault(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value || fallback
}

function deriveProfileUiBaseUrl(externalRestApiBaseUrl: string): string {
  const explicit = process.env.PROFILE_UI_BASE_URL?.trim()
  if (explicit) return explicit

  try {
    const url = new URL(externalRestApiBaseUrl)
    url.username = ''
    url.password = ''
    url.pathname = ''
    url.search = ''
    url.hash = ''

    if (url.hostname === 'example.com') {
      url.hostname = 'example.com'
      return url.toString().replace(/\/$/, '')
    }

    if (url.hostname === 'example.com') {
      url.hostname = 'example.com'
      return url.toString().replace(/\/$/, '')
    }

    if (url.hostname.startsWith('api.')) {
      url.hostname = `profile.${url.hostname.slice(4)}`
      return url.toString().replace(/\/$/, '')
    }

    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') {
      url.port = '3001'
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    // Keep the local developer fallback when runtime config is invalid or unavailable.
  }

  return 'http://127.0.0.1:3001'
}

function hasExplicitProfileUiBaseUrl(): boolean {
  return Boolean(process.env.PROFILE_UI_BASE_URL?.trim())
}

function runtimeConfigDirectoryPath(): string {
  const explicit = explicitRuntimeConfigPath()
  if (explicit) return path.dirname(explicit)

  if (app?.isReady()) {
    return path.join(app.getPath('userData'), RUNTIME_CONFIG_DIR_NAME)
  }

  // Keep a deterministic fallback before Electron is ready.
  return path.join(defaultUserDataDirectoryPath(), RUNTIME_CONFIG_DIR_NAME)
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

async function writeRuntimeConfig(filePath: string, next: DesktopRuntimeConfig): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(next, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
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

async function writeRuntimeConfigIndex(index: RuntimeConfigIndex): Promise<void> {
  const filePath = runtimeConfigIndexPath()
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(index, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
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
    a.externalRestApiBaseUrl === b.externalRestApiBaseUrl && a.rpcProxyBaseUrl === b.rpcProxyBaseUrl
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

async function persistProfilesIndex(
  profiles: StoredRuntimeProfile[],
  activeProfileId: string | null
): Promise<void> {
  if (explicitRuntimeConfigPath()) return
  const directoryPath = runtimeConfigDirectoryPath()
  const nextIndex: RuntimeConfigIndex = {
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
  await writeRuntimeConfigIndex(nextIndex)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function validateRuntimeConfig(next: DesktopRuntimeConfig): DesktopRuntimeConfig {
  const normalized = {
    externalRestApiBaseUrl: next.externalRestApiBaseUrl.trim(),
    rpcProxyBaseUrl: (next.rpcProxyBaseUrl || '').trim(),
    appName: next.appName?.trim() || DEFAULT_APP_NAME,
  }

  if (!isHttpUrl(normalized.externalRestApiBaseUrl)) {
    throw new Error('externalRestApiBaseUrl must be a valid http(s) URL')
  }
  if (normalized.rpcProxyBaseUrl && !isHttpUrl(normalized.rpcProxyBaseUrl)) {
    throw new Error('rpcProxyBaseUrl must be a valid http(s) URL')
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
const loadedProfilesState = loadStoredProfilesSync()
let storedProfiles = loadedProfilesState.profiles
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
  return {
    externalRestApiBaseUrl: config.externalRestApiBaseUrl,
    rpcProxyBaseUrl: config.rpcProxyBaseUrl,
    appName: config.appName,
  }
}

let runtimeConfigHydrated = false

export function hydrateDesktopRuntimeConfig(): void {
  // Config is imported before Electron is ready. Re-load profiles once the app is ready so
  // dev builds can see packaged configs under userData, and dev env vars can override.
  if (runtimeConfigHydrated) return
  if (!app?.isReady()) return
  runtimeConfigHydrated = true

  const loaded = loadStoredProfilesSync()
  storedProfiles = loaded.profiles
  const preserveLocalhostRuntime =
    preferLocalhostRuntimeByDefault ||
    (desktopDevPackageRuntimeConfigEnabled &&
      envMatchesLocalhostOption &&
      isLocalhostRuntimeConfig(currentRuntimeConfig()))
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
  return desktopRuntimeConfigured
}

export async function saveDesktopRuntimeConfig(next: DesktopRuntimeConfig): Promise<void> {
  hydrateDesktopRuntimeConfig()
  const validated = validateRuntimeConfig(next)
  const explicitPath = explicitRuntimeConfigPath()
  if (explicitPath) {
    const timestamp = new Date().toISOString()
    const existing = storedProfiles.find(profile => profile.id === 'custom-file')
    await writeRuntimeConfig(explicitPath, validated)
    storedProfiles = [
      {
        id: 'custom-file',
        appName: validated.appName?.trim() || DEFAULT_APP_NAME,
        filePath: explicitPath,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
        config: validated,
      },
    ]
    activeRuntimeOptionId = 'custom-file'
    applyRuntimeConfig(validated, true)
    return
  }

  const existing = storedProfiles.find(
    profile => profile.config.externalRestApiBaseUrl === validated.externalRestApiBaseUrl
  )
  if (existing) {
    existing.updatedAt = new Date().toISOString()
    existing.appName = validated.appName?.trim() || DEFAULT_APP_NAME
    existing.config = {
      externalRestApiBaseUrl: validated.externalRestApiBaseUrl,
      rpcProxyBaseUrl: validated.rpcProxyBaseUrl || '',
      appName: validated.appName?.trim() || DEFAULT_APP_NAME,
    }
    await writeRuntimeConfig(existing.filePath, existing.config)
    activeRuntimeOptionId = existing.id
    applyRuntimeConfig(existing.config, true)
    await persistProfilesIndex(storedProfiles, activeRuntimeOptionId)
    return
  }

  const directoryPath = runtimeConfigDirectoryPath()
  const filePath = nextProfileFilePath(directoryPath, validated.appName || DEFAULT_APP_NAME)
  const timestamp = new Date().toISOString()
  const profile: StoredRuntimeProfile = {
    id: `${toAppSlug(validated.appName || DEFAULT_APP_NAME)}-${Date.now()}`,
    appName: validated.appName?.trim() || DEFAULT_APP_NAME,
    filePath,
    createdAt: timestamp,
    updatedAt: timestamp,
    config: validated,
  }
  await writeRuntimeConfig(filePath, validated)
  storedProfiles = [...storedProfiles, profile]
  activeRuntimeOptionId = profile.id
  applyRuntimeConfig(validated, true)
  await persistProfilesIndex(storedProfiles, activeRuntimeOptionId)
}

/**
 * Derive the environment namespacing key from a runtime config's external-rest-api
 * and rpc-proxy base origins (spec §5.1, D1). Same REST origin + different RPC
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

/** Env key for the CURRENTLY active runtime config (main-process surfaces). */
export function getActiveEnvKey(): string {
  hydrateDesktopRuntimeConfig()
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
    envKey: resolveEnvKey(current.externalRestApiBaseUrl, current.rpcProxyBaseUrl),
    storagePath: explicitRuntimeConfigPath() || runtimeConfigDirectoryPath(),
    options,
  }
}

export async function selectDesktopRuntimeConfigOption(optionId: string): Promise<void> {
  hydrateDesktopRuntimeConfig()
  const id = String(optionId || '').trim()
  if (!id) throw new Error('runtime configuration id is required')

  if (id === LOCALHOST_OPTION_ID) {
    activeRuntimeOptionId = LOCALHOST_OPTION_ID
    applyRuntimeConfig(localhostRuntimeConfig, true)
    await persistProfilesIndex(storedProfiles, LOCALHOST_OPTION_ID)
    return
  }

  const selected = storedProfiles.find(profile => profile.id === id)
  if (!selected) throw new Error('runtime configuration not found')

  activeRuntimeOptionId = selected.id
  applyRuntimeConfig(selected.config, true)
  await persistProfilesIndex(storedProfiles, activeRuntimeOptionId)
}

export async function clearDesktopRuntimeConfigSelection(): Promise<void> {
  hydrateDesktopRuntimeConfig()
  activeRuntimeOptionId = null
  desktopRuntimeConfigured = false
  applyRuntimeConfig(envRuntimeConfig, false)
  await persistProfilesIndex(storedProfiles, null)
}

export async function deleteDesktopRuntimeConfigOption(optionId: string): Promise<void> {
  hydrateDesktopRuntimeConfig()
  const id = String(optionId || '').trim()
  if (!id) throw new Error('runtime configuration id is required')

  const selected = storedProfiles.find(profile => profile.id === id)
  if (!selected) throw new Error('runtime configuration not found')

  storedProfiles = storedProfiles.filter(profile => profile.id !== id)
  await fsp.rm(selected.filePath, { force: true })

  if (activeRuntimeOptionId === id) {
    const fallbackProfile = resolveActiveProfile(storedProfiles, null)
    if (fallbackProfile) {
      activeRuntimeOptionId = fallbackProfile.id
      applyRuntimeConfig(fallbackProfile.config, true)
    } else if (envRuntimeConfigured) {
      activeRuntimeOptionId = envMatchesLocalhostOption ? LOCALHOST_OPTION_ID : null
      applyRuntimeConfig(envRuntimeConfig, true)
    } else if (shouldPreferLocalhostByDefault()) {
      activeRuntimeOptionId = LOCALHOST_OPTION_ID
      applyRuntimeConfig(localhostRuntimeConfig, true)
    } else {
      activeRuntimeOptionId = null
      desktopRuntimeConfigured = false
      applyRuntimeConfig(envRuntimeConfig, false)
    }
  }

  const persistedActiveProfileId = storedProfiles.some(
    profile => profile.id === activeRuntimeOptionId
  )
    ? activeRuntimeOptionId
    : null
  await persistProfilesIndex(storedProfiles, persistedActiveProfileId)
}
