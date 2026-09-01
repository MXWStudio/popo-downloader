Set-StrictMode -Version Latest

function Get-PopoDevExtensionConfig {
  [CmdletBinding()]
  param()

  # Keep this module ASCII-only so Windows PowerShell 5.1 can parse it without a BOM.
  $displayName = '"POPO Dev \u4e0b\u8f7d\u52a9\u624b"' | ConvertFrom-Json
  $description = '"\u4e0e\u6b63\u5f0f\u7248\u9694\u79bb\u7684 POPO \u5f00\u53d1\u4e0e\u9a8c\u6536\u52a9\u624b\u3002"' | ConvertFrom-Json
  [pscustomobject]@{
    DevTargetDirectory = 'D:\POPO\Dev\POPODevDownloader\Extension'
    StableDirectory = 'D:\POPO\Stable\POPOStableDownloader\Extension'
    DisplayName = $displayName
    Description = $description
    ExtensionKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAktkTv13QYDbQoZCW7Dnk84LsxiHEj0H2a0y7Ir8AY12pAb1hG6vfB7aQ0nyudGhxAmudVdPluPJy3zx48SHAHwu2YJDfVUIdN+LhUU6FkeN9XlHp9dtzYxyO7/oG5NS2XGBu7rPxoJS0Owme5rpj6Oks3oiFI95TaTn2DOVB7FryTbdPTvBX9czDvOxvPG45hABm0Djz/DDX5luSmCXDPCnNkERgkU4f/WTAJFble76uph6RXlyFD5PzdPETpYvngjALceH2t+FcWjf2+CZjwudPkUQRrM/Z1DF77md2ovZV8B9zQnlympk8JQCb44tY1jtvypTE9W1IHaCXjZIizwIDAQAB'
    ExtensionId = 'folfhehnopknchpoaajfpboibbhnlanf'
    RootFiles = @(
      'background.js',
      'content.js',
      'core.js',
      'queue.js',
      'gopeed.js',
      'page-api.js',
      'popup.css',
      'popup.html'
    )
    SourceDirectories = @('assets', 'runtime')
  }
}

function Get-PopoFullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Get-PopoExtensionIdFromKey {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Key)

  try {
    $keyBytes = [Convert]::FromBase64String($Key)
  } catch {
    throw "Extension manifest key is not valid Base64: $($_.Exception.Message)"
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($keyBytes)
  } finally {
    $sha.Dispose()
  }
  $characters = New-Object System.Collections.Generic.List[char]
  for ($index = 0; $index -lt 16; $index += 1) {
    $characters.Add([char]([int][char]'a' + (($hash[$index] -shr 4) -band 15)))
    $characters.Add([char]([int][char]'a' + ($hash[$index] -band 15)))
  }
  -join $characters
}

