param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$GrantRead
)

$ErrorActionPreference = 'Stop'
if (-not $env:GFS_Q_USERNAME -or -not $env:GFS_Q_PASSWORD) {
  throw 'A task-scoped secondary Windows principal is required for this test.'
}

$account = "$env:COMPUTERNAME\$env:GFS_Q_USERNAME"
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$qSid = ([System.Security.Principal.NTAccount]::new($account)).Translate(
  [System.Security.Principal.SecurityIdentifier]
).Value
if ($currentSid -eq $qSid) {
  throw 'The secondary Q principal must have a distinct Windows SID.'
}
if ($GrantRead) {
  $icacls = Join-Path $env:SystemRoot 'System32\\icacls.exe'
  $grant = "${account}:(R)"
  $output = & $icacls $Path /grant $grant 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "icacls could not establish the Q-token positive control: $output"
  }
}

$pathBase64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Path))
$probe = @"
`$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$pathBase64'))
try {
  `$stream = [System.IO.File]::OpenRead(`$target)
  `$stream.Dispose()
  exit 0
} catch [System.UnauthorizedAccessException] {
  exit 5
} catch [System.IO.IOException] {
  `$win32 = `$_.Exception.HResult -band 0xFFFF
  exit `$win32
}
"@
$encodedProbe = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
$securePassword = ConvertTo-SecureString $env:GFS_Q_PASSWORD -AsPlainText -Force
$credential = [System.Management.Automation.PSCredential]::new($account, $securePassword)
$arguments = "-NoProfile -NonInteractive -EncodedCommand $encodedProbe"
$powerShellHost = if ($env:EVENFIRE_GFS_POWERSHELL_PATH) {
  $env:EVENFIRE_GFS_POWERSHELL_PATH
} else {
  Join-Path $PSHOME 'pwsh.exe'
}
$process = Start-Process -FilePath $powerShellHost `
  -Credential $credential -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
Write-Output "Q_EXIT=$($process.ExitCode)"
