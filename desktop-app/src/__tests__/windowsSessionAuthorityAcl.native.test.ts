import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  provisionWindowsSessionAuthorityDirectory,
  verifyWindowsSessionAuthorityDirectory,
} from '../windowsSessionAuthorityAcl.js'
import { createWindowsSessionAuthorityPowerShellEnvironment } from '../windowsSessionAuthorityPowerShellEnvironment.js'

if (process.env.EVENFIRE_REQUIRE_WINDOWS_ACL_TEST === '1' && process.platform !== 'win32') {
  throw new Error('The required native session-authority ACL suite must run on Windows')
}

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip
const powershell = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
const powershellLauncher = String.raw`$sourceText = [Console]::In.ReadToEnd(); try { & ([scriptblock]::Create($sourceText)) } catch { $exception = $_.Exception; $inner = $exception.InnerException; while ($inner -and $inner.InnerException) { $inner = $inner.InnerException }; $safe = [ordered]@{ errorType = $exception.GetType().Name; hresult = ('0x{0:X8}' -f $exception.HResult); innerErrorType = if ($inner) { $inner.GetType().Name } else { $null }; innerHresult = if ($inner) { '0x{0:X8}' -f $inner.HResult } else { $null } }; [Console]::Error.WriteLine('EVENFIRE_FIXTURE_FAILURE=' + ($safe | ConvertTo-Json -Compress)); exit 1 }`
const powershellOperations = new Set([
  'add-everyone-modify',
  'add-trusted-installer-modify',
  'add-authenticated-users-create-directory',
  'add-current-user-inherit-only-ace',
  'create-authority-child-junction',
  'create-user-data-parent-junction',
  'remove-user-data-parent-junction',
  'set-allowed-child-owner',
])
const ACL_API_HELPERS = String.raw`
function Get-TestAcl([string]$target) {
  if ([IO.Directory]::Exists($target)) { return [IO.Directory]::GetAccessControl($target) }
  return [IO.File]::GetAccessControl($target)
}
function Set-TestAcl([string]$target, $acl) {
  if ([IO.Directory]::Exists($target)) {
    [IO.Directory]::SetAccessControl($target, $acl)
  } else {
    [IO.File]::SetAccessControl($target, $acl)
  }
}
`

let temporaryRoot = ''
let userDataPath = ''
let authorityPath = ''

function powershellFailureCategory(stderr: string): string {
  const diagnostic = powershellFixtureDiagnostics(stderr)
  const errorTypes = [diagnostic?.errorType, diagnostic?.innerErrorType]
  if (errorTypes.some(type => type === 'PrivilegeNotHeldException')) return 'privilege-not-held'
  if (errorTypes.some(type => type === 'UnauthorizedAccessException')) return 'access-denied'
  if (errorTypes.some(type => type === 'Win32Exception')) return 'win32-api-failure'
  if (errorTypes.some(type => type === 'ArgumentException')) return 'argument-rejected'
  if (errorTypes.some(type => type === 'PlatformNotSupportedException'))
    return 'platform-api-unavailable'
  if (stderr.includes('fixture-inherit-only-ace-not-persisted'))
    return 'fixture-ace-readback-mismatch'
  if (stderr.includes('InvalidCastException')) return 'invalid-cast'
  if (/UnauthorizedAccessException|Access is denied/i.test(stderr)) return 'access-denied'
  if (stderr.includes('ArgumentException')) return 'argument-rejected'
  if (stderr.includes('MethodInvocationException')) return 'method-invocation-failed'
  if (/ParserError|parse error/i.test(stderr)) return 'script-parse-failed'
  if (/Cannot find an overload/i.test(stderr)) return 'overload-resolution-failed'
  return 'unclassified-powershell-failure'
}

