import { spawnSync } from 'node:child_process'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const appDirectory = path.resolve(scriptDirectory, '..')
const sourcePath = path.join(appDirectory, 'native', 'WindowsSessionAuthorityNative.cs')
const resourcesDirectory = path.join(appDirectory, 'resources')
const outputPath = path.join(resourcesDirectory, 'WindowsSessionAuthorityNative.dll')

const requireWindows = process.argv.includes('--require-windows')
if (process.platform !== 'win32') {
  if (requireWindows) {
    throw new Error('Windows packaging requires a Windows host to build its native helper')
  }
  process.exit(0)
}

const systemRoot = process.env.SystemRoot
const temporaryDirectory = process.env.TEMP ?? process.env.TMP
if (!systemRoot || !temporaryDirectory) {
  throw new Error('Windows session authority native helper requires system directories')
}

await mkdir(resourcesDirectory, { recursive: true })
const temporaryOutput = path.join(resourcesDirectory, `.session-authority-${process.pid}.dll`)
await rm(temporaryOutput, { force: true })

const system32 = path.win32.join(systemRoot, 'System32')
const powershellDirectory = path.win32.join(system32, 'WindowsPowerShell', 'v1.0')
const powershell = path.join(powershellDirectory, 'powershell.exe')
const pathEntries = [
  system32,
  path.win32.join(system32, 'Wbem'),
  powershellDirectory,
  path.win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
  path.win32.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319'),
]
const environment = {
  COMSPEC: path.win32.join(system32, 'cmd.exe'),
  PATH: pathEntries.join(';'),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SystemDrive: path.win32.parse(systemRoot).root.replace(/[\\/]+$/, ''),
  SystemRoot: systemRoot,
  TEMP: temporaryDirectory,
  TMP: temporaryDirectory,
  WINDIR: systemRoot,
  EVENFIRE_SESSION_AUTHORITY_NATIVE_SOURCE: sourcePath,
  EVENFIRE_SESSION_AUTHORITY_NATIVE_OUTPUT: temporaryOutput,
}
const command = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = [Environment]::GetEnvironmentVariable('EVENFIRE_SESSION_AUTHORITY_NATIVE_SOURCE')
$output = [Environment]::GetEnvironmentVariable('EVENFIRE_SESSION_AUTHORITY_NATIVE_OUTPUT')
Add-Type -Path $source -OutputAssembly $output -OutputType Library -ErrorAction Stop
if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'native-assembly-not-created' }
`
const result = spawnSync(
  powershell,
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
  {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  }
)

if (result.error || result.status !== 0 || result.signal) {
  await rm(temporaryOutput, { force: true })
  const diagnosticText = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const compilerCodes = [...diagnosticText.matchAll(/\berror\s+(CS\d+)\b/gi)].map(match =>
    match[1].toUpperCase()
  )
  const processErrorCode =
    typeof result.error?.code === 'string' &&
    ['EACCES', 'EINVAL', 'ENOENT', 'EPERM', 'ETIMEDOUT'].includes(result.error.code)
      ? result.error.code
      : result.error
        ? 'OTHER'
        : undefined
  throw new Error(
    `Windows session authority native helper build failed: ${JSON.stringify({
      processErrorCode,
      exitStatus: result.status,
      processSignaled: Boolean(result.signal),
      stdoutPresent: Boolean(result.stdout),
      stderrPresent: Boolean(result.stderr),
      compilerCodes: [...new Set(compilerCodes)],
    })}`
  )
}

await rename(temporaryOutput, outputPath)
console.log('Prepared the Windows session authority native helper.')
