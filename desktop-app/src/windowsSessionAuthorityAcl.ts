import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import path from 'node:path'

export type WindowsSessionAuthorityAclEvidence = {
  userSid: string
  rootIdentity: string
  authorityIdentity: string
  objectCount: number
}

type Request = { mode: 'provision' | 'verify'; userDataPath: string; authorityPath: string }

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$code = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public sealed class SessionAuthorityAce {
  public string Sid { get; set; }
  public string Qualifier { get; set; }
  public uint Mask { get; set; }
  public bool Inherited { get; set; }
  public bool InheritOnly { get; set; }
}

public sealed class SessionAuthorityObject {
  public string FinalPath { get; set; }
  public string OwnerSid { get; set; }
  public string Identity { get; set; }
  public bool IsDirectory { get; set; }
  public bool IsReparsePoint { get; set; }
  public bool DaclPresent { get; set; }
  public bool DaclProtected { get; set; }
  public uint EffectiveAccess { get; set; }
  public uint LinkCount { get; set; }
  public SessionAuthorityAce[] Aces { get; set; }
}

public static class SessionAuthorityNative {
  const uint ReadControl = 0x00020000;
  const uint WriteOwner = 0x00080000;
  const uint FileReadAttributes = 0x00000080;
  const uint ShareAll = 0x00000001 | 0x00000002 | 0x00000004;
  const uint OpenExisting = 3;
  const uint BackupSemantics = 0x02000000;
  const uint OpenReparsePoint = 0x00200000;
  const uint MaxAllowed = 0x02000000;
  const int SeFileObject = 1;
  const uint OwnerSecurityInformation = 0x00000001;
  const uint GroupSecurityInformation = 0x00000002;
  const uint DaclSecurityInformation = 0x00000004;
  const uint FileGenericRead = 0x00120089;
  const uint FileGenericWrite = 0x00120116;
  const uint FileGenericExecute = 0x001200A0;
  const uint FileGenericAll = 0x001F01FF;
  const uint FileAttributeDirectory = 0x00000010;
  const uint FileAttributeReparsePoint = 0x00000400;
  const uint InvalidFileAttributes = 0xFFFFFFFF;
  const uint MutatingRights = 0x00000002 | 0x00000004 | 0x00000010 | 0x00000040 |
    0x00000100 | 0x00010000 | 0x00040000 | 0x00080000;
  const uint DaclProtectedFlag = 0x1000;
  const uint TokenQuery = 0x0008;
  const uint TokenDuplicate = 0x0002;

  static System.ComponentModel.Win32Exception NativeError(string operation, int errorCode) {
    var exception = new System.ComponentModel.Win32Exception(errorCode);
    exception.Data["sessionAuthorityOperation"] = operation;
    return exception;
  }

