[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath,
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [string]$RepoRoot = '',
  [string]$SourcePath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256Hex([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

$repoRoot = if ($RepoRoot) {
  (Resolve-Path -LiteralPath $RepoRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$zipPath = (Resolve-Path -LiteralPath $ZipPath).Path
$sourcePath = if ($SourcePath) {
  (Resolve-Path -LiteralPath $SourcePath).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $repoRoot 'bootstrapper\PopoBootstrapper.cs')).Path
}
$outputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputPath
$versionMatch = [regex]::Match($Version, '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$')
if (-not $versionMatch.Success) {
  throw 'Bootstrapper version must contain three or four numeric components.'
}
$assemblyVersion = if ($versionMatch.Groups[4].Success) { $Version } else { "$Version.0" }
$expectedName = "POPO-Stable-Downloader-$Version-win-x64"
$expectedZipName = "$expectedName.zip"
$expectedExeName = "$expectedName.exe"
if ([System.IO.Path]::GetFileName($zipPath) -ne $expectedZipName) {
  throw "Bootstrapper ZIP name must be $expectedZipName."
}
if ([System.IO.Path]::GetFileName($outputPath) -ne $expectedExeName) {
  throw "Bootstrapper output name must be $expectedExeName."
}

$requiredEntries = @(
  "$expectedName/POPO-Setup.exe",
  "$expectedName/release-manifest.json",
  "$expectedName/extension/manifest.json",
  "$expectedName/Gopeed/gopeed.exe",
  "$expectedName/native-host/bin/PopoFolderPickerHost.exe",
  "$expectedName/agent/bin/PopoAgent.exe"
)
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  foreach ($requiredEntry in $requiredEntries) {
    if ($entryNames -notcontains $requiredEntry) {
      throw "Official ZIP is missing a Bootstrapper requirement: $requiredEntry"
    }
  }
}
finally {
  $archive.Dispose()
}

$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  throw "The Windows .NET Framework compiler was not found: $compiler"
}

$payloadHash = Get-Sha256Hex $zipPath
$resourceName = 'POPO.ReleasePayload.zip'
$source = [System.IO.File]::ReadAllText($sourcePath)
foreach ($token in @(
  '__POPO_PAYLOAD_RESOURCE_NAME__',
  '__POPO_PAYLOAD_SHA256__',
  '__POPO_PAYLOAD_ROOT_NAME__'
)) {
  if (-not $source.Contains($token)) { throw "Bootstrapper source token is missing: $token" }
}
$source = $source.Replace('__POPO_PAYLOAD_RESOURCE_NAME__', $resourceName)
$source = $source.Replace('__POPO_PAYLOAD_SHA256__', $payloadHash)
$source = $source.Replace('__POPO_PAYLOAD_ROOT_NAME__', $expectedName)

$compileRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
  'popo-bootstrapper-build-' + [Guid]::NewGuid().ToString('N')
)
$generatedSource = Join-Path $compileRoot 'PopoBootstrapper.generated.cs'
$assemblyInfoPath = Join-Path $compileRoot 'PopoBootstrapper.AssemblyInfo.cs'
$compiledOutput = Join-Path $compileRoot $expectedExeName
try {
  New-Item -ItemType Directory -Path $compileRoot -Force | Out-Null
  [System.IO.File]::WriteAllText(
    $generatedSource,
    $source,
    (New-Object System.Text.UTF8Encoding($false))
  )
  $assemblyInfo = @"
using System.Reflection;

[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]
[assembly: AssemblyInformationalVersion("$Version")]
[assembly: AssemblyTitle("POPO Stable Downloader")]
[assembly: AssemblyProduct("POPO Stable Downloader")]
"@
  [System.IO.File]::WriteAllText(
    $assemblyInfoPath,
    $assemblyInfo,
    (New-Object System.Text.UTF8Encoding($false))
  )
  $compilerArgs = @(
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/codepage:65001',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    "/resource:$zipPath,$resourceName,private",
    "/out:$compiledOutput",
    $generatedSource,
    $assemblyInfoPath
  )
  & $compiler @compilerArgs
  if ($LASTEXITCODE -ne 0) { throw 'The POPO Bootstrapper failed to compile.' }

  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
  if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
  Move-Item -LiteralPath $compiledOutput -Destination $outputPath

  $exeHash = Get-Sha256Hex $outputPath
  $checksumPath = "$outputPath.sha256.txt"
  [System.IO.File]::WriteAllText(
    $checksumPath,
    "$exeHash  $expectedExeName`r`n",
    (New-Object System.Text.UTF8Encoding($false))
  )

  [pscustomobject]@{
    Version = $Version
    FileVersion = $assemblyVersion
    ProductVersion = $Version
    Bootstrapper = $outputPath
    Sha256 = $exeHash
    Size = (Get-Item -LiteralPath $outputPath).Length
    EmbeddedPayloadSha256 = $payloadHash
  } | ConvertTo-Json -Compress
}
finally {
  if (Test-Path -LiteralPath $compileRoot) {
    Remove-Item -LiteralPath $compileRoot -Recurse -Force
  }
}
