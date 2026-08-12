[CmdletBinding()]
param(
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'manifest.json')) | ConvertFrom-Json
$versionName = [string]$manifest.version_name
if (-not $versionName) { throw 'manifest.json version_name is required.' }
if ($versionName -match '(?i)(?:^|[-.])dev(?:[-.]|$)') {
  throw 'Refusing to create a signed stable package from a development-marked project. Set manifest.json version_name to a formal release version first.'
}

$distRoot = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path $repoRoot 'dist'
}
$packageName = "POPO-Stable-Downloader-$versionName-win-x64"
$stagingRoot = Join-Path $distRoot $packageName
$zipPath = Join-Path $distRoot "$packageName.zip"
$checksumPath = "$zipPath.sha256.txt"
$channelManifestPath = Join-Path $distRoot 'latest.json'
$updateBaseUrl = 'https://popo-updates-1461466196.cos.ap-guangzhou.myqcloud.com/stable'
$signingKeyPath = Join-Path $env:LOCALAPPDATA 'POPORelease\release-signing-key.dpapi'
$gopeedVendorRoot = Join-Path $repoRoot 'vendor\gopeed\v1.9.3'
$gopeedPortableRoot = Join-Path $gopeedVendorRoot 'portable'
$gopeedSourceArchive = Join-Path $gopeedVendorRoot 'Gopeed-v1.9.3-source.zip'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$nativeSource = Join-Path $repoRoot 'native-host\FolderPickerHost.cs'
$setupSource = Join-Path $repoRoot 'setup\PopoSetup.cs'
$setupExecutableName = 'POPO-Setup.exe'
$compileRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
  ("popo-package-compile-" + [Guid]::NewGuid().ToString('N'))
$nativeExecutable = Join-Path $compileRoot 'PopoFolderPickerHost.exe'
$nativeVersion = (Get-FileHash -LiteralPath $nativeSource -Algorithm SHA256).Hash.ToLowerInvariant()
$setupExecutable = Join-Path $compileRoot $setupExecutableName

& npm run build:runtime --prefix $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'The extension runtime bundle failed to build.' }

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
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  /reference:System.Web.Extensions.dll `
  /out:$setupExecutable $setupSource
if ($LASTEXITCODE -ne 0) { throw 'The green setup assistant failed to compile.' }

foreach ($requiredPath in @(
  (Join-Path $gopeedPortableRoot 'gopeed.exe'),
  (Join-Path $gopeedVendorRoot 'LICENSE'),
  (Join-Path $gopeedVendorRoot 'metadata.json'),
  $gopeedSourceArchive,
  $nativeExecutable,
  $setupExecutable,
  (Join-Path $repoRoot 'THIRD-PARTY-NOTICES.md')
)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required package input was not found: $requiredPath"
  }
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$resolvedDist = (Resolve-Path -LiteralPath $distRoot).Path.TrimEnd('\')
foreach ($target in @($stagingRoot, $zipPath, $checksumPath, $channelManifestPath)) {
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
$gopeedRoot = Join-Path $stagingRoot 'Gopeed'
$gopeedLicenseRoot = Join-Path $stagingRoot 'licenses\gopeed'
New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $nativeHostRoot 'bin') -Force | Out-Null
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
Copy-Item -LiteralPath (Join-Path $repoRoot 'assets') -Destination $extensionRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'runtime') -Destination $extensionRoot -Recurse -Force

Copy-Item -LiteralPath (Join-Path $repoRoot 'native-host\FolderPickerHost.cs') -Destination $nativeHostRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'native-host\install.ps1') -Destination $nativeHostRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'native-host\uninstall.ps1') -Destination $nativeHostRoot
Copy-Item -LiteralPath $nativeExecutable -Destination (Join-Path $nativeHostRoot 'bin')
[System.IO.File]::WriteAllText(
  (Join-Path $nativeHostRoot 'bin\.popo-native-version'),
  $nativeVersion,
  (New-Object System.Text.UTF8Encoding($false))
)
Copy-Item -LiteralPath $setupExecutable -Destination (Join-Path $stagingRoot $setupExecutableName)
Copy-Item -LiteralPath (Join-Path $repoRoot 'TESTING.md') -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD-PARTY-NOTICES.md') -Destination $stagingRoot

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

if (-not (Test-Path -LiteralPath $signingKeyPath)) {
  throw "Release signing key was not found. Run scripts/Initialize-ReleaseSigningKey.ps1 first: $signingKeyPath"
}
$entropy = [System.Text.Encoding]::UTF8.GetBytes('POPO stable release signing key v1')
$protectedKey = [System.IO.File]::ReadAllBytes($signingKeyPath)
$privateKeyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protectedKey,
  $entropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
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
  notes = 'Hotfixes POPO single-file address recovery after permission-denied API responses and keeps one-click batches running after an incomplete folder.'
}
$channelJson = $channelManifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
  $channelManifestPath,
  $channelJson,
  (New-Object System.Text.UTF8Encoding($false))
)

Remove-Item -LiteralPath $stagingRoot -Recurse -Force
Remove-Item -LiteralPath $compileRoot -Recurse -Force

[pscustomobject]@{
  Version = $versionName
  Package = $zipPath
  Sha256 = $hash
  Size = $size
  ChannelManifest = $channelManifestPath
} | ConvertTo-Json -Compress
