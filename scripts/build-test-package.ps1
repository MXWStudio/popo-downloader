[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'manifest.json')) | ConvertFrom-Json
$versionName = [string]$manifest.version_name
if (-not $versionName) { throw 'manifest.json version_name is required.' }

$distRoot = Join-Path $repoRoot 'dist'
$packageName = "POPO-Stable-Downloader-$versionName-win-x64"
$stagingRoot = Join-Path $distRoot $packageName
$zipPath = Join-Path $distRoot "$packageName.zip"
$checksumPath = "$zipPath.sha256.txt"
$channelManifestPath = Join-Path $distRoot 'latest-beta.json'
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
  /reference:System.Web.Extensions.dll `
  /out:$nativeExecutable $nativeSource
if ($LASTEXITCODE -ne 0) { throw 'The native host failed to compile.' }

& $compiler /nologo /target:winexe /optimize+ /codepage:65001 `
  /reference:System.Windows.Forms.dll `
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

$channelManifest = [ordered]@{
  schemaVersion = 1
  channel = 'beta'
  version = $versionName
  chromeVersion = [string]$manifest.version
  publishedAt = [DateTimeOffset]::Now.ToString('o')
  artifact = [System.IO.Path]::GetFileName($zipPath)
  url = ''
  sha256 = $hash
  size = $size
  notes = 'Green beta downloading all user file formats recursively, restoring accidentally cancelled pending files without repeating successes, rebuilding the POPO worker after pause or tab changes, with verified Gopeed v1.9.3 and concurrency 5.'
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
