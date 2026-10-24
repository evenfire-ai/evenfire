$ErrorActionPreference = 'Stop'

$assetName = 'evenfire-desktop-v0.11.0-windows-x64.zip'
$assetUrl = 'https://github.com/evenfire-ai/evenfire/releases/download/v0.11.0/evenfire-desktop-v0.11.0-windows-x64.zip'
$expectedSha256 = '9101d2a7c2fc49c6f64c15fc889523a8d830dd8779278dc69256317c6bbc9f41'
$releaseRoot = Join-Path $env:RUNNER_TEMP 'pr977-v011-official-release'
$outerArchive = Join-Path $releaseRoot $assetName
$outerExtract = Join-Path $releaseRoot 'outer'
$innerExtract = Join-Path $releaseRoot 'windows-x64'

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
curl.exe --fail --location --silent --show-error $assetUrl --output $outerArchive
if ($LASTEXITCODE -ne 0) {
  throw "Official v0.11.0 release download failed with curl exit $LASTEXITCODE"
}

$actualSha256 = (Get-FileHash -LiteralPath $outerArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw 'Official v0.11.0 release package SHA-256 did not match the verified release digest'
}

Expand-Archive -LiteralPath $outerArchive -DestinationPath $outerExtract -Force
$innerArchive = Join-Path $outerExtract 'zip/win32/x64/Evenfire-win32-x64-0.11.0.zip'
if (-not (Test-Path -LiteralPath $innerArchive -PathType Leaf)) {
  throw 'Official release package did not contain the expected v0.11.0 Windows application zip'
}
Expand-Archive -LiteralPath $innerArchive -DestinationPath $innerExtract -Force

$executables = @(Get-ChildItem -LiteralPath $innerExtract -Filter 'Evenfire.exe' -File -Recurse)
if ($executables.Count -ne 1) {
  throw "Expected one packaged Evenfire.exe, found $($executables.Count)"
}

$executable = $executables[0].FullName
$productVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
if (-not $productVersion.StartsWith('0.11.0', [StringComparison]::Ordinal)) {
  throw "Packaged executable version did not identify v0.11.0 (observed $productVersion)"
}

$signatureStatus = 'unavailable'
try {
  $signatureStatus = (Get-AuthenticodeSignature -FilePath $executable).Status.ToString()
} catch {
  $signatureStatus = 'unavailable'
}

Write-Output "Release asset: $assetName"
Write-Output "Verified SHA-256: $actualSha256"
Write-Output "Packaged executable product version: $productVersion"
Write-Output "Authenticode status: $signatureStatus (release digest remains the integrity check)"
"EVENFIRE_V011_EXE=$executable" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"EVENFIRE_V011_PRODUCT_VERSION=$productVersion" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
