[CmdletBinding()]
param(
  [string]$PackageExe = '',
  [string]$PackageZip = '',
  [string]$CaseLabel = 'release-candidate',
  [string]$InstallRootOverride = '',
  [switch]$RunAcceptance
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$qaRoot = [System.IO.Path]::GetFullPath('D:\POPO\Candidate\078').TrimEnd('\')
$stableRoot = [System.IO.Path]::GetFullPath('D:\POPO\Stable\POPOStableDownloader').TrimEnd('\')
$devRoot = [System.IO.Path]::GetFullPath('D:\POPO\Dev\POPODevDownloader').TrimEnd('\')
$manifest = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'manifest.json')) | ConvertFrom-Json
$version = [string]$manifest.version_name
$packageName = "POPO-Stable-Downloader-$version-win-x64"
if (-not $PackageZip) { $PackageZip = Join-Path $repoRoot "dist\$packageName.zip" }
if (-not $PackageExe) { $PackageExe = Join-Path $repoRoot "dist\$packageName.exe" }
$PackageZip = [System.IO.Path]::GetFullPath($PackageZip)
$PackageExe = [System.IO.Path]::GetFullPath($PackageExe)

function Assert-NoReparseAncestor([string]$Path, [string]$Purpose) {
  $current = [System.IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unsafe $Purpose uses a reparse point: $current"
      }
    }
    $parent = [System.IO.Path]::GetDirectoryName($current.TrimEnd('\'))
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
}

function Assert-UnderQaRoot([string]$Path, [string]$Purpose) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not $full.StartsWith($qaRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
      $full -eq $qaRoot -or $full -eq $stableRoot -or $full -eq $devRoot -or $full -eq $repoRoot) {
    throw "Unsafe $Purpose outside the fixed QA root: $full"
  }
  Assert-NoReparseAncestor $full $Purpose
  return $full
}

function Get-Sha256Hex([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Get-CandidateRelativePath([string]$PayloadRelative) {
  $relative = $PayloadRelative.Replace('/', '\').TrimStart('\')
  foreach ($mapping in @(
    [pscustomobject]@{ Source = 'Gopeed'; Target = 'NativeHost\Gopeed' },
    [pscustomobject]@{ Source = 'extension'; Target = 'Extension' },
    [pscustomobject]@{ Source = 'native-host\bin'; Target = 'NativeHost' },
    [pscustomobject]@{ Source = 'agent\bin'; Target = 'Agent' }
  )) {
    if ($relative -eq $mapping.Source) { return $mapping.Target }
    if ($relative.StartsWith($mapping.Source + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      return $mapping.Target + $relative.Substring($mapping.Source.Length)
    }
  }
  return $null
}

function Get-PathBudget([string]$ZipPath, [string]$InstallRoot) {
  if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw "Release ZIP not found: $ZipPath"
  }
  $install = Assert-UnderQaRoot $InstallRoot 'install root'
  $transactionId = '20260828123456789-' + ('a' * 32)
  $candidateRoot = Join-Path (Join-Path $install 'Updates') ('candidate-' + $transactionId)
  $rollbackRoot = Join-Path (Join-Path $install 'Rollback') $transactionId
  $bootstrapperRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('POPO-Installer-' + ('a' * 32))
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $rootPrefix = $packageName + '/'
    $fileLengths = [System.Collections.Generic.List[int]]::new()
    $directoryLengths = [System.Collections.Generic.List[int]]::new()
    $bootstrapperFileLengths = [System.Collections.Generic.List[int]]::new()
    $bootstrapperDirectoryLengths = [System.Collections.Generic.List[int]]::new()
    $longestCandidatePath = ''
    $longestCandidateLength = 0
    $entryCount = 0
    foreach ($entry in $archive.Entries) {
      $archivePath = $entry.FullName.Replace('\', '/')
      if (-not $archivePath.StartsWith($rootPrefix, [System.StringComparison]::Ordinal) -or
          $archivePath.Length -le $rootPrefix.Length) {
        throw "ZIP entry is outside the official payload root: $archivePath"
      }
      $payloadRelative = $archivePath.Substring($rootPrefix.Length).Replace('/', '\').TrimEnd('\')
      if ([System.IO.Path]::IsPathRooted($payloadRelative) -or $payloadRelative.Split('\') -contains '..') {
        throw "Unsafe ZIP entry: $archivePath"
      }
      $entryCount++
      $bootstrapperPath = Join-Path $bootstrapperRoot $payloadRelative
      if ([string]::IsNullOrEmpty($entry.Name)) {
        $bootstrapperDirectoryLengths.Add($bootstrapperPath.Length)
      } else {
        $bootstrapperFileLengths.Add($bootstrapperPath.Length)
        $bootstrapperDirectoryLengths.Add([System.IO.Path]::GetDirectoryName($bootstrapperPath).Length)
      }
      $candidateRelative = Get-CandidateRelativePath $payloadRelative
      if (-not $candidateRelative) { continue }
      foreach ($base in @($candidateRoot, $rollbackRoot)) {
        $projected = Join-Path $base $candidateRelative
        if ([string]::IsNullOrEmpty($entry.Name)) {
          $directoryLengths.Add($projected.Length)
        } else {
          $fileLengths.Add($projected.Length)
          $directoryLengths.Add([System.IO.Path]::GetDirectoryName($projected).Length)
        }
        if ($base -eq $candidateRoot -and $projected.Length -gt $longestCandidateLength) {
          $longestCandidateLength = $projected.Length
          $longestCandidatePath = $projected
        }
      }
    }
  } finally {
    $archive.Dispose()
  }
  $maxFile = ($fileLengths | Measure-Object -Maximum).Maximum
  $maxDirectory = ($directoryLengths | Measure-Object -Maximum).Maximum
  $maxBootstrapperFile = ($bootstrapperFileLengths | Measure-Object -Maximum).Maximum
  $maxBootstrapperDirectory = ($bootstrapperDirectoryLengths | Measure-Object -Maximum).Maximum
  $safe = $maxFile -lt 260 -and $maxDirectory -lt 248 -and
    $maxBootstrapperFile -lt 260 -and $maxBootstrapperDirectory -lt 248
  return [ordered]@{
    safe = $safe
    entryCount = $entryCount
    installRoot = $install
    installRootLength = $install.Length
    maxCandidateOrRollbackFileLength = $maxFile
    maxCandidateOrRollbackDirectoryLength = $maxDirectory
    maxBootstrapperFileLength = $maxBootstrapperFile
    maxBootstrapperDirectoryLength = $maxBootstrapperDirectory
    longestCandidatePath = $longestCandidatePath
    fileLimitExclusive = 260
    directoryLimitExclusive = 248
  }
}

$runId = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$installRoot = if ($InstallRootOverride) {
  Assert-UnderQaRoot $InstallRootOverride 'install root override'
} else {
  Assert-UnderQaRoot (Join-Path $qaRoot ("i-$runId")) 'generated install root'
}
$budget = Get-PathBudget $PackageZip $installRoot
if (-not $budget.safe) {
  throw "Release candidate path budget exceeded: file=$($budget.maxCandidateOrRollbackFileLength)/259, directory=$($budget.maxCandidateOrRollbackDirectoryLength)/247, installRoot=$installRoot"
}

$preflight = [ordered]@{
  mode = if ($RunAcceptance) { 'acceptance' } else { 'preflight' }
  caseLabel = $CaseLabel
  runId = $runId
  packageZip = $PackageZip
  packageZipSha256 = Get-Sha256Hex $PackageZip
  installRoot = $installRoot
  pathBudget = $budget
  writesSystemRegistration = $false
}
if (-not $RunAcceptance) {
  $preflight | ConvertTo-Json -Depth 8
  return
}

if (-not (Test-Path -LiteralPath $PackageExe -PathType Leaf)) {
  throw "Single EXE not found: $PackageExe"
}
if (Test-Path -LiteralPath $installRoot) {
  throw "Generated acceptance install root already exists: $installRoot"
}
$evidenceRoot = Assert-UnderQaRoot (Join-Path $qaRoot ("e-$runId")) 'evidence root'
if (Test-Path -LiteralPath $evidenceRoot) {
  throw "Generated evidence root already exists: $evidenceRoot"
}
New-Item -ItemType Directory -Path $evidenceRoot | Out-Null
$tempBefore = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Directory -Filter 'POPO-Installer-*' -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName)
$observedTemp = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$arguments = @('--quiet', '--skip-register', '--install-root', ('"{0}"' -f $installRoot))
$process = Start-Process -FilePath $PackageExe -ArgumentList $arguments -PassThru
while (-not $process.HasExited) {
  foreach ($directory in Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Directory -Filter 'POPO-Installer-*' -ErrorAction SilentlyContinue) {
    if ($tempBefore -notcontains $directory.FullName) { $null = $observedTemp.Add($directory.FullName) }
  }
  Start-Sleep -Milliseconds 25
  $process.Refresh()
}
$process.WaitForExit()
Start-Sleep -Milliseconds 500
$remainingTemp = @($observedTemp | Where-Object { Test-Path -LiteralPath $_ })
$installStatePath = Join-Path $installRoot 'install-state.json'
$result = [ordered]@{
  preflight = $preflight
  packageExe = $PackageExe
  packageExeSha256 = Get-Sha256Hex $PackageExe
  evidenceRoot = $evidenceRoot
  exitCode = $process.ExitCode
  observedTempRoots = @($observedTemp)
  remainingTempRoots = $remainingTemp
  installState = if (Test-Path -LiteralPath $installStatePath) {
    [System.IO.File]::ReadAllText($installStatePath) | ConvertFrom-Json
  } else { $null }
}
$reportPath = Join-Path $evidenceRoot 'candidate-install.json'
[System.IO.File]::WriteAllText($reportPath, ($result | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 12
if ($process.ExitCode -ne 0) { exit $process.ExitCode }
if (-not $result.installState -or [string]$result.installState.version -ne $version) { exit 31 }
if ($remainingTemp.Count -ne 0) { exit 32 }
