[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$OutputDirectory = '',
  [string]$ReleaseNotesPath = '',
  [string]$SigningKeyBase64 = $env:POPO_RELEASE_SIGNING_KEY_BASE64,
  [ValidateSet('Stable', 'Dev')]
  [string]$Channel = 'Stable',
  [switch]$SkipRuntimeBuild
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
if (Test-Path Env:POPO_RELEASE_SIGNING_KEY_BASE64) {
  Remove-Item Env:POPO_RELEASE_SIGNING_KEY_BASE64
}
$repoRoot = if ($RepoRoot) {
  (Resolve-Path -LiteralPath $RepoRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$manifest = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'manifest.json')) | ConvertFrom-Json
$isDev = $Channel -eq 'Dev'
$stableVersionName = [string]$manifest.version_name
if (-not $stableVersionName) { throw 'manifest.json version_name is required.' }
if (-not $isDev -and $stableVersionName -match '(?i)(?:^|[-.])dev(?:[-.]|$)') {
  throw 'Refusing to create a signed stable package from a development-marked project. Set manifest.json version_name to a formal release version first.'
}
$versionName = if ($isDev) { "$([string]$manifest.version)-dev" } else { $stableVersionName }
$devExtensionKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAktkTv13QYDbQoZCW7Dnk84LsxiHEj0H2a0y7Ir8AY12pAb1hG6vfB7aQ0nyudGhxAmudVdPluPJy3zx48SHAHwu2YJDfVUIdN+LhUU6FkeN9XlHp9dtzYxyO7/oG5NS2XGBu7rPxoJS0Owme5rpj6Oks3oiFI95TaTn2DOVB7FryTbdPTvBX9czDvOxvPG45hABm0Djz/DDX5luSmCXDPCnNkERgkU4f/WTAJFble76uph6RXlyFD5PzdPETpYvngjALceH2t+FcWjf2+CZjwudPkUQRrM/Z1DF77md2ovZV8B9zQnlympk8JQCb44tY1jtvypTE9W1IHaCXjZIizwIDAQAB'
$devExtensionId = 'folfhehnopknchpoaajfpboibbhnlanf'

$distRoot = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path $repoRoot 'dist'
}
$packageName = if ($isDev) {
  "POPO-Dev-Downloader-$versionName-win-x64"
} else {
  "POPO-Stable-Downloader-$versionName-win-x64"
}
$stagingRoot = Join-Path $distRoot $packageName
$zipPath = Join-Path $distRoot "$packageName.zip"
$checksumPath = "$zipPath.sha256.txt"
$channelManifestPath = if ($isDev) { '' } else { Join-Path $distRoot 'latest.json' }
$bootstrapperPath = if ($isDev) { '' } else { Join-Path $distRoot "$packageName.exe" }
$bootstrapperChecksumPath = if ($isDev) { '' } else { "$bootstrapperPath.sha256.txt" }
$updateBaseUrl = 'https://popo-updates-1461466196.cos.ap-guangzhou.myqcloud.com/stable'
$signingKeyPath = Join-Path $env:LOCALAPPDATA 'POPORelease\release-signing-key.dpapi'
$gopeedVendorRoot = Join-Path $repoRoot 'vendor\gopeed\v1.9.3'
$gopeedPortableRoot = Join-Path $gopeedVendorRoot 'portable'
$gopeedSourceArchive = Join-Path $gopeedVendorRoot 'Gopeed-v1.9.3-source.zip'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$nativeSource = Join-Path $repoRoot 'native-host\FolderPickerHost.cs'
$agentSource = Join-Path $repoRoot 'agent\PopoAgent.cs'
$setupSource = Join-Path $repoRoot 'setup\PopoSetup.cs'
$setupExecutableName = if ($isDev) { 'POPO-Dev-Setup.exe' } else { 'POPO-Setup.exe' }
$buildDefinition = if ($isDev) { '/define:POPO_DEV_BUILD' } else { $null }
$compileRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
  ("popo-package-compile-" + [Guid]::NewGuid().ToString('N'))
$nativeExecutable = Join-Path $compileRoot 'PopoFolderPickerHost.exe'
$nativeVersion = (Get-FileHash -LiteralPath $nativeSource -Algorithm SHA256).Hash.ToLowerInvariant()
$agentExecutable = Join-Path $compileRoot 'PopoAgent.exe'
$agentVersion = (Get-FileHash -LiteralPath $agentSource -Algorithm SHA256).Hash.ToLowerInvariant()
$setupExecutable = Join-Path $compileRoot $setupExecutableName

