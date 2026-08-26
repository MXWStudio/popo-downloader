[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$BootstrapperPath = '',
  [string]$PreviousPackagePath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = if ($RepoRoot) {
  (Resolve-Path -LiteralPath $RepoRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$manifest = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'manifest.json')) | ConvertFrom-Json
$version = [string]$manifest.version_name
if (-not $BootstrapperPath) {
  $BootstrapperPath = Join-Path $repoRoot "dist\POPO-Stable-Downloader-$version-win-x64.exe"
}
$bootstrapperPath = (Resolve-Path -LiteralPath $BootstrapperPath).Path

$runId = [Guid]::NewGuid().ToString('N')
$tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$acceptanceName = "PB-A-$($runId.Substring(0, 8))"
$tempRoot = Join-Path $tempParent $acceptanceName
$distParent = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'dist')).TrimEnd('\')
$migrationRoot = Join-Path $distParent $acceptanceName
$initialRoot = Join-Path $tempRoot '中文 工具\POPO 下载'
$previousRoot = Join-Path $tempRoot 'previous install'
$previousPackageRoot = Join-Path $tempRoot 'previous package'

function Invoke-Installer(
  [string]$Executable,
  [string]$InstallRoot,
  [string[]]$ExtraArguments = @()
) {
  $arguments = @('--quiet', '--skip-register', '--install-root', ('"{0}"' -f $InstallRoot))
  $arguments += $ExtraArguments
  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer failed with exit code $($process.ExitCode): $Executable"
  }
  return $process.ExitCode
}

function Assert-InstalledLayout([string]$InstallRoot, [string]$ExpectedVersion) {
  foreach ($required in @(
    'Extension\manifest.json',
    'NativeHost\Gopeed\gopeed.exe',
    'NativeHost\PopoFolderPickerHost.exe',
    'Agent\PopoAgent.exe',
    'install-state.json'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $required))) {
      throw "Installed component is missing: $required"
    }
  }
  $state = [System.IO.File]::ReadAllText((Join-Path $InstallRoot 'install-state.json')) |
    ConvertFrom-Json
  if ([string]$state.version -ne $ExpectedVersion) {
    throw "Installed version mismatch: $($state.version)"
  }
  return $state
}

function Get-InstallerTempDirectories {
  return @(
    Get-ChildItem -LiteralPath $tempParent -Directory -Filter 'POPO-Installer-*' -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName }
  )
}