function Assert-PopoDevSyncTarget {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$TargetDirectory,
    [Parameter(Mandatory = $true)][string]$ExpectedTargetDirectory,
    [Parameter(Mandatory = $true)][string]$StableDirectory,
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )

  $target = Get-PopoFullPath $TargetDirectory
  $expected = Get-PopoFullPath $ExpectedTargetDirectory
  $stable = Get-PopoFullPath $StableDirectory
  $repo = Get-PopoFullPath $RepoRoot
  $comparison = [StringComparison]::OrdinalIgnoreCase

  if ($target.Equals($stable, $comparison) -or $target.StartsWith($stable + '\', $comparison)) {
    throw "Refusing to synchronize the Stable extension directory: $target"
  }
  if (-not $target.Equals($expected, $comparison)) {
    throw "Refusing unrecognized Dev extension target. Expected '$expected', received '$target'."
  }
  if ($target.Equals([System.IO.Path]::GetPathRoot($target).TrimEnd('\'), $comparison)) {
    throw "Refusing to synchronize a drive root: $target"
  }
  if ($target.Equals($repo, $comparison) -or $target.StartsWith($repo + '\', $comparison)) {
    throw "Refusing to synchronize into the repository: $target"
  }

  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "The fixed Dev extension parent directory does not exist: $parent"
  }
  foreach ($existingPath in @($parent, $target)) {
    if (Test-Path -LiteralPath $existingPath) {
      $item = Get-Item -LiteralPath $existingPath -Force
      if (-not $item.PSIsContainer) {
        throw "The Dev extension path is not a directory: $existingPath"
      }
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing a Dev extension path that uses a reparse point: $existingPath"
      }
    }
  }

  $target
}

function Write-PopoDevManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$SourceManifestPath,
    [Parameter(Mandatory = $true)][string]$DestinationManifestPath
  )

  $config = Get-PopoDevExtensionConfig
  $manifest = [System.IO.File]::ReadAllText($SourceManifestPath) | ConvertFrom-Json
  if (-not [string]$manifest.version) {
    throw 'Source manifest.json version is required.'
  }
  if (-not [string]$manifest.key) {
    throw 'Source manifest.json key is required to prove Stable and Dev identities differ.'
  }
  $stableId = Get-PopoExtensionIdFromKey ([string]$manifest.key)
  if ($stableId -eq $config.ExtensionId) {
    throw 'Source Stable and Dev extension identities must be different.'
  }

  $manifest.name = $config.DisplayName
  $manifest.version_name = "$([string]$manifest.version)-dev"
  $manifest.key = $config.ExtensionKey
  $manifest.description = $config.Description
  $manifest.action.default_title = $config.DisplayName
  [System.IO.File]::WriteAllText(
    $DestinationManifestPath,
    ($manifest | ConvertTo-Json -Depth 20),
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Assert-PopoDevManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$SourceManifestPath,
    [Parameter(Mandatory = $true)][string]$DevManifestPath
  )

  $config = Get-PopoDevExtensionConfig
  $source = [System.IO.File]::ReadAllText($SourceManifestPath) | ConvertFrom-Json
  $dev = [System.IO.File]::ReadAllText($DevManifestPath) | ConvertFrom-Json
  $sourceId = Get-PopoExtensionIdFromKey ([string]$source.key)
  $devId = Get-PopoExtensionIdFromKey ([string]$dev.key)

  if ([string]$dev.name -ne $config.DisplayName) { throw "Unexpected Dev extension name: $([string]$dev.name)" }
  if ([string]$dev.action.default_title -ne $config.DisplayName) { throw 'Unexpected Dev action title.' }
  if ([string]$dev.version -ne [string]$source.version) { throw 'Dev manifest version does not match source manifest version.' }
  if ([string]$dev.version_name -ne "$([string]$source.version)-dev") { throw "Unexpected Dev version_name: $([string]$dev.version_name)" }
  if ([string]$dev.key -ne $config.ExtensionKey) { throw 'Dev manifest key does not match the fixed Dev identity.' }
  if ($devId -ne $config.ExtensionId) { throw "Unexpected Dev extension ID: $devId" }
  if ($sourceId -eq $devId) { throw 'Stable and Dev extension identities must be different.' }

  [pscustomobject]@{
    Name = [string]$dev.name
    Version = [string]$dev.version
    VersionName = [string]$dev.version_name
    DevExtensionId = $devId
    SourceExtensionId = $sourceId
    IdentitiesDiffer = $sourceId -ne $devId
  }
}

function Write-PopoDevSyncMarker {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$DestinationPath,
    [DateTimeOffset]$CompletedAt = [DateTimeOffset]::Now
  )

  $middleDot = '"\u00b7"' | ConvertFrom-Json
  $marker = [ordered]@{
    schemaVersion = 1
    channel = 'dev'
    syncedAtUtc = $CompletedAt.ToUniversalTime().ToString('o')
    label = "DEV $middleDot $($CompletedAt.ToString('MM-dd HH:mm:ss'))"
  }
  [System.IO.File]::WriteAllText(
    $DestinationPath,
    ($marker | ConvertTo-Json -Compress),
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Assert-PopoDevSyncMarker {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$MarkerPath)

  if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
    throw "Dev synchronization marker was not found: $MarkerPath"
  }
  $marker = [System.IO.File]::ReadAllText($MarkerPath) | ConvertFrom-Json
  $middleDot = [char]0x00B7
  if ([int]$marker.schemaVersion -ne 1 -or [string]$marker.channel -ne 'dev') {
    throw 'Dev synchronization marker has an invalid schema or channel.'
  }
  if ([string]$marker.label -notmatch "^DEV $middleDot [0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$") {
    throw "Dev synchronization marker has an invalid label: $([string]$marker.label)"
  }
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$marker.syncedAtUtc, [ref]$parsed)) {
    throw 'Dev synchronization marker has an invalid timestamp.'
  }

  [pscustomobject]@{
    Label = [string]$marker.label
    SyncedAtUtc = $parsed.ToUniversalTime().ToString('o')
  }
}

