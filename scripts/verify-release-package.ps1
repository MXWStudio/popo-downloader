[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$ManifestPath = '',
  [string]$PackagePath = ''
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
$manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
if (-not $PackagePath) {
  $PackagePath = Join-Path (Split-Path -Parent $manifestPath) ([string]$manifest.artifact)
}
$packagePath = (Resolve-Path -LiteralPath $PackagePath).Path

$actualSize = (Get-Item -LiteralPath $packagePath).Length
$actualHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSize -ne [long]$manifest.size) { throw 'Package size does not match latest.json.' }
if ($actualHash -ne [string]$manifest.sha256) { throw 'Package SHA-256 does not match latest.json.' }
if ([System.IO.Path]::GetFileName($packagePath) -ne [string]$manifest.artifact) {
  throw 'Package filename does not match latest.json.'
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
  [string]$manifest.publishedAt,
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
  SignatureValid = $signatureValid
  RequiredEntries = $requiredEntries.Count
} | ConvertTo-Json -Compress
