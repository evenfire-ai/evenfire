import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import type {
  DesktopReleaseArchitecture,
  DesktopReleasePackageType,
  DesktopReleasePlatform,
  VerifiedDesktopPayload,
} from './desktopUpdateArtifacts.js'
import { readFileSha256, updaterFileSystem } from './desktopUpdateFileSystem.js'

const { constants } = updaterFileSystem
const { access, lstat, realpath, unlink } = updaterFileSystem.promises

export type DesktopInstallLocation = {
  platform: DesktopReleasePlatform
  architecture: DesktopReleaseArchitecture
  packageType: DesktopReleasePackageType
  installRoot: string
  appPath: string
  executablePath: string
  updateExecutablePath?: string
}

export type DesktopInstallPlan = {
  operationId: string
  operationPath: string
  stageRoot: string
  pendingPath: string
  location: DesktopInstallLocation
  payload: VerifiedDesktopPayload
  currentVersion: string
  currentAsarSha256: string
  targetPackageSha256: string
  rollbackPackagePath?: string
  rollbackPackageSha256?: string
}

const USER_DIR_SCRIPT = String.raw`set -eu
PATH=/usr/bin:/bin; export PATH
root="$1"; stage="$2"; id="$3"; install="$4"; staged="$5"; fresh="$6"; old="$7"
digest="$8"; capable="$9"; parent="@@ARG10@@"; pending="@@ARG11@@"; version="@@ARG12@@"
log="$stage/install.log"
fail() { printf '%s\n' "$1" >> "$log"; exit 1; }
[ "$stage" = "$root/$id" ] && [ "$pending" = "$root/pending.json" ] || fail 'staging path mismatch'
[ ! -L "$stage" ] && [ -f "$stage/operation.json" ] || fail 'staging record missing'
grep -q "\"id\":\"$id\"" "$stage/operation.json" || fail 'operation record mismatch'
[ "$fresh" = "$install.evenfire-new-$id" ] && [ "$old" = "$install.evenfire-rollback-$id" ] || fail 'install path mismatch'
[ -d "$install" ] && [ ! -L "$install" ] || fail 'installed app directory changed before replacement'
[ ! -e "$fresh" ] && [ ! -L "$fresh" ] && [ ! -e "$old" ] && [ ! -L "$old" ] || fail 'install or rollback path already exists'
printf '%s\n' "$$" > "$stage/helper.pid"
for i in $(seq 1 180); do
  [ ! -f "$stage/cancel-install.json" ] || exit 6
  if ! kill -0 "$parent" 2>/dev/null; then break; fi
  sleep 0.2
done
kill -0 "$parent" 2>/dev/null && fail 'Evenfire did not exit'
cp -a "$staged" "$fresh" || fail 'could not copy the verified app'
actual=$(sha256sum "$fresh/resources/app.asar" | awk '{print $1}')
[ "$actual" = "$digest" ] || { rm -rf -- "$fresh"; fail 'app digest mismatch'; }
[ -x "$fresh/Evenfire" ] || { rm -rf -- "$fresh"; fail 'application executable is missing'; }
mv -- "$install" "$old" || fail 'could not preserve previous app'
if ! mv -- "$fresh" "$install"; then mv -- "$old" "$install" || fail 'rollback failed'; fail 'install failed'; fi
(cd -- "$install" && ./Evenfire "--user-data-dir=$(dirname "$root")" "--evenfire-update-operation=$id") >/dev/null 2>&1 &
appPid=$!; verified=0
for i in $(seq 1 300); do
  actual=$(sha256sum "$install/resources/app.asar" | awk '{print $1}')
  if [ "$actual" != "$digest" ] || [ ! -x "$install/Evenfire" ]; then break; fi
  if [ "$capable" = true ] && [ -f "$stage/startup-ok.json" ]; then verified=1; break; fi
  if [ "$capable" = false ] && [ "$i" -ge 50 ] && kill -0 "$appPid" 2>/dev/null; then verified=1; break; fi
  if ! kill -0 "$appPid" 2>/dev/null; then break; fi
  sleep 0.2
done
actual=$(sha256sum "$install/resources/app.asar" | awk '{print $1}')
if [ "$actual" != "$digest" ] || [ ! -x "$install/Evenfire" ]; then verified=0; fi
if [ "$verified" -ne 1 ]; then
  if kill -0 "$appPid" 2>/dev/null; then kill "$appPid" 2>/dev/null || true; fi
  mv -- "$install" "$fresh" || fail 'could not move failed app'
  mv -- "$old" "$install" || fail 'rollback failed'
  rm -rf -- "$fresh"; (cd -- "$install" && ./Evenfire "--user-data-dir=$(dirname "$root")") >/dev/null 2>&1 &
  printf '{"id":"%s","state":"rollback-complete"}\n' "$id" > "$stage/cleanup-safe.json"
  printf '{"id":"%s","state":"safe-to-delete"}\n' "$id" > "$root/cleanup.json"
  rm -rf -- "$stage"; rm -f "$pending" "$root/cleanup.json"; exit 1
fi
rm -rf -- "$old"
printf '{"id":"%s","state":"installed"}\n' "$id" > "$stage/cleanup-safe.json"
printf '{"id":"%s","state":"safe-to-delete"}\n' "$id" > "$root/cleanup.json"
rm -rf -- "$stage"; rm -f "$pending" "$root/cleanup.json"
`
  .replaceAll('@@ARG10@@', () => '${10}')
  .replaceAll('@@ARG11@@', () => '${11}')
  .replaceAll('@@ARG12@@', () => '${12}')