  static System.ComponentModel.Win32Exception NativeError(string operation) {
    return NativeError(operation, Marshal.GetLastWin32Error());
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ByHandleFileInformation {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct GenericMapping {
    public uint GenericRead;
    public uint GenericWrite;
    public uint GenericExecute;
    public uint GenericAll;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint length,
    uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", EntryPoint = "CloseHandle", SetLastError = true)]
  static extern bool CloseHandleToken(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint securityInfo,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl,
    out IntPtr securityDescriptor);
  [DllImport("advapi32.dll")]
  static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint securityInfo,
    IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control,
    out uint revision);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AccessCheck(IntPtr descriptor, IntPtr token, uint desired,
    ref GenericMapping mapping, IntPtr privileges, ref uint privilegesLength,
    out uint granted, out bool status);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  static uint MapMask(int raw) {
    uint mask = unchecked((uint)raw);
    uint result = mask & ~0xF0000000U;
    if ((mask & 0x80000000U) != 0) result |= FileGenericRead;
    if ((mask & 0x40000000U) != 0) result |= FileGenericWrite;
    if ((mask & 0x20000000U) != 0) result |= FileGenericExecute;
    if ((mask & 0x10000000U) != 0) result |= FileGenericAll;
    return result;
  }

  static string NormalizeFinalPath(string value) {
    if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
      value = "\\\\" + value.Substring(8);
    else if (value.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase))
      value = value.Substring(4);
    string full = System.IO.Path.GetFullPath(value);
    string root = System.IO.Path.GetPathRoot(full);
    return full.Length > root.Length ? full.TrimEnd('\\') : full;
  }

  static string FinalPath(IntPtr handle) {
    var buffer = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
    if (length == 0 || length >= buffer.Capacity)
      throw NativeError("final-path");
    return NormalizeFinalPath(buffer.ToString());
  }

  static uint EffectiveMask(IntPtr descriptor) {
    IntPtr processToken = IntPtr.Zero;
    IntPtr impersonationToken = IntPtr.Zero;
    IntPtr privileges = IntPtr.Zero;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenDuplicate, out processToken))
        throw NativeError("open-process-token");
      if (!DuplicateToken(processToken, 2, out impersonationToken))
        throw NativeError("duplicate-token");
      privileges = Marshal.AllocHGlobal(4096);
      uint privilegeLength = 4096;
      uint granted;
      bool status;
      var mapping = new GenericMapping {
        GenericRead = FileGenericRead,
        GenericWrite = FileGenericWrite,
        GenericExecute = FileGenericExecute,
        GenericAll = FileGenericAll
      };
      if (!AccessCheck(descriptor, impersonationToken, MaxAllowed, ref mapping, privileges,
        ref privilegeLength, out granted, out status))
        throw NativeError("access-check");
      if (!status) throw new UnauthorizedAccessException();
      return granted;
    } finally {
      if (privileges != IntPtr.Zero) Marshal.FreeHGlobal(privileges);
      if (impersonationToken != IntPtr.Zero) CloseHandleToken(impersonationToken);
      if (processToken != IntPtr.Zero) CloseHandleToken(processToken);
    }
  }

  public static SessionAuthorityObject Inspect(string path) {
    IntPtr handle = IntPtr.Zero;
    IntPtr descriptor = IntPtr.Zero;
    try {
      handle = CreateFileW(path, ReadControl | FileReadAttributes, ShareAll, IntPtr.Zero,
        OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
      if (handle == new IntPtr(-1))
        throw NativeError("open-object");
      ByHandleFileInformation info;
      if (!GetFileInformationByHandle(handle, out info))
        throw NativeError("file-information");
      bool isDirectory = (info.FileAttributes & FileAttributeDirectory) != 0;
      if (!isDirectory && info.NumberOfLinks != 1)
        throw new InvalidOperationException("Session authority files must not have hard links");
      IntPtr owner, group, dacl, sacl;
      uint error = GetSecurityInfo(handle, SeFileObject,
        OwnerSecurityInformation | GroupSecurityInformation | DaclSecurityInformation,
        out owner, out group,
        out dacl, out sacl, out descriptor);
      if (error != 0) throw NativeError("get-security-info", (int)error);
      ushort control;
      uint revision;
      if (!GetSecurityDescriptorControl(descriptor, out control, out revision))
        throw NativeError("security-descriptor-control");
      uint actualLength = GetSecurityDescriptorLength(descriptor);
      if (actualLength == 0 || actualLength > 1024 * 1024)
        throw new InvalidOperationException();
      var bytes = new byte[(int)actualLength];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var raw = new RawSecurityDescriptor(bytes, 0);
      if (raw.Owner == null || raw.Group == null)
        throw new InvalidOperationException("security-descriptor-owner-group-missing");
      var aces = new List<SessionAuthorityAce>();
      if (raw.DiscretionaryAcl != null) {
        foreach (GenericAce ace in raw.DiscretionaryAcl) {
          var qualified = ace as QualifiedAce;
          if (qualified == null || qualified.IsCallback ||
              (!(ace is CommonAce) && !(ace is ObjectAce))) {
            aces.Add(new SessionAuthorityAce {
              Sid = "<unsupported>", Qualifier = "Unsupported", Mask = UInt32.MaxValue,
              Inherited = (ace.AceFlags & AceFlags.Inherited) != 0,
              InheritOnly = (ace.AceFlags & AceFlags.InheritOnly) != 0
            });
          } else {
            aces.Add(new SessionAuthorityAce {
              Sid = qualified.SecurityIdentifier.Value,
              Qualifier = qualified.AceQualifier.ToString(),
              Mask = MapMask(qualified.AccessMask),
              Inherited = (qualified.AceFlags & AceFlags.Inherited) != 0,
              InheritOnly = (qualified.AceFlags & AceFlags.InheritOnly) != 0
            });
          }
        }
      }
      string identity = info.VolumeSerialNumber.ToString("X8") + ":" +
        info.FileIndexHigh.ToString("X8") + info.FileIndexLow.ToString("X8");
      return new SessionAuthorityObject {
        FinalPath = FinalPath(handle),
        OwnerSid = raw.Owner == null ? "" : raw.Owner.Value,
        Identity = identity,
        IsDirectory = isDirectory,
        IsReparsePoint = (info.FileAttributes & FileAttributeReparsePoint) != 0,
        DaclPresent = (raw.ControlFlags & ControlFlags.DiscretionaryAclPresent) != 0,
        DaclProtected = (control & DaclProtectedFlag) != 0,
        EffectiveAccess = EffectiveMask(descriptor),
        LinkCount = info.NumberOfLinks,
        Aces = aces.ToArray()
      };
    } finally {
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
      if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
    }
  }

  public static void SetOwner(string path, string ownerSid) {
    IntPtr handle = IntPtr.Zero;
    IntPtr owner = IntPtr.Zero;
    try {
      handle = CreateFileW(path, ReadControl | WriteOwner | FileReadAttributes, ShareAll,
        IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
      if (handle == new IntPtr(-1))
        throw NativeError("open-object-for-owner");
      var sid = new SecurityIdentifier(ownerSid);
      byte[] bytes = new byte[sid.BinaryLength];
      sid.GetBinaryForm(bytes, 0);
      owner = Marshal.AllocHGlobal(bytes.Length);
      Marshal.Copy(bytes, 0, owner, bytes.Length);
      uint error = SetSecurityInfo(handle, SeFileObject, OwnerSecurityInformation, owner,
        IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      if (error != 0) throw NativeError("set-owner", (int)error);
    } finally {
      if (owner != IntPtr.Zero) Marshal.FreeHGlobal(owner);
      if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
    }
  }

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

  public static bool EntryExists(string path) {
    uint attributes = GetFileAttributesW(path);
    if (attributes != InvalidFileAttributes) return true;
    int error = Marshal.GetLastWin32Error();
    if (error == 2 || error == 3) return false;
    throw NativeError("entry-exists", error);
  }
}
'@
try {
  $script:phase = 'compile-script'
  $script:ownerClass = $null
  $script:aceClass = $null
  $script:aceMask = $null
  $script:aceInherited = $null
  Add-Type -TypeDefinition $code -Language CSharp
  $script:phase = 'validate-request'
  $requestPayload = [Environment]::GetEnvironmentVariable('EVENFIRE_SESSION_AUTHORITY_ACL_REQUEST')
  if (-not $requestPayload) { throw 'request-missing' }
  $requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($requestPayload))
  $request = $requestJson | ConvertFrom-Json
  function Normalize-Path([string]$value) {
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
    if ($privateObject) { return $sid -eq $currentSid }
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
  Test-Ancestry $root $true
  $script:phase = 'validate-user-data-root'
  $rootBefore = Inspect-Object $root $true
  Test-PrincipalRules $rootBefore $false 'validate-user-data-root-acl'
  Test-CurrentEffectiveAccess $rootBefore $createChildMask
  if (-not [SessionAuthorityNative]::EntryExists($authority)) {
    $script:phase = 'provision-authority-directory'
    if ($request.mode -ne 'provision') { throw 'authority-directory-absent' }
    $directoryInfo = [IO.DirectoryInfo]::new($authority)
    $directoryInfo.Create((New-PrivateAcl $true))
    [SessionAuthorityNative]::SetOwner($authority, $currentSid)
  }
  $authoritySnapshot = Inspect-Object $authority $true
  $script:phase = 'validate-authority-directory'
  if (-not $authoritySnapshot.DaclProtected) { throw 'authority-dacl-inherited' }
  Test-PrincipalRules $authoritySnapshot $true 'validate-authority-directory-acl'
  Test-CurrentEffectiveAccess $authoritySnapshot $privateMask
  $objectCount = Test-PrivateTree $authority
  $script:phase = 'revalidate-user-data-root'
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

function safePowerShellFailure(result: SpawnSyncReturns<string>, fallbackPhase: string): string {
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderrPresent = typeof result.stderr === 'string' && result.stderr.length > 0
  const stdoutPresent = stdout.length > 0
  const verifierFailure = sanitizedWindowsAclFailure(stdout)
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
      verifierFailure.fields.phase === 'compile-script'
        ? 'powershell-compilation-failed'
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
  if (!systemRoot) throw new Error('Windows session authority ACL verifier is unavailable')
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  const result = spawnSync(powershell, [...POWERSHELL_ARGS], {
    encoding: 'utf8',
    env: { ...process.env, [POWERSHELL_REQUEST]: payload },
    input: SCRIPT,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
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
    evidence.objectCount < 1
  )
    throw new Error(
      `Windows session authority ACL verification returned incomplete evidence${safePowerShellFailure(result, 'evidence-incomplete')}`
    )
  return {
    userSid: evidence.userSid,
    rootIdentity: evidence.rootIdentity,
    authorityIdentity: evidence.authorityIdentity,
    objectCount: evidence.objectCount,
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
