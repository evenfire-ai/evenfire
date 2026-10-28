import path from 'node:path'

/** Build the minimal Windows environment needed by the fixed session-authority PowerShell tools. */
export function createWindowsSessionAuthorityPowerShellEnvironment(
  systemRoot: string,
  temporaryDirectory: string
): Record<string, string> {
  if (!path.win32.isAbsolute(systemRoot) || !path.win32.isAbsolute(temporaryDirectory))
    throw new Error('Windows session authority PowerShell environment is invalid')

  const system32 = path.win32.join(systemRoot, 'System32')
  const windowsPowerShell = path.win32.join(system32, 'WindowsPowerShell', 'v1.0')
  const systemDrive = path.win32.parse(systemRoot).root.replace(/[\\/]+$/, '')
  if (!systemDrive) throw new Error('Windows session authority PowerShell environment is invalid')

  const pathEntries = [
    system32,
    path.win32.join(system32, 'Wbem'),
    windowsPowerShell,
    path.win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
    path.win32.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319'),
  ]

  return {
    COMSPEC: path.win32.join(system32, 'cmd.exe'),
    PATH: pathEntries.join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemDrive: systemDrive,
    SystemRoot: systemRoot,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    WINDIR: systemRoot,
  }
}