if (-not $isDev -and -not $SkipRuntimeBuild) {
  $diagnosticDsn = [string]$env:POPO_DIAGNOSTIC_DSN
  if (-not $diagnosticDsn) {
    throw 'POPO_DIAGNOSTIC_DSN is required when building a stable package.'
  }
}

if (-not $SkipRuntimeBuild) {
  & npm run build:runtime --prefix $repoRoot
  if ($LASTEXITCODE -ne 0) { throw 'The extension runtime bundle failed to build.' }
}

if (-not $isDev) {
  $runtimeModule = Join-Path $repoRoot 'runtime\popo-runtime.cjs'
  if (-not (Test-Path -LiteralPath $runtimeModule)) {
    throw 'The stable runtime bundle is missing.'
  }
  $diagnosticJson = & node -e "const runtime=require(process.argv[1]);process.stdout.write(JSON.stringify(runtime.diagnostics.diagnosticConfiguration()));" $runtimeModule
  if ($LASTEXITCODE -ne 0) { throw 'The stable diagnostic configuration could not be inspected.' }
  $diagnosticConfiguration = $diagnosticJson | ConvertFrom-Json
  if (-not [bool]$diagnosticConfiguration.configured -or
      [string]$diagnosticConfiguration.provider -ne 'sentry' -or
      [string]$diagnosticConfiguration.host -notmatch '(?i)\.ingest(?:\.us)?\.sentry\.io$') {
    throw 'The stable runtime does not contain a valid official diagnostic receiver.'
  }
}

if (-not (Test-Path -LiteralPath $compiler)) {
  throw "The Windows .NET Framework compiler was not found: $compiler"
}
New-Item -ItemType Directory -Path $compileRoot -Force | Out-Null
& $compiler /nologo /target:winexe /optimize+ /codepage:65001 `
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  /reference:System.IO.Compression.dll `
  /reference:System.IO.Compression.FileSystem.dll `
  /reference:System.Web.Extensions.dll `
  /out:$nativeExecutable $nativeSource
if ($LASTEXITCODE -ne 0) { throw 'The native host failed to compile.' }

& $compiler /nologo /target:winexe /optimize+ /codepage:65001 `
  /reference:System.Web.Extensions.dll `
  /reference:System.Security.dll `
  $buildDefinition `
  /out:$agentExecutable $agentSource
if ($LASTEXITCODE -ne 0) { throw 'The POPO update agent failed to compile.' }

