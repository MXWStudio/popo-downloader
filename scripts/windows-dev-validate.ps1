[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [switch]$NoSync
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$syncExtension = -not $NoSync
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
  throw 'Remote POPO validation must run on Windows.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
  throw "Remote validation source is not a Git working tree: $repo"
}
$system32 = Join-Path $env:SystemRoot 'System32'
if (-not (Test-Path -LiteralPath (Join-Path $system32 'whoami.exe') -PathType Leaf)) {
  throw "Windows System32 tools were not found: $system32"
}
# Git Bash is the SSH transport shell. Prefer the real Windows utilities when
# PowerShell tests invoke names such as whoami.exe.
$env:PATH = "$system32;$env:PATH"

Push-Location $repo
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

  & npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { throw 'Playwright Chromium installation failed.' }

  & npm run check:full:windows
  if ($LASTEXITCODE -ne 0) { throw 'Full Windows verification failed.' }

  $syncResult = $null
  if ($syncExtension) {
    $syncOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-dev-extension.ps1 -RepoRoot $repo
    if ($LASTEXITCODE -ne 0) { throw 'Dev Extension synchronization failed.' }
    $syncResult = $syncOutput | Select-Object -Last 1 | ConvertFrom-Json
  }

  [pscustomobject]@{
    Status = 'PASS'
    Commit = (& git rev-parse HEAD).Trim()
    WorkingTreeChanges = @(& git status --short).Count
    ExtensionSynchronized = [bool]$syncExtension
    DevTargetDirectory = if ($syncResult) { [string]$syncResult.TargetDirectory } else { '' }
    DevExtensionId = if ($syncResult) { [string]$syncResult.DevExtensionId } else { '' }
    VersionName = if ($syncResult) { [string]$syncResult.VersionName } else { '' }
  } | ConvertTo-Json -Compress
}
finally {
  Pop-Location
}