const LINUX_ROOT_SCRIPT = String.raw`set -eu
PATH=/usr/bin:/bin; export PATH
stage="$1"; id="$2"; kind="$3"; action="$4"; target="$5"; targetHash="$6"
rollback="$7"; rollbackHash="$8"; targetVersion="$9"; oldVersion="@@ARG10@@"
targetAsar="@@ARG11@@"; oldAsar="@@ARG12@@"; exe="@@ARG13@@"
parent="@@ARG14@@"
[ "$stage" = "$(/usr/bin/dirname "$stage")/$id" ] && [ ! -L "$stage" ] && [ -f "$stage/operation.json" ] || exit 2
/usr/bin/grep -q "\"id\":\"$id\"" "$stage/operation.json" || exit 2
case "$kind" in deb|rpm) ;; *) exit 2;; esac
if [ "$action" = install ]; then
  printf '%s\n' "$$" > "$(/usr/bin/dirname "$stage")/privileged-ready"
  for i in $(/usr/bin/seq 1 180); do
    [ ! -f "$stage/cancel-install.json" ] || exit 6
    if ! kill -0 "$parent" 2>/dev/null; then break; fi
    /usr/bin/sleep 0.2
  done
  kill -0 "$parent" 2>/dev/null && exit 5
fi
tmp=$(/usr/bin/mktemp -d /var/tmp/evenfire-update.XXXXXX); /usr/bin/chmod 700 "$tmp"
trap '/usr/bin/rm -rf "$tmp"' EXIT HUP INT TERM
log="$stage/package-manager.log"
copy_verified() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  /usr/bin/cp -- "$1" "$2"; /usr/bin/chmod 600 "$2"
  [ "$(/usr/bin/sha256sum "$2" | /usr/bin/awk '{print $1}')" = "$3" ]
}
install_pkg() {
  if [ "$kind" = deb ]; then
    /usr/bin/dpkg --install "$1" >>"$log" 2>&1
  else
    /usr/bin/rpm --upgrade --oldpackage "$1" >>"$log" 2>&1
  fi
}
version_now() {
  if [ "$kind" = deb ]; then /usr/bin/dpkg-query --show --showformat='@@DPKG_VERSION@@' evenfire
  else /usr/bin/rpm --query --queryformat '%{VERSION}' evenfire; fi
}
asar_now() { /usr/bin/sha256sum "$(/usr/bin/dirname "$exe")/resources/app.asar" | /usr/bin/awk '{print $1}'; }
if [ "$action" = install ]; then
  copy_verified "$target" "$tmp/target.pkg" "$targetHash" || exit 3
  copy_verified "$rollback" "$tmp/rollback.pkg" "$rollbackHash" || exit 3
  if install_pkg "$tmp/target.pkg" && [ "$(version_now)" = "$targetVersion" ] && [ "$(asar_now)" = "$targetAsar" ]; then
    printf installed; exit 0
  fi
  if install_pkg "$tmp/rollback.pkg" && [ "$(version_now)" = "$oldVersion" ] && [ "$(asar_now)" = "$oldAsar" ]; then
    printf rollback; exit 0
  fi
  exit 4
fi
if [ "$action" = rollback ]; then
  copy_verified "$rollback" "$tmp/rollback.pkg" "$rollbackHash" || exit 3
  if install_pkg "$tmp/rollback.pkg" && [ "$(version_now)" = "$oldVersion" ] && [ "$(asar_now)" = "$oldAsar" ]; then
    printf rollback; exit 0
  fi
fi
exit 4
`
  .replaceAll('@@ARG10@@', () => '${10}')
  .replaceAll('@@ARG11@@', () => '${11}')
  .replaceAll('@@ARG12@@', () => '${12}')
  .replaceAll('@@ARG13@@', () => '${13}')
  .replaceAll('@@ARG14@@', () => '${14}')
  .replaceAll('@@DPKG_VERSION@@', () => '${Version}')