& $compiler /nologo /target:winexe /optimize+ /codepage:65001 `
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  /reference:System.Web.Extensions.dll `
  $buildDefinition `
  /out:$setupExecutable $setupSource
if ($LASTEXITCODE -ne 0) { throw 'The green setup assistant failed to compile.' }

foreach ($requiredPath in @(
  (Join-Path $gopeedPortableRoot 'gopeed.exe'),
  (Join-Path $gopeedVendorRoot 'LICENSE'),
  (Join-Path $gopeedVendorRoot 'metadata.json'),
  $gopeedSourceArchive,
  $nativeExecutable,
  $agentExecutable,
  $setupExecutable,
  (Join-Path $repoRoot 'THIRD-PARTY-NOTICES.md')
)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required package input was not found: $requiredPath"
  }
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$resolvedDist = (Resolve-Path -LiteralPath $distRoot).Path.TrimEnd('\')
foreach ($target in @(
  $stagingRoot,
  $zipPath,
  $checksumPath,
  $channelManifestPath,
  $bootstrapperPath,
  $bootstrapperChecksumPath
) | Where-Object { $_ }) {
  $fullTarget = [System.IO.Path]::GetFullPath($target)
  if (-not $fullTarget.StartsWith($resolvedDist + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a path outside dist: $fullTarget"
  }
  if (Test-Path -LiteralPath $fullTarget) {
    Remove-Item -LiteralPath $fullTarget -Recurse -Force
  }
}

$extensionRoot = Join-Path $stagingRoot 'extension'
$nativeHostRoot = Join-Path $stagingRoot 'native-host'
$agentRoot = Join-Path $stagingRoot 'agent'
$gopeedRoot = Join-Path $stagingRoot 'Gopeed'
$gopeedLicenseRoot = Join-Path $stagingRoot 'licenses\gopeed'
New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $nativeHostRoot 'bin') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $agentRoot 'bin') -Force | Out-Null
New-Item -ItemType Directory -Path $gopeedRoot -Force | Out-Null
New-Item -ItemType Directory -Path $gopeedLicenseRoot -Force | Out-Null

$extensionFiles = @(
  'manifest.json',
  'background.js',
  'content.js',
  'core.js',
  'queue.js',
  'gopeed.js',
  'page-api.js',
  'popup.css',
  'popup.html'
)
foreach ($file in $extensionFiles) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $extensionRoot $file)
}
if ($isDev) {
  $stagedManifestPath = Join-Path $extensionRoot 'manifest.json'
  $devManifest = [System.IO.File]::ReadAllText($stagedManifestPath) | ConvertFrom-Json
  $devDisplayName = '"POPO Dev \u4e0b\u8f7d\u52a9\u624b"' | ConvertFrom-Json
  $devDescription = '"\u4e0e\u6b63\u5f0f\u7248\u9694\u79bb\u7684 POPO \u5f00\u53d1\u4e0e\u9a8c\u6536\u52a9\u624b\u3002"' | ConvertFrom-Json
  $devManifest.name = $devDisplayName
  $devManifest.version_name = $versionName
  $devManifest.key = $devExtensionKey
  $devManifest.description = $devDescription
  $devManifest.action.default_title = $devDisplayName
  [System.IO.File]::WriteAllText(
    $stagedManifestPath,
    ($devManifest | ConvertTo-Json -Depth 20),
    (New-Object System.Text.UTF8Encoding($false))
  )
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'assets') -Destination $extensionRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'runtime') -Destination $extensionRoot -Recurse -Force

Copy-Item -LiteralPath (Join-Path $repoRoot 'native-host\FolderPickerHost.cs') -Destination $nativeHostRoot
if (-not $isDev) {
  Copy-Item -LiteralPath (Join-Path $repoRoot 'native-host\install.ps1') -Destination $nativeHostRoot
  Copy-Item -LiteralPath (Join-Path $repoRoot 'native-host\uninstall.ps1') -Destination $nativeHostRoot
}
Copy-Item -LiteralPath $nativeExecutable -Destination (Join-Path $nativeHostRoot 'bin')
[System.IO.File]::WriteAllText(
  (Join-Path $nativeHostRoot 'bin\.popo-native-version'),
  $nativeVersion,
  (New-Object System.Text.UTF8Encoding($false))
)
Copy-Item -LiteralPath (Join-Path $repoRoot 'agent\PopoAgent.cs') -Destination $agentRoot
Copy-Item -LiteralPath $agentExecutable -Destination (Join-Path $agentRoot 'bin')
[System.IO.File]::WriteAllText(
  (Join-Path $agentRoot 'bin\.popo-agent-version'),
  $agentVersion,
  (New-Object System.Text.UTF8Encoding($false))
)
Copy-Item -LiteralPath $setupExecutable -Destination (Join-Path $stagingRoot $setupExecutableName)
Copy-Item -LiteralPath (Join-Path $repoRoot $(if ($isDev) { 'DEV-TESTING.md' } else { 'TESTING.md' })) -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD-PARTY-NOTICES.md') -Destination $stagingRoot

$componentManifest = [ordered]@{
  schemaVersion = 1
  releaseVersion = $versionName
  extensionVersion = $versionName
  agentVersion = $versionName
  nativeHostVersion = $versionName
  installerVersion = $versionName
  updateProtocol = 2
  minimumProtocol = 1
}
[System.IO.File]::WriteAllText(
  (Join-Path $stagingRoot 'release-manifest.json'),
  ($componentManifest | ConvertTo-Json -Depth 3),
  (New-Object System.Text.UTF8Encoding($false))
)
Copy-Item -LiteralPath (Join-Path $stagingRoot 'release-manifest.json') `
  -Destination (Join-Path $agentRoot 'bin\release-manifest.json')

Get-ChildItem -LiteralPath $gopeedPortableRoot -Force |
  Copy-Item -Destination $gopeedRoot -Recurse -Force
[System.IO.File]::WriteAllText(
  (Join-Path $gopeedRoot '.popo-bundle-version'),
  'gopeed-v1.9.3',
  (New-Object System.Text.UTF8Encoding($false))
)
Copy-Item -LiteralPath (Join-Path $gopeedVendorRoot 'LICENSE') -Destination $gopeedLicenseRoot
Copy-Item -LiteralPath (Join-Path $gopeedVendorRoot 'metadata.json') -Destination $gopeedLicenseRoot
Copy-Item -LiteralPath $gopeedSourceArchive -Destination $gopeedLicenseRoot