function Copy-PopoExtensionSource {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [ValidateSet('Stable', 'Dev')][string]$Channel = 'Stable'
  )

  $repo = Get-PopoFullPath $RepoRoot
  $destination = Get-PopoFullPath $DestinationRoot
  $config = Get-PopoDevExtensionConfig
  $sourceManifest = Join-Path $repo 'manifest.json'
  foreach ($requiredPath in @($sourceManifest) + @($config.RootFiles | ForEach-Object { Join-Path $repo $_ }) + @($config.SourceDirectories | ForEach-Object { Join-Path $repo $_ })) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "Required Extension source was not found: $requiredPath"
    }
  }

  if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
  }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  foreach ($file in $config.RootFiles) {
    Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $destination $file)
  }
  foreach ($directory in $config.SourceDirectories) {
    Copy-Item -LiteralPath (Join-Path $repo $directory) -Destination $destination -Recurse -Force
  }
  $destinationManifest = Join-Path $destination 'manifest.json'
  if ($Channel -eq 'Dev') {
    Write-PopoDevManifest -SourceManifestPath $sourceManifest -DestinationManifestPath $destinationManifest
    Assert-PopoDevManifest -SourceManifestPath $sourceManifest -DevManifestPath $destinationManifest | Out-Null
  } else {
    Copy-Item -LiteralPath $sourceManifest -Destination $destinationManifest
  }

  $destination
}

function Invoke-PopoDevExtensionSync {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$TargetDirectory,
    [Parameter(Mandatory = $true)][string]$ExpectedTargetDirectory,
    [Parameter(Mandatory = $true)][string]$StableDirectory
  )

  $target = Assert-PopoDevSyncTarget -TargetDirectory $TargetDirectory -ExpectedTargetDirectory $ExpectedTargetDirectory -StableDirectory $StableDirectory -RepoRoot $RepoRoot
  $repo = Get-PopoFullPath $RepoRoot
  $parent = Split-Path -Parent $target
  $token = [Guid]::NewGuid().ToString('N')
  $staging = Join-Path $parent ".POPODevExtension-sync-$token"
  $backup = Join-Path $parent ".POPODevExtension-backup-$token"
  $hadTarget = Test-Path -LiteralPath $target
  $swapped = $false

  try {
    Copy-PopoExtensionSource -RepoRoot $repo -DestinationRoot $staging -Channel Dev | Out-Null
    $validation = Assert-PopoDevManifest -SourceManifestPath (Join-Path $repo 'manifest.json') -DevManifestPath (Join-Path $staging 'manifest.json')
    if ($hadTarget) {
      Move-Item -LiteralPath $target -Destination $backup
    }
    Move-Item -LiteralPath $staging -Destination $target
    $swapped = $true
    $validation = Assert-PopoDevManifest -SourceManifestPath (Join-Path $repo 'manifest.json') -DevManifestPath (Join-Path $target 'manifest.json')
    $syncMarkerPath = Join-Path $target 'dev-sync.json'
    Write-PopoDevSyncMarker -DestinationPath $syncMarkerPath
    $syncMarker = Assert-PopoDevSyncMarker -MarkerPath $syncMarkerPath
    if (Test-Path -LiteralPath $backup) {
      Remove-Item -LiteralPath $backup -Recurse -Force
    }
    [pscustomobject]@{
      TargetDirectory = $target
      FileCount = @(Get-ChildItem -LiteralPath $target -File -Recurse -Force).Count
      Name = $validation.Name
      VersionName = $validation.VersionName
      DevExtensionId = $validation.DevExtensionId
      SourceExtensionId = $validation.SourceExtensionId
      IdentitiesDiffer = $validation.IdentitiesDiffer
      SyncBatchTime = $syncMarker.Label.Substring(6)
      SyncedAtUtc = $syncMarker.SyncedAtUtc
    }
  } catch {
    $failure = $_
    if ($swapped -and (Test-Path -LiteralPath $target)) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
    if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $target)) {
      Move-Item -LiteralPath $backup -Destination $target
    }
    throw $failure
  } finally {
    if (Test-Path -LiteralPath $staging) {
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
  }
}

Export-ModuleMember -Function @(
  'Get-PopoDevExtensionConfig',
  'Get-PopoExtensionIdFromKey',
  'Assert-PopoDevSyncTarget',
  'Write-PopoDevManifest',
  'Assert-PopoDevManifest',
  'Write-PopoDevSyncMarker',
  'Assert-PopoDevSyncMarker',
  'Copy-PopoExtensionSource',
  'Invoke-PopoDevExtensionSync'
)
