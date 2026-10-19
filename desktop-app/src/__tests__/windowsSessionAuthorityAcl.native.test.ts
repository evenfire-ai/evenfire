import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  provisionWindowsSessionAuthorityDirectory,
  verifyWindowsSessionAuthorityDirectory,
} from '../windowsSessionAuthorityAcl.js'

if (process.env.EVENFIRE_REQUIRE_WINDOWS_ACL_TEST === '1' && process.platform !== 'win32') {
  throw new Error('The required native session-authority ACL suite must run on Windows')
}

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip
const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64')
const powershell = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

let temporaryRoot = ''
let userDataPath = ''
let authorityPath = ''

function runPowerShell(script: string, variables: Record<string, string> = {}): void {
  execFileSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)],
    {
      env: { ...process.env, ...variables },
      stdio: 'pipe',
      windowsHide: true,
    }
  )
}

function addEveryoneModify(target: string): void {
  runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
$acl = Get-Acl -LiteralPath $target
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::Modify,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
`,
    { EVENFIRE_ACL_TEST_TARGET: target }
  )
}

function addCurrentUserInheritOnlyFullControl(target: string): void {
  runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
$acl = Get-Acl -LiteralPath $target
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::InheritOnly,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
`,
    { EVENFIRE_ACL_TEST_TARGET: target }
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
    expect(provisioned.rootIdentity).toMatch(/^[0-9A-F]+:[0-9A-F]+$/i)
    expect(provisioned.authorityIdentity).toMatch(/^[0-9A-F]+:[0-9A-F]+$/i)
    expect(provisioned.objectCount).toBe(1)

    const nested = path.join(authorityPath, 'candidates')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, 'accepted-source.json'), '{"synthetic":true}')

    const verified = verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    expect(verified).toEqual({ ...provisioned, objectCount: 3 })
  })

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

  it('rejects inherit-only ACEs that do not grant rights on the authority object itself', () => {
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    addCurrentUserInheritOnlyFullControl(authorityPath)

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

  it('rejects a reparse-point child without traversing it', async () => {
    provisionWindowsSessionAuthorityDirectory(userDataPath, authorityPath)
    const target = path.join(temporaryRoot, 'outside-authority')
    const junction = path.join(authorityPath, 'redirect')
    await fs.mkdir(target)
    runPowerShell(
      String.raw`
$ErrorActionPreference = 'Stop'
$junction = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_JUNCTION')
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
`,
      { EVENFIRE_ACL_TEST_JUNCTION: junction, EVENFIRE_ACL_TEST_TARGET: target }
    )

    expect(() => verifyWindowsSessionAuthorityDirectory(userDataPath, authorityPath)).toThrow(
      'Windows session authority ACL verification failed'
    )
  })

  it('rejects a reparse-point user-data parent', async () => {
    const alias = path.join(temporaryRoot, 'user-data-alias')
    runPowerShell(
      String.raw`
$ErrorActionPreference = 'Stop'
$junction = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_JUNCTION')
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_ACL_TEST_TARGET')
New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
`,
      { EVENFIRE_ACL_TEST_JUNCTION: alias, EVENFIRE_ACL_TEST_TARGET: userDataPath }
    )

    expect(() =>
      provisionWindowsSessionAuthorityDirectory(alias, path.join(alias, 'sessions'))
    ).toThrow('Windows session authority ACL verification failed')
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