function powershellFixtureDiagnostics(
  stderr: string
): { errorType?: string; hresult?: string; innerErrorType?: string; innerHresult?: string } | null {
  const match = stderr.match(/EVENFIRE_FIXTURE_FAILURE=(\{[^\r\n]*\})/)
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(match[1]!)
    if (!parsed || typeof parsed !== 'object') return null
    const fields = parsed as Record<string, unknown>
    const allowedTypes = new Set([
      'ArgumentException',
      'DirectoryNotFoundException',
      'IOException',
      'InvalidOperationException',
      'MethodInvocationException',
      'PlatformNotSupportedException',
      'PrivilegeNotHeldException',
      'UnauthorizedAccessException',
      'Win32Exception',
    ])
    const output: {
      errorType?: string
      hresult?: string
      innerErrorType?: string
      innerHresult?: string
    } = {}
    for (const field of ['errorType', 'innerErrorType'] as const) {
      const value = fields[field]
      if (typeof value === 'string' && allowedTypes.has(value)) output[field] = value
    }
    for (const field of ['hresult', 'innerHresult'] as const) {
      const value = fields[field]
      if (typeof value === 'string' && /^0x[0-9A-F]{8}$/i.test(value)) output[field] = value
    }
    return output
  } catch {
    return null
  }
}

function powershellProcessErrorCode(error: Error | undefined): string | undefined {
  if (!error || !('code' in error) || typeof error.code !== 'string') return undefined
  const allowed = new Set(['E2BIG', 'EACCES', 'EINVAL', 'ENOENT', 'EPERM', 'ETIMEDOUT'])
  return allowed.has(error.code) ? error.code : 'OTHER'
}

type PowerShellOperation =
  | 'add-everyone-modify'
  | 'add-trusted-installer-modify'
  | 'add-authenticated-users-create-directory'
  | 'add-current-user-inherit-only-ace'
  | 'create-authority-child-junction'
  | 'create-user-data-parent-junction'
  | 'remove-user-data-parent-junction'
  | 'set-allowed-child-owner'

function runPowerShell(
  operation: PowerShellOperation,
  script: string,
  variables: Record<string, string> = {}
): void {
  if (!powershellOperations.has(operation) || typeof script !== 'string')
    throw new Error('Native Windows ACL fixture received an invalid operation contract')

  const systemRoot = process.env.SystemRoot
  const temporaryDirectory = process.env.TEMP ?? process.env.TMP
  if (!systemRoot || !temporaryDirectory)
    throw new Error('Native Windows ACL fixture requires Windows system directories')

  const result = spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellLauncher],
    {
      env: {
        ...createWindowsSessionAuthorityPowerShellEnvironment(systemRoot, temporaryDirectory),
        ...variables,
      },
      encoding: 'utf8',
      input: `${ACL_API_HELPERS}\n${script}`,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    }
  )
  if (result.error || result.status !== 0 || result.signal) {
    const fixtureDiagnostic = powershellFixtureDiagnostics(result.stderr ?? '')
    throw new Error(
      `Native Windows ACL fixture failed: ${JSON.stringify({
        operation,
        processStarted: typeof result.pid === 'number' && result.pid > 0,
        processErrorCode: powershellProcessErrorCode(result.error),
        exitStatus: result.status,
        processSignaled: Boolean(result.signal),
        stdoutPresent: Boolean(result.stdout),
        stderrPresent: Boolean(result.stderr),
        powershellFailureCategory: powershellFailureCategory(result.stderr ?? ''),
        ...(fixtureDiagnostic ?? {}),
      })}`
    )
  }
}

function addEveryoneModify(target: string): void {
  runPowerShell(
    'add-everyone-modify',
    String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
$acl = Get-TestAcl $target
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::Modify,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-TestAcl $target $acl
`,
    { EVENFIRE_ACL_TEST_TARGET: target }
  )
}

function addTrustedInstallerModify(target: string): void {
  runPowerShell(
    'add-trusted-installer-modify',
    String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
$acl = Get-TestAcl $target
$trustedInstaller = [System.Security.Principal.SecurityIdentifier]::new(
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $trustedInstaller,
  [System.Security.AccessControl.FileSystemRights]::Modify,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-TestAcl $target $acl
`,
    { EVENFIRE_ACL_TEST_TARGET: target }
  )
}

