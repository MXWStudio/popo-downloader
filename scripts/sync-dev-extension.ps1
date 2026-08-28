[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$TargetDirectory = 'D:\POPODevDownloader\Extension'
)

$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot 'PopoDevExtension.psm1'
Import-Module $modulePath -Force
$config = Get-PopoDevExtensionConfig
$repo = if ($RepoRoot) {
  (Resolve-Path -LiteralPath $RepoRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

# Reject an unsafe target before running any build or changing any directory.
Assert-PopoDevSyncTarget `
  -TargetDirectory $TargetDirectory `
  -ExpectedTargetDirectory $config.DevTargetDirectory `
  -StableDirectory $config.StableDirectory `
  -RepoRoot $repo | Out-Null

& npm run build:runtime --prefix $repo
if ($LASTEXITCODE -ne 0) {
  throw 'The Extension runtime bundle failed to build; Dev synchronization was not started.'
}

$result = Invoke-PopoDevExtensionSync `
  -RepoRoot $repo `
  -TargetDirectory $TargetDirectory `
  -ExpectedTargetDirectory $config.DevTargetDirectory `
  -StableDirectory $config.StableDirectory
$result | ConvertTo-Json -Compress
