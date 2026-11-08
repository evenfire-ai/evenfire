param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$GrantRead
)

$ErrorActionPreference = 'Stop'
if (-not $env:GFS_Q_USERNAME -or -not $env:GFS_Q_PASSWORD) {
  throw 'A task-scoped secondary Windows principal is required for this test.'
}

$account = "$env:COMPUTERNAME\$env:GFS_Q_USERNAME"
if ($GrantRead) {
  $acl = Get-Acl -LiteralPath $Path
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $account,
    [System.Security.AccessControl.FileSystemRights]::Read,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
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
$process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
  -Credential $credential -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
Write-Output "Q_EXIT=$($process.ExitCode)"