function addAuthenticatedUsersCreateDirectory(target: string): void {
  runPowerShell(
    'add-authenticated-users-create-directory',
    String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
$acl = Get-TestAcl $target
$authenticatedUsers = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-11')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $authenticatedUsers,
  [System.Security.AccessControl.FileSystemRights]::CreateDirectories,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-TestAcl $target $acl
`,
    { EVENFIRE_ACL_TEST_TARGET: target }
  )
}

function addCurrentUserInheritOnlyFullControl(target: string): void {
  runPowerShell(
    'add-current-user-inherit-only-ace',
    String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = [System.Security.AccessControl.InheritanceFlags](
  [int][System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [int][System.Security.AccessControl.InheritanceFlags]::ObjectInherit
)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::InheritOnly,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl = [IO.Directory]::GetAccessControl($target)
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($target, $acl)
$readBack = [System.Security.AccessControl.RawSecurityDescriptor]::new(
  ([IO.Directory]::GetAccessControl($target)).GetSecurityDescriptorBinaryForm(),
  0
)
$found = $false
foreach ($entry in $readBack.DiscretionaryAcl) {
  if ($entry -is [System.Security.AccessControl.CommonAce] -and
    $entry.SecurityIdentifier.Value -eq $sid.Value -and
    ([int]$entry.AceFlags -band [int][System.Security.AccessControl.AceFlags]::InheritOnly) -ne 0 -and
    ([int]$entry.AceFlags -band [int][System.Security.AccessControl.AceFlags]::Inherited) -eq 0) {
    $found = $true
  }
}
if (-not $found) { throw 'fixture-inherit-only-ace-not-persisted' }
`,
    { EVENFIRE_ACL_TEST_TARGET: target }
  )
}

