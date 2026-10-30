import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [previousRepository, expectedPreviousSha] = process.argv.slice(2)
const desktopRoot = process.env.PR977_DESKTOP_ROOT
if (!previousRepository || !expectedPreviousSha || !desktopRoot) {
  throw new Error('Previous-head proof inputs are incomplete')
}

const actualPreviousSha = execFileSync('git', ['-C', previousRepository, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
if (actualPreviousSha !== expectedPreviousSha) {
  throw new Error('Previous-head proof checkout does not match its SHA pin')
}

const legacySourcePath = path.join(previousRepository, 'desktop-app/src/pluginAuditLog.ts')
const legacySource = readFileSync(legacySourcePath, 'utf8')
const legacyConsentSourcePath = path.join(
  previousRepository,
  'desktop-app/src/pluginConsentStore.ts'
)
const legacyConsentSource = readFileSync(legacyConsentSourcePath, 'utf8')
const testDirectory = path.join(desktopRoot, 'src/__tests__')
const modulePath = path.join(testDirectory, 'r24m7-previous-head-pluginAuditLog.ts')
const consentModulePath = path.join(testDirectory, 'r24m7-previous-head-pluginConsentStore.ts')
const testPath = path.join(testDirectory, 'r24m7-previous-head-plugin-audit.test.ts')

const testSource = `import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV,
  windowsSessionAuthorityNativeAssemblyPath,
} from '../windowsSessionAuthorityNativeAssembly.js'
import { createWindowsSessionAuthorityPowerShellEnvironment } from '../windowsSessionAuthorityPowerShellEnvironment.js'
import { PluginAuditLog } from './r24m7-previous-head-pluginAuditLog.js'
import { LocalConsentStore } from './r24m7-previous-head-pluginConsentStore.js'

const ENV_KEY = 'testenv-0123456789ab'
const TARGET_ENV = 'EVENFIRE_PLUGIN_ACL_FIXTURE_TARGET'
const grant = {
  envKey: ENV_KEY,
  userId: 'fixture-user',
  pluginId: 'fixture/plugin',
  capability: 'identity.read',
  grantedAt: '2026-10-30T00:00:00.000Z',
  lastUsedAt: null,
  descriptorVersion: 1,
  revision: 0,
}
const MUTATE_SCRIPT = String.raw\`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_PLUGIN_ACL_FIXTURE_TARGET')
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-11')
$rights = [Security.AccessControl.FileSystemRights]::ReadData -bor
  [Security.AccessControl.FileSystemRights]::WriteData -bor
  [Security.AccessControl.FileSystemRights]::AppendData
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $sid, $rights, [Security.AccessControl.AccessControlType]::Allow)
$file = [IO.FileInfo]::new($target)
$security = $file.GetAccessControl()
$security.AddAccessRule($rule)
$file.SetAccessControl($security)
\`

let directory = ''

async function addAuthenticatedUsersAccess(file: string): Promise<void> {
  const systemRoot = process.env.SystemRoot
  const temporaryDirectory = process.env.TEMP ?? process.env.TMP
  if (!systemRoot || !temporaryDirectory) throw new Error('Fixture environment unavailable')
  const result = spawnSync(
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$source = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($source))',
    ],
    {
      encoding: 'utf8',
      env: {
        ...createWindowsSessionAuthorityPowerShellEnvironment(systemRoot, temporaryDirectory),
        [TARGET_ENV]: file,
        [WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV]:
          windowsSessionAuthorityNativeAssemblyPath(),
      },
      input: MUTATE_SCRIPT,
      maxBuffer: 2048,
      timeout: 10000,
      windowsHide: true,
    }
  )
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('Disposable ACL mutation failed')
  }
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-prevhead-audit-'))
})

afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('R24-M7 previous-head plugin storage privacy regressions', () => {
  it('rejects a new audit append after an unsafe DACL is added', async () => {
    const logger = new PluginAuditLog(directory)
    const entry = {
      ts: '2026-10-30T00:00:00.000Z',
      userId: 'fixture-user',
      pluginId: 'fixture/plugin',
      capability: 'identity.read',
      outcome: 'allowed',
    }
    await logger.append(ENV_KEY, entry)
    const file = path.join(directory, ENV_KEY + '.jsonl')
    const before = await fs.readFile(file)
    await addAuthenticatedUsersAccess(file)
    const reopened = new PluginAuditLog(directory)
    await reopened.append(ENV_KEY, { ...entry, capability: 'org.read' })
    expect(await fs.readFile(file)).toEqual(before)
  })

  it('refuses to trust an existing consent grant after an unsafe DACL is added', async () => {
    const consentDirectory = path.join(directory, 'consent')
    const store = new LocalConsentStore(consentDirectory)
    await store.put(grant)
    const file = path.join(consentDirectory, ENV_KEY + '.json')
    await addAuthenticatedUsersAccess(file)
    const reopened = new LocalConsentStore(consentDirectory)
    await expect(reopened.get(grant)).rejects.toThrow('privacy could not be verified')
  })
})
`

writeFileSync(modulePath, legacySource, 'utf8')
writeFileSync(consentModulePath, legacyConsentSource, 'utf8')
writeFileSync(testPath, testSource, 'utf8')
process.stdout.write('Previous-head producer test prepared for the pinned source checkout.\n')