Compress-Archive -LiteralPath $stagingRoot -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $zipPath).Length
[System.IO.File]::WriteAllText(
  $checksumPath,
  "$hash  $([System.IO.Path]::GetFileName($zipPath))`r`n",
  (New-Object System.Text.UTF8Encoding($false))
)

$artifactName = [System.IO.Path]::GetFileName($zipPath)
if (-not $isDev) {
  $publishedAt = [DateTimeOffset]::Now.ToString('o')
  $downloadUrl = "$updateBaseUrl/$artifactName"
  $canonical = @(
  '1',
  'stable',
  $versionName,
  [string]$manifest.version,
  $publishedAt,
  $artifactName,
  $downloadUrl,
  $hash,
  [string]$size
) -join "`n"

  $privateKeyBytes = $null
  if ($SigningKeyBase64) {
  try {
    $privateKeyBytes = [Convert]::FromBase64String($SigningKeyBase64.Trim())
  }
  catch {
    throw 'POPO_RELEASE_SIGNING_KEY_BASE64 is not valid Base64.'
  }
  }
  else {
  if (-not (Test-Path -LiteralPath $signingKeyPath)) {
    throw "Release signing key was not found. Run scripts/Initialize-ReleaseSigningKey.ps1 first or configure POPO_RELEASE_SIGNING_KEY_BASE64: $signingKeyPath"
  }
  $entropy = [System.Text.Encoding]::UTF8.GetBytes('POPO stable release signing key v1')
  $protectedKey = [System.IO.File]::ReadAllBytes($signingKeyPath)
  $privateKeyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedKey,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  }
  $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
  try {
  $rsa.FromXmlString([System.Text.Encoding]::UTF8.GetString($privateKeyBytes))
  $signature = [Convert]::ToBase64String($rsa.SignData(
    [System.Text.Encoding]::UTF8.GetBytes($canonical),
    [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256')
  ))
  }
  finally {
  $rsa.Dispose()
  [Array]::Clear($privateKeyBytes, 0, $privateKeyBytes.Length)
  }

  $releaseNotes = 'Stable release package.'
  if ($ReleaseNotesPath) {
  $resolvedReleaseNotesPath = (Resolve-Path -LiteralPath $ReleaseNotesPath).Path
  $releaseNotes = [System.IO.File]::ReadAllText($resolvedReleaseNotesPath).Trim()
  if (-not $releaseNotes) { throw 'Release notes must not be empty.' }
  }

  $channelManifest = [ordered]@{
  schemaVersion = 1
  channel = 'stable'
  version = $versionName
  chromeVersion = [string]$manifest.version
  publishedAt = $publishedAt
  artifact = $artifactName
  url = $downloadUrl
  sha256 = $hash
  size = $size
  signature = $signature
  notes = $releaseNotes
  }
  $channelJson = $channelManifest | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText(
    $channelManifestPath,
    $channelJson,
    (New-Object System.Text.UTF8Encoding($false))
  )

  $bootstrapperBuildScript = Join-Path $PSScriptRoot 'build-bootstrapper.ps1'
  if (-not (Test-Path -LiteralPath $bootstrapperBuildScript)) {
    throw "Bootstrapper build script was not found: $bootstrapperBuildScript"
  }
  $bootstrapperSource = Join-Path $repoRoot 'bootstrapper\PopoBootstrapper.cs'
  $bootstrapperOutput = & $bootstrapperBuildScript `
    -RepoRoot $repoRoot `
    -SourcePath $bootstrapperSource `
    -ZipPath $zipPath `
    -Version $versionName `
    -OutputPath $bootstrapperPath
  $bootstrapperResult = $bootstrapperOutput | Select-Object -Last 1 | ConvertFrom-Json
  if ([string]$bootstrapperResult.EmbeddedPayloadSha256 -ne $hash) {
    throw 'Bootstrapper embedded payload hash does not match the official ZIP.'
  }
}

Remove-Item -LiteralPath $stagingRoot -Recurse -Force
Remove-Item -LiteralPath $compileRoot -Recurse -Force

[pscustomobject]@{
  Channel = if ($isDev) { 'dev' } else { 'stable' }
  Version = $versionName
  ExtensionId = if ($isDev) { $devExtensionId } else { '' }
  Package = $zipPath
  Sha256 = $hash
  Size = $size
  ChannelManifest = $channelManifestPath
  Bootstrapper = $bootstrapperPath
  BootstrapperSha256 = if ($bootstrapperPath) {
    (Get-FileHash -LiteralPath $bootstrapperPath -Algorithm SHA256).Hash.ToLowerInvariant()
  } else { '' }
} | ConvertTo-Json -Compress
