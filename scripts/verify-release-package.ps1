[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$ManifestPath = '',
  [string]$PackagePath = '',
  [string]$BootstrapperPath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repoRoot = if ($RepoRoot) {
  (Resolve-Path -LiteralPath $RepoRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
if (-not $ManifestPath) { $ManifestPath = Join-Path $repoRoot 'dist\latest.json' }
$manifestPath = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifestJson = [System.IO.File]::ReadAllText($manifestPath)
$manifest = $manifestJson | ConvertFrom-Json
$publishedAtMatch = [regex]::Match(
  $manifestJson,
  '"publishedAt"\s*:\s*"([^"\\]+)"'
)
if (-not $publishedAtMatch.Success) {
  throw 'latest.json publishedAt must be a non-empty JSON string.'
}
$manifestPublishedAt = $publishedAtMatch.Groups[1].Value
if (-not ([string]$manifest.artifact).EndsWith('.zip', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'latest.json must continue to reference the official ZIP.'
}
if (-not ([string]$manifest.url).EndsWith('/' + [string]$manifest.artifact, [System.StringComparison]::Ordinal)) {
  throw 'latest.json URL must reference the official ZIP artifact.'
}
if (-not $PackagePath) {
  $PackagePath = Join-Path (Split-Path -Parent $manifestPath) ([string]$manifest.artifact)
}
$packagePath = (Resolve-Path -LiteralPath $PackagePath).Path
$expectedBootstrapperName = "POPO-Stable-Downloader-$($manifest.version)-win-x64.exe"
if (-not $BootstrapperPath) {
  $BootstrapperPath = Join-Path (Split-Path -Parent $manifestPath) $expectedBootstrapperName
}
$bootstrapperPath = (Resolve-Path -LiteralPath $BootstrapperPath).Path
$bootstrapperChecksumPath = (Resolve-Path -LiteralPath "$bootstrapperPath.sha256.txt").Path

$actualSize = (Get-Item -LiteralPath $packagePath).Length
$actualHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSize -ne [long]$manifest.size) { throw 'Package size does not match latest.json.' }
if ($actualHash -ne [string]$manifest.sha256) { throw 'Package SHA-256 does not match latest.json.' }
if ([System.IO.Path]::GetFileName($packagePath) -ne [string]$manifest.artifact) {
  throw 'Package filename does not match latest.json.'
}
if ([System.IO.Path]::GetFileName($bootstrapperPath) -ne $expectedBootstrapperName) {
  throw 'Bootstrapper filename does not match the stable release version.'
}
$bootstrapperHash = (Get-FileHash -LiteralPath $bootstrapperPath -Algorithm SHA256).Hash.ToLowerInvariant()
$bootstrapperChecksum = [System.IO.File]::ReadAllText($bootstrapperChecksumPath).Trim()
$expectedBootstrapperChecksum = "$bootstrapperHash  $expectedBootstrapperName"
if ($bootstrapperChecksum -ne $expectedBootstrapperChecksum) {
  throw 'Bootstrapper SHA-256 file does not match the EXE.'
}
$bootstrapperVersionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($bootstrapperPath)
$manifestVersionMatch = [regex]::Match(
  [string]$manifest.version,
  '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$'
)
if (-not $manifestVersionMatch.Success) {
  throw 'Stable release version must contain three or four numeric components.'
}
$expectedBootstrapperFileVersion = if ($manifestVersionMatch.Groups[4].Success) {
  [string]$manifest.version
} else {
  "$([string]$manifest.version).0"
}
if ([string]$bootstrapperVersionInfo.FileVersion -ne $expectedBootstrapperFileVersion -or
    [string]$bootstrapperVersionInfo.ProductVersion -ne [string]$manifest.version) {
  throw 'Bootstrapper Windows version metadata does not match the stable release version.'
}

$bootstrapperAssembly = [System.Reflection.Assembly]::LoadFile($bootstrapperPath)
$resourceName = 'POPO.ReleasePayload.zip'
if ($bootstrapperAssembly.GetManifestResourceNames() -notcontains $resourceName) {
  throw 'Bootstrapper embedded payload resource is missing.'
}
$payloadStream = $bootstrapperAssembly.GetManifestResourceStream($resourceName)
try {
  $payloadHasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $embeddedPayloadHash = ([BitConverter]::ToString(
      $payloadHasher.ComputeHash($payloadStream)
    )).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $payloadHasher.Dispose()
  }
}
finally {
  $payloadStream.Dispose()
}
if ($embeddedPayloadHash -ne $actualHash) {
  throw 'Bootstrapper embedded payload does not match the official ZIP.'
}

$nativeSource = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'native-host\FolderPickerHost.cs'))
$publicKeyMatch = [regex]::Match(
  $nativeSource,
  'UpdateSigningPublicKeyBase64\s*=\s*"([A-Za-z0-9+/=]+)"'
)
if (-not $publicKeyMatch.Success) { throw 'Updater public key was not found in the native host.' }
$publicXml = [System.Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($publicKeyMatch.Groups[1].Value)
)
$canonical = @(
  [string]$manifest.schemaVersion,
  [string]$manifest.channel,
  [string]$manifest.version,
  [string]$manifest.chromeVersion,
  $manifestPublishedAt,
  [string]$manifest.artifact,
  [string]$manifest.url,
  [string]$manifest.sha256,
  [string]$manifest.size
) -join "`n"
$rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
try {
  $rsa.FromXmlString($publicXml)
  $signatureValid = $rsa.VerifyData(
    [System.Text.Encoding]::UTF8.GetBytes($canonical),
    [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'),
    [Convert]::FromBase64String([string]$manifest.signature)
  )
}
finally {
  $rsa.Dispose()
}
if (-not $signatureValid) { throw 'latest.json release signature is invalid.' }

$expectedRoot = "POPO-Stable-Downloader-$($manifest.version)-win-x64/"
$requiredEntries = @(
  ($expectedRoot + 'POPO-Setup.exe'),
  ($expectedRoot + 'extension/manifest.json'),
  ($expectedRoot + 'extension/runtime/popo-runtime.js'),
  ($expectedRoot + 'extension/runtime/popo-runtime.cjs'),
  ($expectedRoot + 'native-host/bin/PopoFolderPickerHost.exe'),
  ($expectedRoot + 'native-host/bin/.popo-native-version'),
  ($expectedRoot + 'agent/bin/PopoAgent.exe'),
  ($expectedRoot + 'agent/bin/.popo-agent-version'),
  ($expectedRoot + 'agent/bin/release-manifest.json'),
  ($expectedRoot + 'release-manifest.json'),
  ($expectedRoot + 'Gopeed/gopeed.exe')
)
$archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
try {
  $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  foreach ($required in $requiredEntries) {
    if ($entryNames -notcontains $required) { throw "Package entry is missing: $required" }
  }
  $extensionManifestEntry = $archive.Entries | Where-Object {
    $_.FullName.Replace('\', '/') -eq ($expectedRoot + 'extension/manifest.json')
  } | Select-Object -First 1
  $reader = New-Object System.IO.StreamReader($extensionManifestEntry.Open())
  try {
    $extensionManifest = $reader.ReadToEnd() | ConvertFrom-Json
  }
  finally {
    $reader.Dispose()
  }
  if ([string]$extensionManifest.version_name -ne [string]$manifest.version) {
    throw 'Packaged extension version does not match latest.json.'
  }
  if ([string]$extensionManifest.version -ne [string]$manifest.chromeVersion) {
    throw 'Packaged Chrome version does not match latest.json.'
  }
  $runtimeEntry = $archive.Entries | Where-Object {
    $_.FullName.Replace('\', '/') -eq ($expectedRoot + 'extension/runtime/popo-runtime.js')
  } | Select-Object -First 1
  $runtimeReader = New-Object System.IO.StreamReader($runtimeEntry.Open())
  try {
    $runtimeSource = $runtimeReader.ReadToEnd()
  }
  finally {
    $runtimeReader.Dispose()
  }
  if ($runtimeSource -notmatch 'https://[A-Za-z0-9_-]{8,128}@[A-Za-z0-9.-]+\.ingest(?:\.us)?\.sentry\.io/\d{1,32}') {
    throw 'Packaged stable runtime does not contain a valid official diagnostic receiver.'
  }
  $releaseManifestEntry = $archive.Entries | Where-Object {
    $_.FullName.Replace('\', '/') -eq ($expectedRoot + 'release-manifest.json')
  } | Select-Object -First 1
  $releaseReader = New-Object System.IO.StreamReader($releaseManifestEntry.Open())
  try {
    $releaseManifest = $releaseReader.ReadToEnd() | ConvertFrom-Json
  }
  finally {
    $releaseReader.Dispose()
  }
  foreach ($property in @(
    'releaseVersion',
    'extensionVersion',
    'agentVersion',
    'nativeHostVersion',
    'installerVersion'
  )) {
    if ([string]$releaseManifest.$property -ne [string]$manifest.version) {
      throw "Packaged component version is inconsistent: $property"
    }
  }
  if ([int]$releaseManifest.updateProtocol -ne 2 -or
      [int]$releaseManifest.minimumProtocol -ne 1) {
    throw 'Packaged update protocol is not compatible with the bridge agent.'
  }
}
finally {
  $archive.Dispose()
}

[pscustomobject]@{
  Ok = $true
  Version = [string]$manifest.version
  Channel = [string]$manifest.channel
  Package = $packagePath
  Size = $actualSize
  Sha256 = $actualHash
  Bootstrapper = $bootstrapperPath
  BootstrapperFileVersion = [string]$bootstrapperVersionInfo.FileVersion
  BootstrapperProductVersion = [string]$bootstrapperVersionInfo.ProductVersion
  BootstrapperSha256 = $bootstrapperHash
  EmbeddedPayloadSha256 = $embeddedPayloadHash
  SignatureValid = $signatureValid
  RequiredEntries = $requiredEntries.Count
  DiagnosticReceiverConfigured = $true
} | ConvertTo-Json -Compress
