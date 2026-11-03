import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV,
  windowsSessionAuthorityNativeAssemblyPath,
} from './windowsSessionAuthorityNativeAssembly.js'
import { createWindowsSessionAuthorityPowerShellEnvironment } from './windowsSessionAuthorityPowerShellEnvironment.js'

export type WindowsSessionAuthorityAclEvidence = {
  userSid: string
  rootIdentity: string
  authorityIdentity: string
  objectCount: number
  authorityOwnerSid: string
}

type Request = { mode: 'provision' | 'verify'; userDataPath: string; authorityPath: string }

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  $script:phase = 'load-native-helper'
  [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=load-native-helper')
  [Console]::Error.Flush()
  $script:ownerClass = $null
  $script:aceClass = $null
  $script:aceMask = $null
  $script:aceInherited = $null
  $nativeAssemblyPath = [Environment]::GetEnvironmentVariable('EVENFIRE_SESSION_AUTHORITY_NATIVE_ASSEMBLY')
  if (-not $nativeAssemblyPath) { throw 'native-helper-path-missing' }
  Add-Type -Path $nativeAssemblyPath -ErrorAction Stop
  $script:phase = 'validate-request'
  [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=validate-request')
  [Console]::Error.Flush()
  $requestPayload = [Environment]::GetEnvironmentVariable('EVENFIRE_SESSION_AUTHORITY_ACL_REQUEST')
  if (-not $requestPayload) { throw 'request-missing' }
  $requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($requestPayload))
  $request = $requestJson | ConvertFrom-Json
  function Normalize-Path([string]$value) {
    if ($value.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
      $value = '\\' + $value.Substring(8)
    } elseif ($value.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
      $value = $value.Substring(4)
    }
    $full = [IO.Path]::GetFullPath($value)
    $pathRoot = [IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $pathRoot.Length) { return $full.TrimEnd('\') }
    return $full
  }
  $root = Normalize-Path ([string]$request.userDataPath)
  $authority = Normalize-Path ([string]$request.authorityPath)
  if ([string]::Compare($authority, [IO.Path]::Combine($root, 'sessions'), $true) -ne 0) {
    throw 'authority-path-invalid'
  }
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $systemSid = 'S-1-5-18'
  $administratorsSid = 'S-1-5-32-544'
  $authenticatedUsersSid = 'S-1-5-11'
  $trustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  $allowed = @($currentSid, $systemSid, $administratorsSid)
  $mutatingMask = [uint32](0x00000002 -bor 0x00000004 -bor 0x00000010 -bor 0x00000040 -bor 0x00000100 -bor 0x00010000 -bor 0x00040000 -bor 0x00080000)
  $volumeRootCreateMask = [uint32](0x00000002 -bor 0x00000004)
  $otherRootMutationMask = [uint32]($mutatingMask -band 0xFFFFFFF9)
  $traverseMask = [uint32](0x00000020 -bor 0x00000080)
  $createChildMask = [uint32](0x00000004 -bor 0x00000020 -bor 0x00000080)
  $privateMask = [uint32]0x001F01FF
  function Inspect-Object([string]$objectPath, [bool]$expectDirectory) {
    $script:phase = 'inspect-native-object'
    $snapshot = [SessionAuthorityNative]::Inspect($objectPath)
    $expected = Normalize-Path $objectPath
    if ($snapshot.IsReparsePoint -or ($snapshot.IsDirectory -ne $expectDirectory) -or
      [string]::Compare((Normalize-Path $snapshot.FinalPath), $expected, $true) -ne 0) {
      throw 'path-identity-invalid'
    }
    if (-not $snapshot.DaclPresent -or $snapshot.Aces.Count -eq 0) { throw 'dacl-invalid' }
    return $snapshot
  }
  function Test-Owner([string]$sid, [bool]$privateObject, [bool]$isVolumeRoot) {
    if ($privateObject) { return $allowed -contains $sid }
    return ($allowed -contains $sid) -or ($isVolumeRoot -and $sid -eq $trustedInstallerSid)
  }
  function Get-OwnerClass([string]$sid) {
    if ($sid -eq $currentSid) { return 'current-user' }
    if ($sid -eq $systemSid) { return 'system' }
    if ($sid -eq $administratorsSid) { return 'administrators' }
    if ($sid -eq $trustedInstallerSid) { return 'trusted-installer' }
    if ($sid -eq 'S-1-1-0') { return 'everyone' }
    if ($sid -eq 'S-1-5-11') { return 'authenticated-users' }
    if ($sid -eq 'S-1-5-32-545') { return 'builtin-users' }
    if ($sid -eq 'S-1-5-4') { return 'interactive' }
    if ($sid -eq 'S-1-3-0') { return 'creator-owner' }
    return 'other'
  }
  function Test-PrincipalRules(
    $snapshot,
    [bool]$privateObject,
    [string]$policyPhase,
    [bool]$isVolumeRoot = $false
  ) {
    $script:phase = $policyPhase
    if (-not (Test-Owner $snapshot.OwnerSid $privateObject $isVolumeRoot)) {
      $script:ownerClass = Get-OwnerClass $snapshot.OwnerSid
      throw 'owner-invalid'
    }
    $present = @{}
    foreach ($ace in $snapshot.Aces) {
      if ($ace.Qualifier -notin @('AccessAllowed', 'AccessDenied')) { throw 'ace-invalid' }
      if ($privateObject -and
        ($ace.Qualifier -ne 'AccessAllowed' -or $ace.InheritOnly)) { throw 'ace-invalid' }
      if ($privateObject -and ($allowed -notcontains $ace.Sid)) { throw 'principal-invalid' }
      if (-not $privateObject -and $ace.Qualifier -eq 'AccessAllowed' -and
        -not $ace.InheritOnly -and (($ace.Mask -band $mutatingMask) -ne 0)) {
        $trustedAncestorAce = $ace.Sid -eq $trustedInstallerSid -and
          ($isVolumeRoot -or $ace.Inherited)
        $authenticatedUsersCreateOnlyAtRoot = $isVolumeRoot -and
          $ace.Sid -eq $authenticatedUsersSid -and
          (($ace.Mask -band $volumeRootCreateMask) -ne 0) -and
          (($ace.Mask -band $otherRootMutationMask) -eq 0)
        if (($allowed -notcontains $ace.Sid) -and -not $trustedAncestorAce -and
          -not $authenticatedUsersCreateOnlyAtRoot) {
          $script:aceClass = Get-OwnerClass $ace.Sid
          $script:aceMask = [uint32]$ace.Mask
          $script:aceInherited = [bool]$ace.Inherited
          throw 'ancestor-writable-by-other-principal'
        }
      }
      if ($privateObject -and $ace.Qualifier -eq 'AccessAllowed') {
        if (($ace.Mask -band $privateMask) -ne $privateMask) { throw 'private-rights-incomplete' }
        $present[$ace.Sid] = $true
      }
    }
    if ($privateObject) {
      foreach ($sid in $allowed) { if (-not $present.ContainsKey($sid)) { throw 'principal-missing' } }
    }
  }
  function Test-CurrentEffectiveAccess($snapshot, [uint32]$required) {
    $script:phase = 'validate-effective-access'
    if (($snapshot.EffectiveAccess -band $required) -ne $required) { throw 'effective-access-insufficient' }
  }
  function New-PrivateAcl([bool]$isDirectory) {
    if ($isDirectory) { $security = [System.Security.AccessControl.DirectorySecurity]::new() }
    else { $security = [System.Security.AccessControl.FileSecurity]::new() }
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([System.Security.Principal.SecurityIdentifier]::new($currentSid))
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($isDirectory) {
      $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    foreach ($sid in $allowed) {
      $principal = [System.Security.Principal.SecurityIdentifier]::new($sid)
      if ($isDirectory) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      } else {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
      }
      $security.AddAccessRule($rule)
    }
    return $security
  }
  function Test-Ancestry([string]$start, [bool]$isUserData) {
    $script:phase = 'validate-user-data-ancestry'
    $current = [IO.DirectoryInfo]::new($start)
    $depth = 0
    while ($null -ne $current) {
      $snapshot = Inspect-Object $current.FullName $true
      $isVolumeRoot = $current.Parent -eq $null
      Test-PrincipalRules $snapshot $false ("validate-ancestor-owner-depth-" + $depth) $isVolumeRoot
      $required = $traverseMask
      if ($isUserData -and [string]::Compare($current.FullName, $root, $true) -eq 0) { $required = $createChildMask }
      Test-CurrentEffectiveAccess $snapshot $required
      if ($current.Parent -eq $null) { break }
      $current = $current.Parent
      $depth += 1
    }
  }
  function Test-PrivateTree([string]$directoryPath) {
    $script:phase = 'validate-authority-tree'
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($directoryPath)
    $count = 0
    while ($pending.Count -gt 0) {
      $currentPath = $pending.Pop()
      $isDirectory = [IO.Directory]::Exists($currentPath)
      $snapshot = Inspect-Object $currentPath $isDirectory
      Test-PrincipalRules $snapshot $true 'validate-authority-tree-object-acl'
      Test-CurrentEffectiveAccess $snapshot $privateMask
      $count += 1
      if ($count -gt 4096) { throw 'authority-tree-over-capacity' }
      if ($isDirectory) {
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($currentPath)) { $pending.Push($entry) }
      }
    }
    return $count
  }
  $script:phase = 'validate-user-data-ancestry'
  [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=validate-user-data-ancestry')
  [Console]::Error.Flush()
  Test-Ancestry $root $true
  $script:phase = 'validate-user-data-root'
  [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=validate-user-data-root')
  [Console]::Error.Flush()
  $rootBefore = Inspect-Object $root $true
  Test-PrincipalRules $rootBefore $false 'validate-user-data-root-acl'
  Test-CurrentEffectiveAccess $rootBefore $createChildMask
  $stagedAuthorityIdentity = $null
  if (-not [SessionAuthorityNative]::EntryExists($authority)) {
    $script:phase = 'provision-authority-directory'
    [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=provision-authority-directory')
    [Console]::Error.Flush()
    if ($request.mode -ne 'provision') { throw 'authority-directory-absent' }
    $staging = Join-Path $root ('.evenfire-session-authority-' + [Guid]::NewGuid().ToString('N'))
    try {
      $directoryInfo = [IO.DirectoryInfo]::new($staging)
      $directoryInfo.Create((New-PrivateAcl $true))
      [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=set-authority-owner')
      [Console]::Error.Flush()
      [SessionAuthorityNative]::SetOwner($staging, $currentSid)
      $script:phase = 'validate-staged-authority'
      [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=validate-staged-authority')
      [Console]::Error.Flush()
      $stagingSnapshot = Inspect-Object $staging $true
      if ($stagingSnapshot.OwnerSid -ne $currentSid) { throw 'staging-owner-invalid' }
      if (-not $stagingSnapshot.DaclProtected) { throw 'staging-dacl-inherited' }
      Test-PrincipalRules $stagingSnapshot $true 'validate-staged-authority-acl'
      Test-CurrentEffectiveAccess $stagingSnapshot $privateMask
      $stagedAuthorityIdentity = $stagingSnapshot.Identity
      $script:phase = 'publish-authority-directory-write-through'
      [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=publish-authority-directory-write-through')
      [Console]::Error.Flush()
      $moveError = [SessionAuthorityNative]::PublishDirectoryWriteThrough($staging, $authority)
      if ($moveError -ne 0) { throw ('authority-directory-publication-' + $moveError) }
    } finally {
      if ([IO.Directory]::Exists($staging)) { [IO.Directory]::Delete($staging, $false) }
    }
  }
  $script:phase = 'validate-authority-directory'
  [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=validate-authority-directory')
  [Console]::Error.Flush()
  $authoritySnapshot = Inspect-Object $authority $true
  $script:phase = 'validate-published-authority-identity'
  [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=validate-published-authority-identity')
  [Console]::Error.Flush()
  if ($null -ne $stagedAuthorityIdentity -and
    ($authoritySnapshot.Identity -ne $stagedAuthorityIdentity -or
      $authoritySnapshot.OwnerSid -ne $currentSid)) {
    throw 'published-authority-identity-invalid'
  }
  if (-not $authoritySnapshot.DaclProtected) { throw 'authority-dacl-inherited' }
  Test-PrincipalRules $authoritySnapshot $true 'validate-authority-directory-acl'
  Test-CurrentEffectiveAccess $authoritySnapshot $privateMask
  [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=validate-authority-tree')
  [Console]::Error.Flush()
  $objectCount = Test-PrivateTree $authority
  $script:phase = 'revalidate-user-data-root'
  [Console]::Error.WriteLine('EVENFIRE_ACL_PHASE=revalidate-user-data-root')
  [Console]::Error.Flush()
  $rootSnapshot = Inspect-Object $root $true
  if ($rootSnapshot.Identity -ne $rootBefore.Identity -or
    [string]::Compare($rootSnapshot.FinalPath, $rootBefore.FinalPath, $true) -ne 0) {
    throw 'root-identity-changed'
  }
  [ordered]@{
    ok = $true
    userSid = $currentSid
    rootIdentity = $rootSnapshot.Identity
    authorityIdentity = $authoritySnapshot.Identity
    authorityOwnerSid = $authoritySnapshot.OwnerSid
    objectCount = $objectCount
  } | ConvertTo-Json -Compress
  exit 0
} catch {
  $message = [string]$_.Exception.Message
  $detail = if ($message -match '^[A-Za-z0-9-]{1,80}$') { $message } else { $null }
  $innerException = $_.Exception.InnerException
  while ($innerException -and $innerException.InnerException) {
    $innerException = $innerException.InnerException
  }
  [ordered]@{
    ok = $false
    code = 'windows-acl-verification-failed'
    phase = [string]$script:phase
    errorType = $_.Exception.GetType().Name
    hresult = ('0x{0:X8}' -f $_.Exception.HResult)
    detail = $detail
    innerErrorType = if ($innerException) { $innerException.GetType().Name } else { $null }
    innerHresult = if ($innerException) { '0x{0:X8}' -f $innerException.HResult } else { $null }
    innerNativeOperation = if ($innerException) { $innerException.Data['sessionAuthorityOperation'] } else { $null }
    innerNativeErrorCode = if ($innerException -is [ComponentModel.Win32Exception]) { $innerException.NativeErrorCode } else { $null }
    ownerClass = $script:ownerClass
    aceClass = $script:aceClass
    aceWriteContent = if ($null -ne $script:aceMask) { ($script:aceMask -band 0x00000006) -ne 0 } else { $null }
    aceDeleteChild = if ($null -ne $script:aceMask) { ($script:aceMask -band 0x00000040) -ne 0 } else { $null }
    aceDelete = if ($null -ne $script:aceMask) { ($script:aceMask -band 0x00010000) -ne 0 } else { $null }
    aceWriteDacl = if ($null -ne $script:aceMask) { ($script:aceMask -band 0x00040000) -ne 0 } else { $null }
    aceTakeOwnership = if ($null -ne $script:aceMask) { ($script:aceMask -band 0x00080000) -ne 0 } else { $null }
    aceWriteMetadata = if ($null -ne $script:aceMask) { ($script:aceMask -band 0x00000110) -ne 0 } else { $null }
    aceInherited = $script:aceInherited
  } | ConvertTo-Json -Compress
  exit 2
}
`

const POWERSHELL_REQUEST = 'EVENFIRE_SESSION_AUTHORITY_ACL_REQUEST'
const POWERSHELL_LAUNCHER =
  '$sourceText = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($sourceText))'
const POWERSHELL_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  POWERSHELL_LAUNCHER,
] as const

function sanitizedWindowsAclFailure(stdout: string): {
  rejected: boolean
  fields: Record<string, string | number | boolean>
} {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    if (typeof value !== 'object' || value === null) return { rejected: false, fields: {} }
    const fields = value as Record<string, unknown>
    const safe: Record<string, string | number | boolean> = {}
    for (const field of [
      'phase',
      'errorType',
      'hresult',
      'detail',
      'innerErrorType',
      'innerHresult',
      'innerNativeOperation',
      'innerNativeErrorCode',
      'ownerClass',
      'aceClass',
      'aceWriteContent',
      'aceDeleteChild',
      'aceDelete',
      'aceWriteDacl',
      'aceTakeOwnership',
      'aceWriteMetadata',
      'aceInherited',
    ] as const) {
      const item = fields[field]
      if (field === 'innerNativeErrorCode') {
        if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 0xffff) {
          safe[field] = item
        }
        continue
      }
      if (field === 'ownerClass' || field === 'aceClass') {
        if (
          [
            'current-user',
            'system',
            'administrators',
            'trusted-installer',
            'everyone',
            'authenticated-users',
            'builtin-users',
            'interactive',
            'creator-owner',
            'other',
          ].includes(item as string)
        ) {
          safe[field] = item as string
        }
        continue
      }
      if (
        field === 'aceWriteContent' ||
        field === 'aceDeleteChild' ||
        field === 'aceDelete' ||
        field === 'aceWriteDacl' ||
        field === 'aceTakeOwnership' ||
        field === 'aceWriteMetadata' ||
        field === 'aceInherited'
      ) {
        if (typeof item === 'boolean') safe[field] = item
        continue
      }
      if (typeof item !== 'string') continue
      const pattern = /hresult$/i.test(field) ? /^0x[0-9A-F]{8}$/i : /^[A-Za-z0-9-]{1,80}$/
      if (pattern.test(item)) safe[field] = item
    }
    return { rejected: fields.ok === false, fields: safe }
  } catch {
    return { rejected: false, fields: {} }
  }
}

function sanitizedVerifierExecutionPhase(stderr: string): string | undefined {
  const allowed = new Set([
    'load-native-helper',
    'validate-request',
    'validate-user-data-ancestry',
    'validate-user-data-root',
    'provision-authority-directory',
    'set-authority-owner',
    'validate-staged-authority',
    'publish-authority-directory-write-through',
    'validate-published-authority-identity',
    'validate-authority-directory',
    'validate-authority-tree',
    'revalidate-user-data-root',
  ])
  const matches = stderr.matchAll(/(?:^|\r?\n)EVENFIRE_ACL_PHASE=([A-Za-z0-9-]{1,80})(?=\r?\n|$)/g)
  let phase: string | undefined
  for (const match of matches) {
    if (allowed.has(match[1]!)) phase = match[1]
  }
  return phase
}

function safePowerShellFailure(result: SpawnSyncReturns<string>, fallbackPhase: string): string {
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const stderrPresent = stderr.length > 0
  const stdoutPresent = stdout.length > 0
  const verifierFailure = sanitizedWindowsAclFailure(stdout)
  const executionPhase = sanitizedVerifierExecutionPhase(stderr)
  const processStarted = typeof result.pid === 'number' && result.pid > 0
  const processError = result.error as NodeJS.ErrnoException | undefined
  const errorCode = processError?.code
  const signal = result.signal
  let phase = fallbackPhase

  if (processError) {
    phase = processStarted ? 'process-error-after-start' : 'process-launch'
  } else if (signal) {
    phase = 'process-terminated'
  } else if (verifierFailure.rejected) {
    phase =
      verifierFailure.fields.phase === 'load-native-helper'
        ? 'powershell-native-helper-load-failed'
        : 'acl-verifier-rejected'
  } else if (result.status !== 0) {
    phase = 'powershell-exit-without-rejection-evidence'
  } else if (!stdoutPresent) {
    phase = 'structured-output-missing'
  }

  const diagnostic: Record<string, string | number | boolean | null> = {
    phase,
    processStarted,
    exitStatus: Number.isInteger(result.status) ? result.status : null,
    stdoutPresent,
    stderrPresent,
  }
  if (typeof errorCode === 'string' && /^[A-Z0-9_]{1,32}$/.test(errorCode)) {
    diagnostic.processErrorCode = errorCode
  }
  if (executionPhase) diagnostic.verifierExecutionPhase = executionPhase
  if (
    typeof signal === 'string' &&
    ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK'].includes(signal)
  ) {
    diagnostic.signal = signal
  }
  for (const field of [
    'phase',
    'errorType',
    'hresult',
    'detail',
    'innerErrorType',
    'innerHresult',
    'innerNativeOperation',
    'innerNativeErrorCode',
    'ownerClass',
    'aceClass',
    'aceWriteContent',
    'aceDeleteChild',
    'aceDelete',
    'aceWriteDacl',
    'aceTakeOwnership',
    'aceWriteMetadata',
    'aceInherited',
  ] as const) {
    const value = verifierFailure.fields[field]
    if (value !== undefined)
      diagnostic[`verifier${field[0]!.toUpperCase()}${field.slice(1)}`] = value
  }
  return `: ${JSON.stringify(diagnostic)}`
}

function assertWindowsPlatform(): void {
  if (process.platform !== 'win32') throw new Error('Windows session authority ACL is unsupported')
}

function runWindowsAclOperation(request: Request): WindowsSessionAuthorityAclEvidence {
  assertWindowsPlatform()
  const systemRoot = process.env.SystemRoot
  const temporaryDirectory = process.env.TEMP ?? process.env.TMP
  if (
    !systemRoot ||
    !temporaryDirectory ||
    !path.win32.isAbsolute(systemRoot) ||
    !path.win32.isAbsolute(temporaryDirectory)
  )
    throw new Error('Windows session authority ACL verifier is unavailable')
  const powershell = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  const result = spawnSync(powershell, [...POWERSHELL_ARGS], {
    encoding: 'utf8',
    env: {
      ...createWindowsSessionAuthorityPowerShellEnvironment(systemRoot, temporaryDirectory),
      [WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV]: windowsSessionAuthorityNativeAssemblyPath(),
      [POWERSHELL_REQUEST]: payload,
    },
    input: SCRIPT,
    maxBuffer: 1024 * 1024,
    // The native helper is built once for this source version; verification remains bounded.
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || result.signal || !result.stdout) {
    throw new Error(
      `Windows session authority ACL verification failed${safePowerShellFailure(result, 'verifier-exit')}`
    )
  }
  let response: unknown
  try {
    response = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error(
      `Windows session authority ACL verification returned invalid evidence${safePowerShellFailure(result, 'structured-output-invalid')}`
    )
  }
  if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true)
    throw new Error(
      `Windows session authority ACL verification failed${safePowerShellFailure(result, 'verifier-rejected')}`
    )
  const evidence = response as Partial<WindowsSessionAuthorityAclEvidence> & { ok: boolean }
  if (
    typeof evidence.userSid !== 'string' ||
    !/^S-1-/.test(evidence.userSid) ||
    typeof evidence.rootIdentity !== 'string' ||
    typeof evidence.authorityIdentity !== 'string' ||
    typeof evidence.objectCount !== 'number' ||
    evidence.objectCount < 1 ||
    typeof evidence.authorityOwnerSid !== 'string' ||
    !/^S-1-/.test(evidence.authorityOwnerSid)
  )
    throw new Error(
      `Windows session authority ACL verification returned incomplete evidence${safePowerShellFailure(result, 'evidence-incomplete')}`
    )
  return {
    userSid: evidence.userSid,
    rootIdentity: evidence.rootIdentity,
    authorityIdentity: evidence.authorityIdentity,
    objectCount: evidence.objectCount,
    authorityOwnerSid: evidence.authorityOwnerSid,
  }
}

/** Provision only a newly created authority directory, then inspect it and every child via Win32. */
export function provisionWindowsSessionAuthorityDirectory(
  userDataPath: string,
  authorityPath: string
): WindowsSessionAuthorityAclEvidence {
  return runWindowsAclOperation({ mode: 'provision', userDataPath, authorityPath })
}

/** Re-read the actual Windows security descriptors and effective access without cached evidence. */
export function verifyWindowsSessionAuthorityDirectory(
  userDataPath: string,
  authorityPath: string
): WindowsSessionAuthorityAclEvidence {
  return runWindowsAclOperation({ mode: 'verify', userDataPath, authorityPath })
}