const LINUX_PACKAGE_SCRIPT = String.raw`set -eu
PATH=/usr/bin:/bin; export PATH
root="$1"; stage="$2"; id="$3"; kind="$4"; target="$5"; targetHash="$6"; rollback="$7"; rollbackHash="$8"
exe="$9"; version="@@ARG10@@"; targetAsar="@@ARG11@@"; capable="@@ARG12@@"; parent="@@ARG13@@"
oldVersion="@@ARG14@@"; oldAsar="@@ARG15@@"; pending="@@ARG16@@"; rootB64="@@ARG17@@"; log="$stage/install.log"
fail() { printf '%s\n' "$1" >> "$log"; exit 1; }
version_now() {
  if [ "$kind" = deb ]; then /usr/bin/dpkg-query --show --showformat='@@DPKG_VERSION@@' evenfire
  else /usr/bin/rpm --query --queryformat '%{VERSION}' evenfire; fi
}
asar_now() { /usr/bin/sha256sum "$(/usr/bin/dirname "$exe")/resources/app.asar" | /usr/bin/awk '{print $1}'; }
[ "$stage" = "$root/$id" ] && [ "$pending" = "$root/pending.json" ] || fail 'staging path mismatch'
[ ! -L "$stage" ] && [ -f "$stage/operation.json" ] || fail 'staging record missing'
grep -q "\"id\":\"$id\"" "$stage/operation.json" || fail 'operation record mismatch'
printf '%s\n' "$$" > "$stage/helper.pid"
result=$(printf '%s' "$rootB64" | /usr/bin/base64 --decode | /usr/bin/pkexec /bin/sh -s "$stage" "$id" "$kind" install \
  "$target" "$targetHash" "$rollback" "$rollbackHash" "$version" "$oldVersion" "$targetAsar" "$oldAsar" "$exe" "$parent") ||
  fail 'OS authorization or package installation failed'
printf '%s\n' "$result" >> "$log"
if [ "$result" = rollback ]; then
  "$exe" "--user-data-dir=$(/usr/bin/dirname "$root")" >/dev/null 2>&1 &
  printf '{"id":"%s","state":"rollback-complete"}\n' "$id" > "$stage/cleanup-safe.json"
  printf '{"id":"%s","state":"safe-to-delete"}\n' "$id" > "$root/cleanup.json"
  /usr/bin/rm -rf -- "$stage"; /usr/bin/rm -f "$pending" "$root/cleanup.json"; exit 1
fi
[ "$result" = installed ] || fail 'native installer returned an invalid result'
"$exe" "--user-data-dir=$(/usr/bin/dirname "$root")" "--evenfire-update-operation=$id" >/dev/null 2>&1 &
appPid=$!; verified=0
for i in $(/usr/bin/seq 1 300); do
  if [ "$capable" = true ] && [ -f "$stage/startup-ok.json" ]; then verified=1; break; fi
  if [ "$capable" = false ] && [ "$i" -ge 50 ] && kill -0 "$appPid" 2>/dev/null; then verified=1; break; fi
  if ! kill -0 "$appPid" 2>/dev/null; then break; fi
  /usr/bin/sleep 0.2
done
if [ "$(version_now)" != "$version" ] || [ "$(asar_now)" != "$targetAsar" ]; then verified=0; fi
if [ "$verified" -ne 1 ]; then
  if kill -0 "$appPid" 2>/dev/null; then kill "$appPid" 2>/dev/null || true; fi
  result=$(printf '%s' "$rootB64" | /usr/bin/base64 --decode | /usr/bin/pkexec /bin/sh -s "$stage" "$id" "$kind" rollback \
    "$target" "$targetHash" "$rollback" "$rollbackHash" "$version" "$oldVersion" "$targetAsar" "$oldAsar" "$exe" "$parent") ||
    fail 'native package rollback needs manual recovery'
  [ "$result" = rollback ] || fail 'native package rollback did not verify'
  "$exe" "--user-data-dir=$(/usr/bin/dirname "$root")" >/dev/null 2>&1 &
  printf '{"id":"%s","state":"rollback-complete"}\n' "$id" > "$stage/cleanup-safe.json"
  printf '{"id":"%s","state":"safe-to-delete"}\n' "$id" > "$root/cleanup.json"
  /usr/bin/rm -rf -- "$stage"; /usr/bin/rm -f "$pending" "$root/cleanup.json"; exit 1
fi
printf '{"id":"%s","state":"installed"}\n' "$id" > "$stage/cleanup-safe.json"
printf '{"id":"%s","state":"safe-to-delete"}\n' "$id" > "$root/cleanup.json"
/usr/bin/rm -rf -- "$stage"; /usr/bin/rm -f "$pending" "$root/cleanup.json"
`
  .replaceAll('@@ARG10@@', () => '${10}')
  .replaceAll('@@ARG11@@', () => '${11}')
  .replaceAll('@@ARG12@@', () => '${12}')
  .replaceAll('@@ARG13@@', () => '${13}')
  .replaceAll('@@ARG14@@', () => '${14}')
  .replaceAll('@@ARG15@@', () => '${15}')
  .replaceAll('@@ARG16@@', () => '${16}')
  .replaceAll('@@ARG17@@', () => '${17}')

