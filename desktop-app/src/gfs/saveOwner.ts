import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

interface PosixGfsSaveNativeBridge {
  openDestination(filePath: string): unknown
  stagePath(session: unknown): string
  stageIdentity(session: unknown): string
  stageDirectoryPath(session: unknown): string
  stageDirectoryIdentity(session: unknown): string
  writeChunk(session: unknown, bytes: Buffer): number
  settleWriter(session: unknown, expectedLength: number): void
  publishNoReplace(session: unknown): boolean
  isPublished(session: unknown): boolean
  inspectFinal(session: unknown): string
  applyFinalMode(session: unknown, mode: number): number
  inspectFinalMode(session: unknown): number
  cleanupStage(session: unknown): void
  closeSession(session: unknown): void
}

interface WindowsGfsSaveNativeBridge {
  openDestination(filePath: string): unknown
  stagePath(session: unknown): string
  stageIdentity(session: unknown): string
  stageObservation(session: unknown): WindowsNativeStageObservation
  writeChunk(session: unknown, bytes: Buffer): number
  settleWriter(session: unknown, expectedLength: number): void
  publishNoReplace(session: unknown): boolean
  isPublished(session: unknown): boolean
  inspectFinal(session: unknown): string
  applyFinalAccess(session: unknown): void
  inspectFinalAccess(session: unknown): 'intended' | 'private' | 'unknown'
  cleanupStage(session: unknown): void
  closeSession(session: unknown): void
}

const posixGfsSaveNative =
  process.platform === 'darwin' || process.platform === 'linux'
    ? (require(
        path.join(__dirname, '../../native/build/Release/evenfire_gfs_save_bridge.node')
      ) as PosixGfsSaveNativeBridge)
    : undefined

const windowsGfsSaveNative =
  process.platform === 'win32'
    ? (require(
        path.join(__dirname, '../../native/build/Release/evenfire_gfs_save_bridge.node')
      ) as WindowsGfsSaveNativeBridge)
    : undefined

export type GfsSaveTerminalReceipt =
  | {
      status: 'saved_access_verified' | 'published_finalization_warning'
      uri: string
      version: number
      filePath: string
      stageCleanup: 'complete' | 'failed'
      residualStagePath?: string
      residualStageIdentity?: string
    }
  | {
      status: 'published_access_unverified'
      uri: string
      version: number
      filePath: string
      publication: 'confirmed_by_native_return'
      identity: 'verified' | 'unverified'
      access: 'verified_private' | 'unverified'
      stageCleanup: 'complete' | 'retained' | 'failed'
      residualStagePath?: string
      residualStageIdentity?: string
    }
  | {
      status: 'published_private_warning'
      uri: string
      version: number
      filePath: string
      publication: 'confirmed_by_native_return'
      identity: 'verified'
      access: 'verified_private'
      stageCleanup: 'complete' | 'retained' | 'failed'
      residualStagePath?: string
      residualStageIdentity?: string
    }
  | { status: 'cancelled_no_publication'; uri: string; filePath: null }
  | {
      status: 'failed_no_publication'
      uri: string
      version: number
      filePath: null
      stageCleanup: 'failed'
      residualStagePath: string
      residualStageIdentity: string
    }

export interface GfsSaveStage {
  stagePath: string
  filePath: string
  fileIdentity: string
  stageDirectory?: string
  stageDirectoryIdentity?: string
  /** Ordinary POSIX output mode selected from the main process umask. */
  intendedMode?: number
  nativeSession?: unknown
  /** Captured inherited Windows ACL, retained in memory until the auth-fenced publish. */
  windowsOriginalDacl?: string
  windowsOriginalDaclProtected?: boolean
}

type WindowsFinalAccessReadAttempt = 'primary' | 'reconciliation'

