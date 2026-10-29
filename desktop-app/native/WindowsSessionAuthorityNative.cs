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
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true,
    EntryPoint = "MoveFileExW")]
  static extern bool MoveFileExW(string source, string destination, uint flags);
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

  public static int PublishDirectoryWriteThrough(string source, string destination) {
    return MoveFileExW(source, destination, 0x00000008) ? 0 : Marshal.GetLastWin32Error();
  }
}

public static class EvenfireSessionAuthorityMove {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true,
    EntryPoint = "MoveFileExW")]
  static extern bool MoveFileEx(string source, string destination, uint flags);
  public static int Move(string source, string destination, uint flags) {
    return MoveFileEx(source, destination, flags) ? 0 : Marshal.GetLastWin32Error();
  }
}