function setAllowedChildOwner(target: string, ownerSid: string): void {
  runPowerShell(
    'set-allowed-child-owner',
    String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
$ownerSid = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_OWNER')
if ($ownerSid -notin @('S-1-5-18', 'S-1-5-32-544')) {
  throw 'fixture-owner-not-allowlisted'
}
$acl = [IO.Directory]::GetAccessControl($target)
$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($ownerSid))
[IO.Directory]::SetAccessControl($target, $acl)
$readBack = [IO.Directory]::GetAccessControl($target)
$actual = $readBack.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($actual -ne $ownerSid) { throw 'fixture-owner-readback-mismatch' }
`,
    { EVENFIRE_ACL_TEST_TARGET: target, EVENFIRE_ACL_TEST_OWNER: ownerSid }
  )
}

windowsDescribe('Windows session authority ACL native contract', () => {
  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-session-acl-'))
    userDataPath = path.join(temporaryRoot, 'user-data')
    authorityPath = path.join(userDataPath, 'sessions')
    await fs.mkdir(userDataPath)
  })

  afterEach(async () => {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = ''
  })

  it('provisions a protected authority directory and verifies every existing child', async () => {
    const provisioned = provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    expect(provisioned.userSid).toMatch(/^S-1-/)
    expect(provisioned.authorityOwnerSid).toBe(provisioned.userSid)
    expect(provisioned.rootIdentity).toMatch(/^[0-9A-F]+:[0-9A-F]+$/i)
    expect(provisioned.authorityIdentity).toMatch(/^[0-9A-F]+:[0-9A-F]+$/i)
    expect(provisioned.objectCount).toBe(1)

    const nested = path.join(authorityPath, 'candidates')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, 'accepted-source.json'), '{"synthetic":true}')

    const verified = verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    expect(verified).toEqual({ ...provisioned, objectCount: 3 })
  })

  it.each([
    { label: 'SYSTEM', sid: 'S-1-5-18' },
    { label: 'Administrators', sid: 'S-1-5-32-544' },
  ])(
    'accepts a child owned by the allowlisted $label principal with current-user access intact',
    async ({ sid }) => {
      provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
      const child = path.join(authorityPath, `allowed-owner-${sid.replaceAll('-', '_')}`)
      await fs.mkdir(child)
      setAllowedChildOwner(child, sid)

      expect(verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath).objectCount).toBe(
        2
      )
    }
  )

  it('rejects an unsafe ACL on an existing child instead of repairing or trusting it', async () => {
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    const credential = path.join(authorityPath, 'candidate.enc')
    await fs.writeFile(credential, 'synthetic-ciphertext')
    addEveryoneModify(credential)

    expect(() => verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
    expect(() => provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
  })

  it('does not extend the ancestor TrustedInstaller exception into the private authority tree', () => {
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    addTrustedInstallerModify(authorityPath)

    expect(() => verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
  })

  it('rejects an inherit-only ACE that grants no direct rights on a private child', async () => {
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    const childDirectory = path.join(authorityPath, 'inherit-only-child')
    await fs.mkdir(childDirectory)
    addCurrentUserInheritOnlyFullControl(childDirectory)

    expect(() => verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
  })

  it('rejects a user-data ancestry that grants another principal mutation access', async () => {
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    addEveryoneModify(userDataPath)

    expect(() => verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
  })

  it('rejects create-child access for Authenticated Users outside the volume root', () => {
    addAuthenticatedUsersCreateDirectory(userDataPath)

    expect(() => provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
  })

  it('rejects a reparse-point child without traversing it', async () => {
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    const target = path.join(temporaryRoot, 'outside-authority')
    const junction = path.join(authorityPath, 'redirect')
    await fs.mkdir(target)
    runPowerShell(
      'create-authority-child-junction',
      String.raw`
$ErrorActionPreference = 'Stop'
$junction = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_JUNCTION')
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
`,
      {
        EVENFIRE_ACL_TEST_JUNCTION: junction,
        EVENFIRE_ACL_TEST_TARGET: target,
      }
    )

    expect(() => verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
  })

  it('rejects a reparse-point user-data parent', async () => {
    const alias = path.join(temporaryRoot, 'user-data-alias')
    runPowerShell(
      'create-user-data-parent-junction',
      String.raw`
$ErrorActionPreference = 'Stop'
$junction = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_JUNCTION')
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
`,
      {
        EVENFIRE_ACL_TEST_JUNCTION: alias,
        EVENFIRE_ACL_TEST_TARGET: userDataPath,
      }
    )

    try {
      expect(() =>
        provisionWindowsSessionAuthorityDirectory(alias, path.join(alias, 'sessions'))
      ).toThrow('Windows session authority ACL verification failed')
    } finally {
      runPowerShell(
        'remove-user-data-parent-junction',
        String.raw`
$ErrorActionPreference = 'Stop'
$junction = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_JUNCTION')
[IO.Directory]::Delete($junction)
`,
        { EVENFIRE_ACL_TEST_JUNCTION: alias }
      )
    }
  })

  it('rejects a credential file with an external hard link', async () => {
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    const credential = path.join(authorityPath, 'candidate.enc')
    const alias = path.join(temporaryRoot, 'outside-alias.enc')
    await fs.writeFile(credential, 'synthetic-ciphertext')
    await fs.link(credential, alias)

    expect(() => verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
  })

  it('does not reuse a stale authority-directory identity after replacement', async () => {
    const original = provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    const retiredPath = path.join(userDataPath, 'sessions-retired')
    await fs.rename(authorityPath, retiredPath)

    const replacement = provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    expect(replacement.rootIdentity).toBe(original.rootIdentity)
    expect(replacement.authorityIdentity).not.toBe(original.authorityIdentity)
    expect(verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toEqual(replacement)
  })

  it('rejects a path that is not the canonical sessions child of userData', async () => {
    const unrelated = path.join(userDataPath, 'not-sessions')
    await expect(
      Promise.resolve().then(() =>
        provisionWindowsSessionAuthorityDirectory(userDataPath, unrelated)
      )
    ).rejects.toThrow('Windows session authority ACL verification failed')
  })
})