const WINDOWS_BODY = String.raw`
$ErrorActionPreference = 'Stop'
$plan = [Console]::In.ReadToEnd() | ConvertFrom-Json
$stageRoot = [string]$plan.stageRoot
$stage = [string]$plan.operationPath
$operationId = [string]$plan.operationId
$pendingPath = [string]$plan.pendingPath
$installRoot = [string]$plan.installRoot
$setup = [string]$plan.setupPath
$setupDigest = [string]$plan.setupDigest
$version = [string]$plan.version
$targetAsar = [string]$plan.targetAsar
$updaterCapable = [bool]$plan.updaterCapable
$parentPid = [int]$plan.parentPid
$currentVersion = [string]$plan.currentVersion
$currentAsar = [string]$plan.currentAsar
$log = Join-Path $stage 'install.log'
function Fail([string]$Message) { Add-Content -LiteralPath $log -Value $Message; throw $Message }
function Test-FullyQualifiedWindowsPath([string]$Candidate) {
  try {
    $root = [System.IO.Path]::GetPathRoot($Candidate)
    if (!$root) { return $false }
    $driveRooted = $root -match '^[A-Za-z]:\\$'
    $uncRooted = $root -match '^\\\\[^\\]+\\[^\\]+\\$'
    if (!$driveRooted -and !$uncRooted) { return $false }
    [void][System.IO.Path]::GetFullPath($Candidate)
    return $true
  } catch { return $false }
}
if ($operationId -notmatch '^[0-9a-f-]{36}$') { Fail 'invalid operation id' }
if ($setupDigest -notmatch '^[a-f0-9]{64}$' -or $targetAsar -notmatch '^[a-f0-9]{64}$') { Fail 'invalid package digest' }
foreach ($candidate in @($stageRoot, $stage, $pendingPath, $installRoot, $setup)) {
  if (!$candidate -or !(Test-FullyQualifiedWindowsPath $candidate)) { Fail 'invalid installation path' }
}
if ($stage -ne (Join-Path $stageRoot $operationId)) { Fail 'staging path mismatch' }
if ($pendingPath -ne (Join-Path $stageRoot 'pending.json')) { Fail 'pending pointer path mismatch' }
if (![System.IO.Path]::GetFullPath($setup).StartsWith([System.IO.Path]::GetFullPath($stage) + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'setup path is outside updater staging' }
if (!(Test-Path -LiteralPath (Join-Path $stage 'operation.json') -PathType Leaf)) { Fail 'staging record missing' }
if ((Get-Content -Raw -LiteralPath (Join-Path $stage 'operation.json')) -notmatch ('"id":"' + [regex]::Escape($operationId) + '"')) { Fail 'operation record mismatch' }
$localAppData = [Environment]::GetFolderPath('LocalApplicationData').TrimEnd('\') + '\'
if (!$installRoot.StartsWith($localAppData, [StringComparison]::OrdinalIgnoreCase)) { Fail 'Squirrel path is outside LocalAppData' }
if (!(Test-Path -LiteralPath $installRoot -PathType Container)) { Fail 'Squirrel install root is missing' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLowerInvariant() -ne $setupDigest) { Fail 'setup digest changed' }
Set-Content -LiteralPath (Join-Path $stage 'helper.pid') -Value $PID -NoNewline
for ($i = 0; $i -lt 180; $i++) {
  if (Test-Path -LiteralPath (Join-Path $stage 'cancel-install.json') -PathType Leaf) { exit 6 }
  if (!(Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Fail 'Evenfire did not exit' }
$rollbackRoot = $installRoot + '.evenfire-rollback-' + $operationId
if (Test-Path -LiteralPath $rollbackRoot) { Fail 'rollback path already exists' }
$movedOld = $false; $process = $null
try {
  Move-Item -LiteralPath $installRoot -Destination $rollbackRoot
  $movedOld = $true
  $setupProcess = Start-Process -FilePath $setup -ArgumentList @('--silent') -WorkingDirectory (Split-Path -Parent $setup) -PassThru -Wait
  if ($setupProcess.ExitCode -ne 0) { Fail 'Squirrel setup failed' }
  $targetApp = Join-Path $installRoot ('app-' + $version + '\Evenfire.exe')
  $targetFile = Join-Path $installRoot ('app-' + $version + '\resources\app.asar')
  if (!(Test-Path -LiteralPath $targetApp -PathType Leaf)) { Fail 'selected version was not installed' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $targetFile).Hash.ToLowerInvariant() -ne $targetAsar) { Fail 'installed app digest mismatch' }
  $userData = Split-Path -Parent $stageRoot
  $userDataArgument = '"--user-data-dir=' + $userData + '"'
  $process = Start-Process -FilePath $targetApp -ArgumentList @($userDataArgument, '--evenfire-update-operation=' + $operationId) -PassThru
  $marker = Join-Path $stage 'startup-ok.json'; $verified = $false
  for ($i = 0; $i -lt 300; $i++) {
    if ($updaterCapable -and (Test-Path -LiteralPath $marker -PathType Leaf)) { $verified = $true; break }
    if (!$updaterCapable -and $i -ge 50 -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { $verified = $true; break }
    if (!(Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $targetFile).Hash.ToLowerInvariant() -ne $targetAsar) { break }
    Start-Sleep -Milliseconds 200
  }
  if (!$verified) { Fail 'new app failed startup verification' }
  Remove-Item -LiteralPath $rollbackRoot -Recurse -Force
  Set-Content -LiteralPath (Join-Path $stage 'cleanup-safe.json') -Value ('{"id":"' + $operationId + '","state":"installed"}')
  Set-Content -LiteralPath (Join-Path $stageRoot 'cleanup.json') -Value ('{"id":"' + $operationId + '","state":"safe-to-delete"}')
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pendingPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $stageRoot 'cleanup.json') -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  Add-Content -LiteralPath $log -Value $_.Exception.Message
  if ($process -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $process.Id -Force }
  if ($movedOld -and (Test-Path -LiteralPath $rollbackRoot -PathType Container)) {
    if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
    Move-Item -LiteralPath $rollbackRoot -Destination $installRoot
    $oldApp = Join-Path $installRoot ('app-' + $currentVersion + '\Evenfire.exe')
    $oldAsar = Join-Path $installRoot ('app-' + $currentVersion + '\resources\app.asar')
    if (!(Test-Path -LiteralPath $oldAsar -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $oldAsar).Hash.ToLowerInvariant() -ne $currentAsar) { Fail 'rollback verification failed' }
    $updateExe = Join-Path $installRoot 'Update.exe'
    if (Test-Path -LiteralPath $updateExe -PathType Leaf) {
      Start-Process -FilePath $updateExe -ArgumentList @('--createShortcut=Evenfire.exe') -Wait -ErrorAction SilentlyContinue
    }
    $userData = Split-Path -Parent $stageRoot
    $userDataArgument = '"--user-data-dir=' + $userData + '"'
    Start-Process -FilePath $oldApp -ArgumentList @($userDataArgument) | Out-Null
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('The update failed. Your previous app was restored.', 'Evenfire update') | Out-Null
    Set-Content -LiteralPath (Join-Path $stage 'cleanup-safe.json') -Value ('{"id":"' + $operationId + '","state":"rollback-complete"}')
    Set-Content -LiteralPath (Join-Path $stageRoot 'cleanup.json') -Value ('{"id":"' + $operationId + '","state":"safe-to-delete"}')
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pendingPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $stageRoot 'cleanup.json') -Force -ErrorAction SilentlyContinue
  }
  exit 1
}
`