const WINDOWS_NATIVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$standardInput = [Console]::OpenStandardInput()
$header = New-Object System.IO.MemoryStream
while (($value = $standardInput.ReadByte()) -ge 0 -and $value -ne 10) { $header.WriteByte([byte]$value) }
$inputValue = [System.Text.Encoding]::UTF8.GetString($header.ToArray()) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Collections.Generic;
public static class EvenfireGfsSaveNative {
  public sealed class StageStart {
    public IntPtr Handle;
    public string OriginalDacl;
    public bool OriginalProtected;
    public Dictionary<string,object> Observation;
  }
  const uint GENERIC_WRITE=0x40000000, READ_CONTROL=0x00020000, WRITE_DAC=0x00040000;
  const uint DELETE=0x00010000, FILE_READ_ATTRIBUTES=0x00000080;
  const uint CREATE_NEW=1, OPEN_EXISTING=3;
  const uint FILE_ATTRIBUTE_HIDDEN=2, FILE_ATTRIBUTE_NORMAL=0x80;
  const uint FILE_FLAG_OPEN_REPARSE_POINT=0x00200000;
  const uint DACL_SECURITY_INFORMATION=0x00000004, PROTECTED_DACL_SECURITY_INFORMATION=0x80000000;
  const uint UNPROTECTED_DACL_SECURITY_INFORMATION=0x20000000;
  const int SE_FILE_OBJECT=1, FileDispositionInfo=4;
  const uint SE_DACL_PROTECTED=0x1000, FILE_ATTRIBUTE_REPARSE_POINT=0x400;
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access;
    public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow;
    public uint Links; public uint IndexHigh; public uint IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle,
    byte[] buffer, uint count, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(
    IntPtr handle, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool MoveFileW(string source, string destination);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool SetFileAttributesW(string name, uint attributes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(
    IntPtr handle, int infoClass, ref Disposition info, uint size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(
    IntPtr handle, int type, uint info, out IntPtr owner, out IntPtr group,
    out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorControl(
    IntPtr descriptor, out ushort control, out uint revision);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
    IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
    string text, uint revision, out IntPtr descriptor, out uint length);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint SetSecurityInfo(
    IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static Exception WinError(string operation) { return new System.ComponentModel.Win32Exception(
    Marshal.GetLastWin32Error(), operation); }
  static void Check(bool ok, string operation) { if (!ok) throw WinError(operation); }
  static string Identity(IntPtr handle) {
    FileInfo info; Check(GetFileInformationByHandle(handle, out info), "GetFileInformationByHandle");
    return info.Volume.ToString("X8") + ":" + info.IndexHigh.ToString("X8") + info.IndexLow.ToString("X8");
  }
  static string CaptureDacl(IntPtr handle, out bool wasProtected) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint status=GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
      out owner, out group, out dacl, out sacl, out descriptor);
    if (status != 0) throw new System.ComponentModel.Win32Exception((int)status, "GetSecurityInfo");
    if (dacl == IntPtr.Zero) { LocalFree(descriptor); throw new Exception("stage has no restorable DACL"); }
    try {
      ushort control; uint revision;
      Check(GetSecurityDescriptorControl(descriptor, out control, out revision), "GetSecurityDescriptorControl");
      wasProtected=(control & SE_DACL_PROTECTED) != 0;
      IntPtr text; uint length;
      Check(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1,
        DACL_SECURITY_INFORMATION, out text, out length), "ConvertSecurityDescriptorToStringSecurityDescriptorW");
      try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
    } finally { LocalFree(descriptor); }
  }
  static Dictionary<string,object> InspectRestrictedStage(IntPtr handle, string expectedOwner,
      bool requireEmpty=true) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint status=GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | 0x1,
      out owner, out group, out dacl, out sacl, out descriptor);
    if (status != 0) throw new System.ComponentModel.Win32Exception((int)status, "GetSecurityInfo(stage)");
    try {
      ushort control; uint revision;
      Check(GetSecurityDescriptorControl(descriptor, out control, out revision), "GetSecurityDescriptorControl(stage)");
      IntPtr text; uint length;
      Check(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1,
        DACL_SECURITY_INFORMATION, out text, out length), "ConvertSecurityDescriptorToStringSecurityDescriptorW(stage)");
      string sddl;
      try { sddl=Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
      var ownerSid=new SecurityIdentifier(owner).Value;
      FileInfo info; Check(GetFileInformationByHandle(handle, out info), "GetFileInformationByHandle(stage)");
      if (ownerSid != expectedOwner || sddl != "D:P(A;;FA;;;"+expectedOwner+")" ||
          (control & SE_DACL_PROTECTED) == 0 ||
          (requireEmpty && (info.SizeHigh != 0 || info.SizeLow != 0)) ||
          (info.Attributes & FILE_ATTRIBUTE_HIDDEN) == 0 ||
          (info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        throw new Exception("stage is not empty, hidden, owner-restricted and protected before writing");
      return new Dictionary<string,object>{{"ownerSid",ownerSid},{"daclSddl",sddl},
        {"daclProtected",true},{"length",((ulong)info.SizeHigh<<32)|info.SizeLow},
        {"hidden",true},{"identity",Identity(handle)}};
    } finally { LocalFree(descriptor); }
  }
  static void ApplyDacl(IntPtr handle, string sddl, bool protect) {
    IntPtr descriptor=IntPtr.Zero;
    try {
      uint length; Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1,
        out descriptor, out length), "ConvertStringSecurityDescriptorToSecurityDescriptorW");
      IntPtr dacl;
      bool present, defaulted;
      Check(GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted),
        "GetSecurityDescriptorDacl");
      if (!present || dacl == IntPtr.Zero) throw new Exception("replacement DACL is absent");
      uint flags=DACL_SECURITY_INFORMATION | (protect ? PROTECTED_DACL_SECURITY_INFORMATION : 0);
      if (!protect) flags |= UNPROTECTED_DACL_SECURITY_INFORMATION;
      uint result=SetSecurityInfo(handle, SE_FILE_OBJECT, flags, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (result != 0) throw new System.ComponentModel.Win32Exception((int)result, "SetSecurityInfo");
    } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
  }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(
    IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  public static StageStart BeginStage(string path) {
    IntPtr handle=CreateFileW(path, GENERIC_WRITE|READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES|DELETE,
      0, IntPtr.Zero, CREATE_NEW, FILE_ATTRIBUTE_HIDDEN, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw WinError("CreateFileW(CREATE_NEW)");
    try {
      bool originalProtected;
      string originalDacl=CaptureDacl(handle, out originalProtected);
      string ownerSid=WindowsIdentity.GetCurrent().User.Value;
      if (!System.Text.RegularExpressions.Regex.IsMatch(ownerSid, @"^S-1-[0-9-]+$"))
        throw new Exception("current owner SID is invalid");
      ApplyDacl(handle, "D:P(A;;FA;;;"+ownerSid+")", true);
      return new StageStart { Handle=handle, OriginalDacl=originalDacl,
        OriginalProtected=originalProtected, Observation=InspectRestrictedStage(handle, ownerSid) };
    } catch {
      Disposition disposition=new Disposition{Delete=true};
      try {
        Check(SetFileInformationByHandle(handle, FileDispositionInfo, ref disposition, 4),
          "SetFileInformationByHandle(delete failed stage)");
      } finally { CloseHandle(handle); }
      throw;
    }
  }
  public static Dictionary<string,object> CompleteStage(StageStart stage,
      string originalDacl, bool originalProtected, System.IO.Stream body, long expectedLength) {
    IntPtr handle=stage.Handle;
    bool restricted=true;
    try {
      byte[] buffer=new byte[65536]; long remaining=expectedLength;
      while (remaining > 0) {
        int count=body.Read(buffer,0,(int)Math.Min(buffer.Length,remaining));
        if (count <= 0) throw new Exception("stage body ended before its declared length");
        int offset=0;
        while (offset < count) {
          int chunkRemaining=count-offset; byte[] chunk=new byte[chunkRemaining];
          Array.Copy(buffer,offset,chunk,0,chunkRemaining);
          uint written; Check(WriteFile(handle,chunk,(uint)chunk.Length,out written,IntPtr.Zero),"WriteFile");
          if (written == 0) throw new Exception("short stage write");
          offset+=(int)written;
        }
        remaining-=count;
      }
      if (body.ReadByte() != -1) throw new Exception("stage body exceeded its declared length");
      Check(FlushFileBuffers(handle), "FlushFileBuffers");
      return new Dictionary<string,object>{{"identity",Identity(handle)},
        {"originalDacl",originalDacl},{"originalDaclProtected",originalProtected}};
    } catch {
      Disposition disposition=new Disposition{Delete=true};
      Check(SetFileInformationByHandle(handle, FileDispositionInfo, ref disposition, 4),
        "SetFileInformationByHandle(delete failed stage)");
      throw;
    }
  }
  public static void CloseStage(StageStart stage) { if (stage != null && stage.Handle != IntPtr.Zero) CloseHandle(stage.Handle); }
  static Dictionary<string,object> RunPublish(string stage, string destination, string expected,
      string originalDacl, bool originalProtected) {
    IntPtr handle=CreateFileW(stage, READ_CONTROL|WRITE_DAC|DELETE|FILE_READ_ATTRIBUTES,
      7, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw WinError("CreateFileW(open stage)");
    bool moved=false;
    bool inheritedDaclApplied=false;
    try {
      FileInfo info; Check(GetFileInformationByHandle(handle, out info), "GetFileInformationByHandle");
      if ((info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || Identity(handle) != expected)
        throw new Exception("stage identity changed");
      // Keep the stage owner-only while it waits for the auth queue. Restore its
      // inherited ACL only inside the synchronous final publication operation.
      var restricted=InspectRestrictedStage(handle, WindowsIdentity.GetCurrent().User.Value, false);
      if ((string)restricted["identity"] != expected) throw new Exception("stage identity changed");
      ApplyDacl(handle, originalDacl, originalProtected);
      inheritedDaclApplied=true;
      if (!MoveFileW(stage, destination)) throw WinError("MoveFileW(no replace)");
      moved=true;
      Check(SetFileAttributesW(destination, FILE_ATTRIBUTE_NORMAL), "SetFileAttributesW(published file)");
      return new Dictionary<string,object>{{"identity",expected}};
    } catch {
      if (moved) {
        Disposition disposition=new Disposition{Delete=true};
        try { SetFileInformationByHandle(handle, FileDispositionInfo, ref disposition, 4); } catch {}
      } else if (inheritedDaclApplied) {
        string ownerSid=WindowsIdentity.GetCurrent().User.Value;
        try { ApplyDacl(handle, "D:P(A;;FA;;;"+ownerSid+")", true); } catch {}
      }
      throw;
    } finally { CloseHandle(handle); }
  }
  static void RunCleanup(string stage, string expected) {
    IntPtr handle=CreateFileW(stage, DELETE|FILE_READ_ATTRIBUTES, 7, IntPtr.Zero,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == new IntPtr(-1)) { int error=Marshal.GetLastWin32Error(); if (error==2) return; throw WinError("CreateFileW(cleanup)"); }
    try {
      FileInfo info; Check(GetFileInformationByHandle(handle, out info), "GetFileInformationByHandle");
      if ((info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || Identity(handle) != expected)
        throw new Exception("refusing cleanup of a different stage object");
      Disposition disposition=new Disposition{Delete=true};
      Check(SetFileInformationByHandle(handle, FileDispositionInfo, ref disposition, 4), "SetFileInformationByHandle(delete)");
    } finally { CloseHandle(handle); }
  }
  public static object Run(string op, string stage, string destination, string expected,
      string originalDacl, bool originalProtected) {
    if (op=="publish") return RunPublish(stage, destination, expected, originalDacl, originalProtected);
    if (op=="cleanup") { RunCleanup(stage, expected); return new Dictionary<string,object>{{"ok",true}}; }
    throw new Exception("unknown native save operation");
  }
}
'@
if ([string]$inputValue.op -eq 'stage') {
  $stage = [EvenfireGfsSaveNative]::BeginStage([string]$inputValue.stage)
  $ready = $stage.Observation
  $ready | ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.WriteLine($_); [Console]::Out.Flush() }
  try {
    $result = [EvenfireGfsSaveNative]::CompleteStage($stage, [string]$stage.OriginalDacl,
      [bool]$stage.OriginalProtected, $standardInput, [long]$inputValue.bodyLength)
  } catch { throw } finally { [EvenfireGfsSaveNative]::CloseStage($stage) }
} else {
  $result = [EvenfireGfsSaveNative]::Run([string]$inputValue.op, [string]$inputValue.stage,
    [string]$inputValue.destination, [string]$inputValue.expected,
    [string]$inputValue.originalDacl, [bool]$inputValue.originalDaclProtected)
}
$result | ConvertTo-Json -Compress
`

function windowsPowerShellHost(): string {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Windows SystemRoot is unavailable')
  }
  const host = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  if (!path.win32.isAbsolute(host)) throw new Error('Windows PowerShell host path is invalid')
  return host
}

function parseWindowsNativeResult(stdout: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new Error('Windows native GFS save returned an invalid receipt')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Windows native GFS save returned an invalid receipt')
  }
  return parsed as Record<string, unknown>
}

function runWindowsNative(input: Record<string, unknown>): Record<string, unknown> {
  const host = windowsPowerShellHost()
  const encoded = Buffer.from(WINDOWS_NATIVE_SCRIPT, 'utf16le').toString('base64')
  const result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    input: `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Windows native GFS save operation failed (${result.status ?? 'spawn'})`)
  }
  return parseWindowsNativeResult(result.stdout)
}

interface WindowsNativeStageObservation {
  ownerSid: string
  daclSddl: string
  daclProtected: boolean
  bytesWritten: number
  physicalLength: number
  hidden: boolean
  identity: string
}

interface WindowsRestrictedStageObservation extends WindowsNativeStageObservation {
  /** Internal test seam; never returned through IPC or the terminal receipt. */
  stagePath: string
  /** Re-inspects through retained Hpub without reopening the stage pathname. */
  inspectStage: () => WindowsNativeStageObservation
}

class GfsSaveStageCancelledError extends Error {
  constructor() {
    super('GFS save staging was cancelled')
    this.name = 'GfsSaveStageCancelledError'
  }
}

function throwIfStageCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GfsSaveStageCancelledError()
}

async function runWindowsStage(
  stagePath: string,
  bytes: ArrayBuffer,
  signal?: AbortSignal,
  onRestricted?: (observation: WindowsRestrictedStageObservation) => void | Promise<void>,
  onStageWriteChunk?: (bytesWritten: number, stagePath?: string) => void | Promise<void>
): Promise<Record<string, unknown>> {
  throwIfStageCancelled(signal)
  const host = windowsPowerShellHost()
  const encoded = Buffer.from(WINDOWS_NATIVE_SCRIPT, 'utf16le').toString('base64')
  const child = spawn(host, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => undefined)
  child.stderr.resume()
  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>
  void closed.catch(() => undefined)
  const output = child.stdout[Symbol.asyncIterator]()
  let signalAbort: (() => void) | undefined
  const aborted = signal
    ? new Promise<void>(resolve => {
        const listener = () => resolve()
        signalAbort = listener
        if (signal.aborted) listener()
        else signal.addEventListener('abort', listener, { once: true })
      })
    : undefined
  const withAbort = <T>(promise: Promise<T>): Promise<T> =>
    aborted
      ? Promise.race([
          promise,
          aborted.then(() => {
            throw new GfsSaveStageCancelledError()
          }),
        ])
      : promise
  let outputRemainder = Buffer.alloc(0)
  const readLine = async (): Promise<string> => {
    while (true) {
      const newline = outputRemainder.indexOf(0x0a)
      if (newline >= 0) {
        const line = outputRemainder.subarray(0, newline).toString('utf8')
        outputRemainder = outputRemainder.subarray(newline + 1)
        return line
      }
      const next = await withAbort(output.next())
      if (next.done) throw new Error('Windows native GFS stage exited before its receipt')
      outputRemainder = Buffer.concat([outputRemainder, Buffer.from(next.value)])
    }
  }
  const header = Buffer.from(
    `${JSON.stringify({ op: 'stage', stage: stagePath, bodyLength: bytes.byteLength })}\n`,
    'utf8'
  )
  let readyIdentity: string | undefined
  const writeChunk = async (chunk: Buffer) => {
    if (child.stdin.write(chunk)) return
    await withAbort(
      Promise.race([
        once(child.stdin, 'drain'),
        once(child.stdin, 'error').then(([error]) => Promise.reject(error)),
      ])
    )
  }
  const abortInput = () => child.stdin.destroy()
  signal?.addEventListener('abort', abortInput, { once: true })
  try {
    await withAbort(writeChunk(header))
    const ready = parseWindowsNativeResult(await readLine())
    const ownerSid = ready.ownerSid
    if (
      typeof ownerSid !== 'string' ||
      !/^S-1-[0-9-]+$/.test(ownerSid) ||
      ready.daclSddl !== `D:P(A;;FA;;;${ownerSid})` ||
      ready.daclProtected !== true ||
      ready.length !== 0 ||
      ready.hidden !== true ||
      typeof ready.identity !== 'string' ||
      !/^[0-9A-F]{8}:[0-9A-F]{16}$/i.test(ready.identity)
    ) {
      throw new Error('Windows native GFS stage is not restricted before body write')
    }
    readyIdentity = ready.identity
    await withAbort(
      Promise.resolve(
        onRestricted?.({ ...ready, stagePath } as unknown as WindowsRestrictedStageObservation)
      )
    )
    const body = Buffer.from(bytes)
    for (let offset = 0; offset < body.byteLength; offset += 64 * 1024) {
      throwIfStageCancelled(signal)
      const chunk = body.subarray(offset, Math.min(offset + 64 * 1024, body.byteLength))
      await withAbort(writeChunk(chunk))
      await onStageWriteChunk?.(chunk.byteLength, stagePath)
    }
    child.stdin.end()
  } catch (error) {
    signal?.removeEventListener('abort', abortInput)
    if (signalAbort) signal?.removeEventListener('abort', signalAbort)
    child.stdin.destroy()
    await closed.catch(() => undefined)
    if (signal?.aborted) {
      if (readyIdentity) {
        runWindowsNative({
          op: 'cleanup',
          stage: stagePath,
          destination: '',
          expected: readyIdentity,
        })
        throw new GfsSaveStageCancelledError()
      }
      throw new Error('Windows GFS stage cancellation settled without an ownership receipt', {
        cause: error,
      })
    }
    throw error
  }
  signal?.removeEventListener('abort', abortInput)
  if (signalAbort) signal?.removeEventListener('abort', signalAbort)
  const [status] = await closed
  if (status !== 0) {
    if (signal?.aborted) throw new GfsSaveStageCancelledError()
    throw new Error(`Windows native GFS stage failed (${status ?? 'signal'})`)
  }
  const remaining: Buffer[] = [outputRemainder]
  for await (const chunk of output) remaining.push(Buffer.from(chunk))
  const result = parseWindowsNativeResult(Buffer.concat(remaining).toString('utf8'))
  if (
    typeof result.originalDacl !== 'string' ||
    !result.originalDacl.startsWith('D:') ||
    result.originalDacl.length > 32768 ||
    typeof result.originalDaclProtected !== 'boolean'
  ) {
    throw new Error('Windows native GFS stage did not retain its inherited ACL')
  }
  return result
}

function fileIdentity(stats: fs.Stats): string {
  return `${stats.dev}:${stats.ino}`
}

function removePrivateStageDirectory(stageDirectory: string, expectedIdentity: string): void {
  let current: fs.Stats
  try {
    current = fs.lstatSync(stageDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    fileIdentity(current) !== expectedIdentity
  ) {
    throw new Error('refusing cleanup of a different GFS private stage directory')
  }
  fs.rmdirSync(stageDirectory)
}

export async function createPrivateGfsStage(
  filePath: string,
  bytes: ArrayBuffer,
  options: {
    signal?: AbortSignal
    onWindowsRestrictedStage?: (
      observation: WindowsRestrictedStageObservation
    ) => void | Promise<void>
    onStageWriteChunk?: (bytesWritten: number, stagePath?: string) => void | Promise<void>
  } = {}
): Promise<GfsSaveStage> {
  throwIfStageCancelled(options.signal)
  if (!path.isAbsolute(filePath)) throw new Error('GFS save path must be absolute')
  const intendedMode = 0o666 & ~process.umask()
  const directory = path.dirname(filePath)
  if (process.platform === 'win32') {
    if (!windowsGfsSaveNative) throw new Error('Windows native GFS save bridge is unavailable')
    const nativeSession = windowsGfsSaveNative.openDestination(filePath)
    const stagePath = windowsGfsSaveNative.stagePath(nativeSession)
    try {
      throwIfStageCancelled(options.signal)
      const observation = windowsGfsSaveNative.stageObservation(nativeSession)
      await options.onWindowsRestrictedStage?.({
        ...observation,
        stagePath,
        inspectStage: () => windowsGfsSaveNative.stageObservation(nativeSession),
      })
      const body = Buffer.from(bytes)
      for (let offset = 0; offset < body.byteLength; ) {
        throwIfStageCancelled(options.signal)
        const chunk = body.subarray(offset, Math.min(offset + 64 * 1024, body.byteLength))
        const written = windowsGfsSaveNative.writeChunk(nativeSession, chunk)
        if (written !== chunk.byteLength)
          throw new Error('GFS private stage write made no progress')
        offset += written
        await options.onStageWriteChunk?.(written, stagePath)
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      throwIfStageCancelled(options.signal)
      windowsGfsSaveNative.settleWriter(nativeSession, body.byteLength)
      return {
        stagePath,
        filePath,
        fileIdentity: windowsGfsSaveNative.stageIdentity(nativeSession),
        nativeSession,
      }
    } catch (error) {
      try {
        windowsGfsSaveNative.cleanupStage(nativeSession)
      } finally {
        windowsGfsSaveNative.closeSession(nativeSession)
      }
      if (error instanceof GfsSaveStageCancelledError || options.signal?.aborted) {
        throw new GfsSaveStageCancelledError()
      }
      throw error
    }
  }
  if (!posixGfsSaveNative) {
    throw new Error(`GFS save is unsupported on ${process.platform}`)
  }
  const nativeSession = posixGfsSaveNative.openDestination(filePath)
  const stagePath = posixGfsSaveNative.stagePath(nativeSession)
  const stageDirectory = posixGfsSaveNative.stageDirectoryPath(nativeSession)
  try {
    throwIfStageCancelled(options.signal)
    const body = Buffer.from(bytes)
    for (let offset = 0; offset < body.byteLength; ) {
      throwIfStageCancelled(options.signal)
      const chunk = body.subarray(offset, Math.min(offset + 64 * 1024, body.byteLength))
      const written = posixGfsSaveNative.writeChunk(nativeSession, chunk)
      if (written !== chunk.byteLength) throw new Error('GFS private stage write made no progress')
      offset += written
      await options.onStageWriteChunk?.(written, stagePath)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    throwIfStageCancelled(options.signal)
    posixGfsSaveNative.settleWriter(nativeSession, body.byteLength)
    return {
      stagePath,
      filePath,
      fileIdentity: posixGfsSaveNative.stageIdentity(nativeSession),
      stageDirectory,
      stageDirectoryIdentity: posixGfsSaveNative.stageDirectoryIdentity(nativeSession),
      intendedMode,
      nativeSession,
    }
  } catch (error) {
    try {
      posixGfsSaveNative.cleanupStage(nativeSession)
    } finally {
      posixGfsSaveNative.closeSession(nativeSession)
    }
    if (error instanceof GfsSaveStageCancelledError || options.signal?.aborted) {
      throw new GfsSaveStageCancelledError()
    }
    throw error
  }
}

export function publishGfsStageNoClobber(stage: GfsSaveStage, onPublished: () => void): void {
  if (process.platform === 'win32') {
    if (!windowsGfsSaveNative || !stage.nativeSession) {
      throw new Error('Windows GFS save is unavailable without the retained-handle native owner')
    }
    try {
      if (!windowsGfsSaveNative.publishNoReplace(stage.nativeSession)) {
        throw new Error('Windows GFS native publisher returned without publication')
      }
    } finally {
      // Consult native effect state even if converting its return value failed.
      // The native owner latches immediately after successful SetFileInformationByHandle.
      if (windowsGfsSaveNative.isPublished(stage.nativeSession)) onPublished()
    }
    return
    /* istanbul ignore next -- retired path-based PowerShell publisher */
    /* istanbul ignore next -- retired path-based PowerShell publisher */
    const result = runWindowsNative({
      op: 'publish',
      stage: stage.stagePath,
      destination: stage.filePath,
      body: '',
      expected: stage.fileIdentity,
      originalDacl: stage.windowsOriginalDacl,
      originalDaclProtected: stage.windowsOriginalDaclProtected,
      dacl: '',
      protected: false,
    })
    if (result.identity !== stage.fileIdentity) {
      throw new Error('Windows native GFS publication receipt is inconsistent')
    }
    return
  }
  if (stage.nativeSession) {
    if (!posixGfsSaveNative) throw new Error('POSIX GFS native save bridge is unavailable')
    try {
      if (!posixGfsSaveNative.publishNoReplace(stage.nativeSession)) {
        throw new Error('POSIX GFS native publisher returned without publication')
      }
    } finally {
      if (posixGfsSaveNative.isPublished(stage.nativeSession)) onPublished()
    }
    return
  }
  const before = fs.lstatSync(stage.stagePath)
  if (before.isSymbolicLink() || `${before.dev}:${before.ino}` !== stage.fileIdentity) {
    throw new Error('GFS private stage identity changed')
  }
  fs.linkSync(stage.stagePath, stage.filePath)
  // The successful native link is irreversible. Record it before any readback.
  onPublished()
}

export function cleanupGfsStage(stage: GfsSaveStage): void {
  if (process.platform === 'win32') {
    if (windowsGfsSaveNative && stage.nativeSession) {
      try {
        windowsGfsSaveNative.cleanupStage(stage.nativeSession)
      } finally {
        windowsGfsSaveNative.closeSession(stage.nativeSession)
      }
      return
    }
    runWindowsNative({
      op: 'cleanup',
      stage: stage.stagePath,
      destination: '',
      body: '',
      expected: stage.fileIdentity,
      originalDacl: '',
      originalDaclProtected: false,
      dacl: '',
      protected: false,
    })
    return
  }
  if (stage.nativeSession) {
    try {
      posixGfsSaveNative?.cleanupStage(stage.nativeSession)
    } finally {
      posixGfsSaveNative?.closeSession(stage.nativeSession)
    }
    return
  }
  let current: fs.Stats | undefined
  try {
    current = fs.lstatSync(stage.stagePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (current) {
    if (current.isSymbolicLink() || fileIdentity(current) !== stage.fileIdentity) {
      throw new Error('refusing cleanup of a different GFS stage object')
    }
    fs.unlinkSync(stage.stagePath)
  }
  if (stage.stageDirectory && stage.stageDirectoryIdentity) {
    removePrivateStageDirectory(stage.stageDirectory, stage.stageDirectoryIdentity)
  }
}

function closeGfsSaveStage(stage: GfsSaveStage): void {
  if (process.platform === 'win32') windowsGfsSaveNative?.closeSession(stage.nativeSession)
  else if (stage.nativeSession) posixGfsSaveNative?.closeSession(stage.nativeSession)
}

/** Stage a trusted receipt, then publish once behind the caller's authority fence. */
export async function saveGfsReceiptToPath(options: {
  uri: string
  version: number
  filePath: string
  bytes: ArrayBuffer
  signal?: AbortSignal
  cancelRequested?: () => boolean
  publishFence: <T>(finish: () => Promise<T> | T) => Promise<T>
  /** Internal producer-test seam; never supplied by renderer or IPC callers. */
  onWindowsRestrictedStage?: (
    observation: WindowsRestrictedStageObservation
  ) => void | Promise<void>
  /** Internal producer-test seam for deterministic cancellation during staging. */
  onStageWriteChunk?: (bytesWritten: number, stagePath?: string) => void | Promise<void>
  /** Internal producer-test seam for the primary read and its one reconciliation. */
  readPublishedIdentity?: (
    stage: GfsSaveStage,
    attempt: 'primary' | 'reconciliation'
  ) => string | null | undefined | Promise<string | null | undefined>
  /** Internal native-acceptance seam; never supplied by renderer or IPC callers. */
  readWindowsFinalAccess?: (attempt: WindowsFinalAccessReadAttempt) =>
    | 'intended'
    | 'private'
    | 'unknown'
}): Promise<GfsSaveTerminalReceipt> {
  if (options.signal?.aborted) {
    return { status: 'cancelled_no_publication', uri: options.uri, filePath: null }
  }
  let stage: GfsSaveStage
  try {
    stage = await createPrivateGfsStage(options.filePath, options.bytes, {
      signal: options.signal,
      onWindowsRestrictedStage: options.onWindowsRestrictedStage,
      onStageWriteChunk: options.onStageWriteChunk,
    })
  } catch (error) {
    if (error instanceof GfsSaveStageCancelledError) {
      return { status: 'cancelled_no_publication', uri: options.uri, filePath: null }
    }
    throw error
  }
  let published = false
  try {
    // Let a queued Stop/abort IPC message arbitrate before the final effect.
    await new Promise<void>(resolve => setImmediate(resolve))
    if (options.signal?.aborted || options.cancelRequested?.()) {
      cleanupGfsStage(stage)
      return { status: 'cancelled_no_publication', uri: options.uri, filePath: null }
    }
    return await options.publishFence(async () => {
      if (options.signal?.aborted || options.cancelRequested?.()) {
        cleanupGfsStage(stage)
        return { status: 'cancelled_no_publication', uri: options.uri, filePath: null } as const
      }
      publishGfsStageNoClobber(stage, () => {
        published = true
      })
      if (!published) throw new Error('GFS save returned without a publication result')

      let windowsAccess: 'intended' | 'private' | 'unknown' | undefined
      let windowsAccessReadAttempts = 0
      const readWindowsAccess = (attempt: WindowsFinalAccessReadAttempt) => {
        if (!stage.nativeSession || !windowsGfsSaveNative) return 'unknown' as const
        windowsAccessReadAttempts += 1
        if (options.readWindowsFinalAccess) return options.readWindowsFinalAccess(attempt)
        return windowsGfsSaveNative.inspectFinalAccess(stage.nativeSession)
      }
      if (process.platform === 'win32' && stage.nativeSession && windowsGfsSaveNative) {
        try {
          // D0 is applied only after the no-replace effect. Hpub remains open
          // through this setter and both possible same-object reads.
          windowsGfsSaveNative.applyFinalAccess(stage.nativeSession)
        } catch {
          // The following retained-Hpub readback determines the actual state.
        }
        try {
          windowsAccess = readWindowsAccess('primary')
        } catch {
          windowsAccess = 'unknown'
        }
      }

      const readIdentity = async (attempt: 'primary' | 'reconciliation') => {
        if (options.readPublishedIdentity) {
          const injected = await options.readPublishedIdentity(stage, attempt)
          if (injected !== undefined) return injected
        }
        if (process.platform === 'win32' && stage.nativeSession && windowsGfsSaveNative)
          return windowsGfsSaveNative.inspectFinal(stage.nativeSession)
        if (stage.nativeSession)
          return posixGfsSaveNative?.inspectFinal(stage.nativeSession) ?? null
        const stat = fs.lstatSync(stage.filePath)
        if (stat.isSymbolicLink()) return null
        return fileIdentity(stat)
      }
      let finalIdentity: string | null = null
      try {
        finalIdentity = await readIdentity('primary')
      } catch {
        // The successful link already established publication. Reconcile once.
      }
      if (finalIdentity !== stage.fileIdentity) {
        try {
          finalIdentity = await readIdentity('reconciliation')
          if (process.platform === 'win32' && stage.nativeSession && windowsGfsSaveNative) {
            try {
              windowsAccess = readWindowsAccess('reconciliation')
            } catch {
              windowsAccess = 'unknown'
            }
          }
        } catch {
          finalIdentity = null
        }
      }
      if (
        process.platform === 'win32' &&
        finalIdentity === stage.fileIdentity &&
        windowsAccess === 'unknown' &&
        windowsAccessReadAttempts < 2 &&
        stage.nativeSession &&
        windowsGfsSaveNative
      ) {
        // At most one read-only same-Hpub ACL reconciliation. No pathname reopen
        // or permission setter retry is permitted after publication.
        try {
          windowsAccess = readWindowsAccess('reconciliation')
        } catch {
          windowsAccess = 'unknown'
        }
      }
      if (finalIdentity !== stage.fileIdentity) {
        const receipt = {
          status: 'published_access_unverified',
          uri: options.uri,
          version: options.version,
          filePath: options.filePath,
          publication: 'confirmed_by_native_return',
          identity: 'unverified',
          access: 'unverified',
          stageCleanup: process.platform === 'win32' ? 'complete' : 'retained',
          ...(process.platform === 'win32'
            ? {}
            : { residualStagePath: stage.stagePath, residualStageIdentity: stage.fileIdentity }),
        } as const
        closeGfsSaveStage(stage)
        return receipt
      }

      if (process.platform === 'win32' && windowsAccess !== 'intended') {
        const receipt: GfsSaveTerminalReceipt =
          windowsAccess === 'private'
            ? {
                status: 'published_private_warning',
                uri: options.uri,
                version: options.version,
                filePath: options.filePath,
                publication: 'confirmed_by_native_return',
                identity: 'verified',
                access: 'verified_private',
                stageCleanup: 'complete',
              }
            : {
                status: 'published_access_unverified',
                uri: options.uri,
                version: options.version,
                filePath: options.filePath,
                publication: 'confirmed_by_native_return',
                identity: 'verified',
                access: 'unverified',
                stageCleanup: 'complete',
              }
        closeGfsSaveStage(stage)
        return receipt
      }

      if (stage.nativeSession && posixGfsSaveNative) {
        let finalMode: number | undefined
        try {
          posixGfsSaveNative.applyFinalMode(stage.nativeSession, stage.intendedMode ?? 0o600)
          finalMode = posixGfsSaveNative.inspectFinalMode(stage.nativeSession)
        } catch {
          try {
            finalMode = posixGfsSaveNative.inspectFinalMode(stage.nativeSession)
          } catch {
            finalMode = undefined
          }
        }
        if (finalMode !== (stage.intendedMode ?? 0o600)) {
          const receipt: GfsSaveTerminalReceipt =
            finalMode === 0o600
              ? ({
                  status: 'published_private_warning',
                  uri: options.uri,
                  version: options.version,
                  filePath: options.filePath,
                  publication: 'confirmed_by_native_return',
                  identity: 'verified',
                  access: 'verified_private',
                  stageCleanup: 'retained',
                  residualStagePath: stage.stagePath,
                  residualStageIdentity: stage.fileIdentity,
                } as const)
              : ({
                  status: 'published_access_unverified',
                  uri: options.uri,
                  version: options.version,
                  filePath: options.filePath,
                  publication: 'confirmed_by_native_return',
                  identity: 'verified',
                  access: 'unverified',
                  stageCleanup: 'retained',
                  residualStagePath: stage.stagePath,
                  residualStageIdentity: stage.fileIdentity,
                } as const)
          closeGfsSaveStage(stage)
          return receipt
        }
      } else if (process.platform !== 'win32' && (stage.intendedMode ?? 0o600) !== 0o600) {
        const receipt = {
          status: 'published_private_warning',
          uri: options.uri,
          version: options.version,
          filePath: options.filePath,
          publication: 'confirmed_by_native_return',
          identity: 'verified',
          access: 'verified_private',
          stageCleanup: 'retained',
          residualStagePath: stage.stagePath,
          residualStageIdentity: stage.fileIdentity,
        } as const
        closeGfsSaveStage(stage)
        return receipt
      }

      try {
        cleanupGfsStage(stage)
      } catch {
        const residualStagePath = stage.stageDirectory ?? stage.stagePath
        const residualStageIdentity = stage.stageDirectoryIdentity ?? stage.fileIdentity
        const receipt = {
          status: 'published_finalization_warning',
          uri: options.uri,
          version: options.version,
          filePath: options.filePath,
          stageCleanup: 'failed',
          residualStagePath,
          residualStageIdentity,
        } as const
        closeGfsSaveStage(stage)
        return receipt
      }
      return {
        status: 'saved_access_verified',
        uri: options.uri,
        version: options.version,
        filePath: options.filePath,
        stageCleanup: 'complete',
      } as const
    })
  } catch (error) {
    if (published) {
      const receipt: GfsSaveTerminalReceipt = {
        status: 'published_access_unverified',
        uri: options.uri,
        version: options.version,
        filePath: options.filePath,
        publication: 'confirmed_by_native_return',
        identity: 'unverified',
        access: 'unverified',
        stageCleanup: process.platform === 'win32' ? 'complete' : 'retained',
        ...(process.platform === 'win32'
          ? {}
          : { residualStagePath: stage.stagePath, residualStageIdentity: stage.fileIdentity }),
      }
      closeGfsSaveStage(stage)
      return receipt
    }
    let cleanupError: unknown
    try {
      cleanupGfsStage(stage)
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure
    }
    if (cleanupError) {
      const residualStagePath = stage.stageDirectory ?? stage.stagePath
      const residualStageIdentity = stage.stageDirectoryIdentity ?? stage.fileIdentity
      return {
        status: 'failed_no_publication',
        uri: options.uri,
        version: options.version,
        filePath: null,
        stageCleanup: 'failed',
        residualStagePath,
        residualStageIdentity,
      }
    }
    throw error
  }
}