function Remove-AcceptanceRoot([string]$Path, [string]$ExpectedParent) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ([System.IO.Path]::GetDirectoryName($resolved) -ne $ExpectedParent -or
      -not [System.IO.Path]::GetFileName($resolved).StartsWith('PB-A-')) {
    throw "Refusing to remove an unexpected acceptance path: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

$results = [ordered]@{
  Version = $version
  Bootstrapper = $bootstrapperPath
  FirstInstall = $false
  Repair = $false
  PreviousVersionOverwrite = if ($PreviousPackagePath) { $false } else { $null }
  CrossDriveMigration = $false
  ChineseAndSpacePath = $false
  UserDataPreserved = $false
  TempCleanup = $false
}
$tempBefore = @(Get-InstallerTempDirectories)
try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $migrationRoot -Force | Out-Null

  [void](Invoke-Installer $bootstrapperPath $initialRoot)
  [void](Assert-InstalledLayout $initialRoot $version)
  $results.FirstInstall = $true
  $results.ChineseAndSpacePath = $true

  $historyPath = Join-Path $initialRoot 'NativeHost\Gopeed\storage\acceptance-history.txt'
  New-Item -ItemType Directory -Path (Split-Path -Parent $historyPath) -Force | Out-Null
  [System.IO.File]::WriteAllText($historyPath, 'must survive repair and migration')

  [void](Invoke-Installer $bootstrapperPath $initialRoot @('--repair'))
  $repairState = Assert-InstalledLayout $initialRoot $version
  if ([string]$repairState.updateMode -ne 'repair') {
    throw "Expected repair update mode, found: $($repairState.updateMode)"
  }
  if ([System.IO.File]::ReadAllText($historyPath) -ne 'must survive repair and migration') {
    throw 'Gopeed user data was not preserved during repair.'
  }
  $results.Repair = $true

  if ($PreviousPackagePath) {
    $previousPackagePath = (Resolve-Path -LiteralPath $PreviousPackagePath).Path
    $checksumPath = "$previousPackagePath.sha256.txt"
    if (Test-Path -LiteralPath $checksumPath) {
      $expectedHash = ([System.IO.File]::ReadAllText($checksumPath).Trim() -split '\s+')[0].ToLowerInvariant()
      $actualHash = (Get-FileHash -LiteralPath $previousPackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $expectedHash) { throw 'Previous package checksum does not match.' }
    }
    Expand-Archive -LiteralPath $previousPackagePath -DestinationPath $previousPackageRoot
    $previousSetup = Get-ChildItem -LiteralPath $previousPackageRoot -Filter 'POPO-Setup.exe' -Recurse -File |
      Select-Object -First 1
    if (-not $previousSetup) { throw 'Previous package Setup was not found.' }
    [void](Invoke-Installer $previousSetup.FullName $previousRoot)
    $previousState = [System.IO.File]::ReadAllText((Join-Path $previousRoot 'install-state.json')) |
      ConvertFrom-Json
    [void](Assert-InstalledLayout $previousRoot ([string]$previousState.version))
    if ([string]$previousState.version -eq $version) {
      throw 'Previous package is not older than the current Bootstrapper.'
    }
    $previousHistory = Join-Path $previousRoot 'NativeHost\Gopeed\storage\acceptance-history.txt'
    New-Item -ItemType Directory -Path (Split-Path -Parent $previousHistory) -Force | Out-Null
    [System.IO.File]::WriteAllText($previousHistory, 'must survive overwrite')
    [void](Invoke-Installer $bootstrapperPath $previousRoot)
    [void](Assert-InstalledLayout $previousRoot $version)
    if ([System.IO.File]::ReadAllText($previousHistory) -ne 'must survive overwrite') {
      throw 'Gopeed user data was not preserved during overwrite.'
    }
    $results.PreviousVersionOverwrite = $true
  }

  $migrationArguments = @('--migrate-from', ('"{0}"' -f $initialRoot))
  [void](Invoke-Installer $bootstrapperPath $migrationRoot $migrationArguments)
  $migrationState = Assert-InstalledLayout $migrationRoot $version
  $migratedHistory = Join-Path $migrationRoot 'NativeHost\Gopeed\storage\acceptance-history.txt'
  if ([System.IO.File]::ReadAllText($migratedHistory) -ne 'must survive repair and migration') {
    throw 'Gopeed user data was not preserved during migration.'
  }
  $migrationMarker = [System.IO.File]::ReadAllText((Join-Path $initialRoot 'migration-state.json')) |
    ConvertFrom-Json
  if ([System.IO.Path]::GetFullPath([string]$migrationMarker.migratedTo) -ne
      [System.IO.Path]::GetFullPath($migrationRoot)) {
    throw 'Migration marker does not point to the new install root.'
  }
  $results.CrossDriveMigration = (
    [System.IO.Path]::GetPathRoot($initialRoot) -ne [System.IO.Path]::GetPathRoot($migrationRoot)
  )
  if (-not $results.CrossDriveMigration) { throw 'Acceptance roots are not on different drives.' }
  $results.UserDataPreserved = $true

  $tempAfter = @(Get-InstallerTempDirectories)
  $newTempDirectories = @($tempAfter | Where-Object { $_ -notin $tempBefore })
  if ($newTempDirectories.Count -ne 0) {
    throw "Bootstrapper TEMP directories were not cleaned: $($newTempDirectories -join ', ')"
  }
  $results.TempCleanup = $true
  [pscustomobject]$results | ConvertTo-Json -Compress
}
finally {
  Remove-AcceptanceRoot $tempRoot $tempParent
  Remove-AcceptanceRoot $migrationRoot $distParent
}