async function waitForHelper(
  createChild: () => ChildProcess,
  markerPath: string,
  standardInput?: string
): Promise<void> {
  try {
    const marker = await lstat(markerPath)
    if (!marker.isFile() || marker.isSymbolicLink()) {
      throw new Error('The Desktop update helper marker is not a safe file.')
    }
    await unlink(markerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await new Promise<void>((resolve, reject) => {
    const child = createChild()
    let settled = false
    const timeout = setTimeout(
      () => finish(new Error('The OS update helper did not become ready.')),
      5 * 60_000
    )
    const poll = setInterval(() => {
      void (async () => {
        try {
          const info = await lstat(markerPath)
          if (info.isFile() && !info.isSymbolicLink()) finish()
        } catch {
          // The helper has not published readiness yet.
        }
      })()
    }, 100)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(poll)
      if (error) reject(error)
      else resolve()
    }
    child.once('error', error => finish(error))
    child.once('exit', (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            'The OS update helper exited before installation was ready (' +
              (signal ?? code ?? 'unknown') +
              ').'
          )
        )
      }
    })
    child.once('spawn', () => child.unref())
    if (standardInput !== undefined) {
      if (!child.stdin) {
        finish(new Error('The OS update helper did not accept its verified install plan.'))
        return
      }
      child.stdin.end(standardInput, 'utf8')
    }
  })
}

function launchDetachedAndWaitForMarker(
  command: string,
  args: string[],
  markerPath: string,
  standardInput?: string
): Promise<void> {
  return waitForHelper(
    () =>
      spawn(command, args, {
        detached: true,
        shell: false,
        stdio: standardInput === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      }),
    markerPath,
    standardInput
  )
}

function packageManagerOwns(binaryPath: string): 'deb' | 'rpm' | null {
  const deb = spawnSync('/usr/bin/dpkg-query', ['-S', binaryPath], {
    encoding: 'utf8',
    timeout: 15000,
  })
  const rpm = spawnSync('/usr/bin/rpm', ['-qf', '--queryformat', '%{NAME}', binaryPath], {
    encoding: 'utf8',
    timeout: 15000,
  })
  const debMatch = deb.status === 0 && /^evenfire:\s+/m.test(deb.stdout ?? '')
  const rpmMatch = rpm.status === 0 && (rpm.stdout ?? '').trim() === 'evenfire'
  if (debMatch && rpmMatch) throw new Error('The Linux install type is ambiguous.')
  return debMatch ? 'deb' : rpmMatch ? 'rpm' : null
}

const LINUX_PACKAGE_EXECUTABLE = '/usr/lib/evenfire/Evenfire'

function releaseArchitecture(value: string): DesktopReleaseArchitecture {
  if (value === 'x64' || value === 'arm64') return value
  throw new Error('Desktop updates are not supported for this CPU architecture.')
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('The Windows system directory could not be verified.')
  }
  return path.win32.join(
    path.win32.resolve(systemRoot),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

export async function detectDesktopInstall(args: {
  platform: string
  architecture: string
  executablePath: string
  currentVersion: string
}): Promise<DesktopInstallLocation> {
  const platform = args.platform as DesktopReleasePlatform
  if (!['darwin', 'win32', 'linux'].includes(platform))
    throw new Error('Unsupported update platform.')
  const architecture = releaseArchitecture(args.architecture)
  const executablePath = await realpath(args.executablePath).catch(() =>
    path.resolve(args.executablePath)
  )
  const executable = await lstat(executablePath)
  if (!executable.isFile() || executable.isSymbolicLink())
    throw new Error('Installed executable is not a regular file.')
  if (platform === 'darwin') {
    const appPath = path.resolve(executablePath, '..', '..', '..')
    const bundle = await lstat(appPath)
    if (!bundle.isDirectory() || bundle.isSymbolicLink() || !appPath.endsWith('.app')) {
      throw new Error('The installed macOS app bundle location could not be verified.')
    }
    return {
      platform,
      architecture,
      packageType: 'app-zip',
      installRoot: appPath,
      appPath,
      executablePath,
    }
  }
  if (platform === 'win32') {
    const appPath = path.dirname(executablePath)
    const installRoot = path.dirname(appPath)
    const localAppData = process.env.LOCALAPPDATA?.trim()
    if (
      localAppData &&
      appPath.toLowerCase().startsWith(path.resolve(localAppData).toLowerCase() + path.sep) &&
      path.basename(appPath).toLowerCase() === ('app-' + args.currentVersion).toLowerCase() &&
      (await isRegularFile(path.join(installRoot, 'Update.exe'))) &&
      (await isRegularFile(path.join(installRoot, 'packages', 'RELEASES')))
    ) {
      return {
        platform,
        architecture,
        packageType: 'squirrel',
        installRoot,
        appPath,
        executablePath,
        updateExecutablePath: path.join(installRoot, 'Update.exe'),
      }
    }
    throw new Error('Automatic Windows updates require a verified per-user Squirrel install.')
  }
  const packageType = packageManagerOwns(LINUX_PACKAGE_EXECUTABLE)
  if (packageType) {
    const packagedExecutable = await realpath(LINUX_PACKAGE_EXECUTABLE).catch(() => null)
    if (!packagedExecutable || executablePath !== packagedExecutable) {
      throw new Error('The package-managed Evenfire executable location could not be verified.')
    }
    return {
      platform,
      architecture,
      packageType,
      installRoot: path.dirname(LINUX_PACKAGE_EXECUTABLE),
      appPath: path.dirname(LINUX_PACKAGE_EXECUTABLE),
      executablePath: LINUX_PACKAGE_EXECUTABLE,
    }
  }
  const appPath = path.dirname(executablePath)
  const info = await lstat(appPath)
  if (
    path.basename(executablePath) !== 'Evenfire' ||
    path.basename(appPath) !== 'Evenfire-linux-' + architecture ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    typeof process.getuid !== 'function' ||
    info.uid !== process.getuid()
  ) {
    throw new Error(
      'Automatic Linux updates require a package install or a user-owned Forge ZIP folder.'
    )
  }
  return {
    platform,
    architecture,
    packageType: 'app-zip',
    installRoot: appPath,
    appPath,
    executablePath,
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function verifyStage(plan: DesktopInstallPlan): Promise<void> {
  if (
    path.resolve(plan.operationPath) !== path.resolve(path.join(plan.stageRoot, plan.operationId))
  ) {
    throw new Error('The Desktop update staging path is not owned by this operation.')
  }
  const [root, stage] = await Promise.all([lstat(plan.stageRoot), lstat(plan.operationPath)])
  if (
    root.isSymbolicLink() ||
    !root.isDirectory() ||
    stage.isSymbolicLink() ||
    !stage.isDirectory() ||
    (typeof process.getuid === 'function' &&
      (root.uid !== process.getuid() || stage.uid !== process.getuid())) ||
    (process.platform !== 'win32' && ((root.mode | stage.mode) & 0o077) !== 0)
  ) {
    throw new Error('The Desktop update staging directory is not safe.')
  }
  if (!(await isRegularFile(path.join(plan.operationPath, 'operation.json')))) {
    throw new Error('The Desktop update operation record is missing.')
  }
}

export async function launchDesktopInstallHelper(plan: DesktopInstallPlan): Promise<void> {
  await verifyStage(plan)
  if (plan.pendingPath !== path.join(plan.stageRoot, 'pending.json'))
    throw new Error('Invalid pending update path.')
  if (plan.location.platform === 'linux' && plan.location.packageType === 'app-zip') {
    return launchDirectoryInstall(plan)
  }
  if (plan.location.platform === 'win32' && plan.location.packageType === 'squirrel')
    return launchSquirrelInstall(plan)
  if (plan.location.platform === 'linux' && ['deb', 'rpm'].includes(plan.location.packageType)) {
    return launchLinuxPackageInstall(plan)
  }
  throw new Error('This installed Desktop package type cannot be replaced safely.')
}

async function launchDirectoryInstall(plan: DesktopInstallPlan): Promise<void> {
  const { location, operationId, operationPath, stageRoot, payload } = plan
  if (location.platform !== 'linux') {
    throw new Error('Automatic directory installation is supported only for Linux.')
  }
  const installRoot = await realpath(location.installRoot)
  const writable = await access(path.dirname(installRoot), constants.W_OK).then(
    () => true,
    () => false
  )
  if (!writable) {
    throw new Error('The Linux Forge ZIP install folder is not user-writable; install it manually.')
  }
  const fresh = installRoot + '.evenfire-new-' + operationId
  const old = installRoot + '.evenfire-rollback-' + operationId
  const asar = path.join(payload.appPath, 'resources/app.asar')
  const digest = await readFileSha256(asar)
  const args = [
    stageRoot,
    operationPath,
    operationId,
    installRoot,
    payload.appPath,
    fresh,
    old,
    digest,
    String(payload.updaterCapable),
    String(process.pid),
    path.join(stageRoot, 'pending.json'),
    payload.appVersion,
  ]
  await launchDetachedAndWaitForMarker(
    '/bin/sh',
    ['-s', ...args],
    path.join(operationPath, 'helper.pid'),
    USER_DIR_SCRIPT
  )
}

async function launchSquirrelInstall(plan: DesktopInstallPlan): Promise<void> {
  const { location, operationId, operationPath, stageRoot, pendingPath, payload } = plan
  if (!location.updateExecutablePath) throw new Error('The Squirrel updater executable is missing.')
  const targetAsar = await readFileSha256(path.join(payload.appPath, 'resources', 'app.asar'))
  const encoded = Buffer.from(WINDOWS_BODY, 'utf16le').toString('base64')
  const installPlan = JSON.stringify({
    stageRoot,
    operationPath,
    operationId,
    pendingPath,
    installRoot: location.installRoot,
    setupPath: payload.packagePath,
    setupDigest: plan.targetPackageSha256,
    version: payload.appVersion,
    targetAsar,
    updaterCapable: payload.updaterCapable,
    parentPid: process.pid,
    currentVersion: plan.currentVersion,
    currentAsar: plan.currentAsarSha256,
  })
  await launchDetachedAndWaitForMarker(
    windowsPowerShellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    path.join(operationPath, 'helper.pid'),
    installPlan
  )
}

async function launchLinuxPackageInstall(plan: DesktopInstallPlan): Promise<void> {
  if (!plan.rollbackPackagePath || !plan.rollbackPackageSha256) {
    throw new Error(
      'A verified rollback package is unavailable; the current app was left unchanged.'
    )
  }
  const { location, operationId, operationPath, stageRoot, pendingPath, payload } = plan
  const targetAsar = await readFileSha256(path.join(payload.appPath, 'resources', 'app.asar'))
  const rootScript = Buffer.from(LINUX_ROOT_SCRIPT).toString('base64')
  const args = [
    stageRoot,
    operationPath,
    operationId,
    location.packageType,
    payload.packagePath,
    plan.targetPackageSha256,
    plan.rollbackPackagePath,
    plan.rollbackPackageSha256,
    LINUX_PACKAGE_EXECUTABLE,
    payload.appVersion,
    targetAsar,
    String(payload.updaterCapable),
    String(process.pid),
    plan.currentVersion,
    plan.currentAsarSha256,
    pendingPath,
    rootScript,
  ]
  await launchDetachedAndWaitForMarker(
    '/bin/sh',
    ['-s', ...args],
    path.join(stageRoot, 'privileged-ready'),
    LINUX_PACKAGE_SCRIPT
  )
}
