[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [switch]$NoSync,
  [switch]$BuildDevPackage,
  [switch]$InstallDevPackage
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$syncExtension = -not $NoSync
if ($InstallDevPackage -and -not $BuildDevPackage) {
  throw 'Dev package installation requires -BuildDevPackage.'
}
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
  Write-Output 'POPO_WINDOWS_TESTS=PASS'

  if ($BuildDevPackage) {
    & npm run build:dev-package
    if ($LASTEXITCODE -ne 0) { throw 'Dev package build failed.' }
    Write-Output 'POPO_DEV_PACKAGE=PASS'
  }

  if ($InstallDevPackage) {
    $projectManifest = Get-Content -LiteralPath (Join-Path $repo 'manifest.json') -Raw |
      ConvertFrom-Json
    $devVersionName = "$([string]$projectManifest.version)-dev"
    $packageRoot = Join-Path $repo "dist\POPO-Dev-Downloader-$devVersionName-win-x64"
    $setupPath = Join-Path $packageRoot 'POPO-Dev-Setup.exe'
    $sourceNativeHost = Join-Path $packageRoot 'native-host\bin\PopoFolderPickerHost.exe'
    $devRoot = 'D:\POPO\Dev\POPODevDownloader'
    if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
      throw "Dev setup executable was not found: $setupPath"
    }
    if (-not (Test-Path -LiteralPath $sourceNativeHost -PathType Leaf)) {
      throw "Built Dev native host was not found: $sourceNativeHost"
    }

    & $setupPath --quiet --install-root $devRoot --repair
    if ($LASTEXITCODE -ne 0) { throw "Dev package installation failed with exit code $LASTEXITCODE." }

    $installedNativeRoot = Join-Path $devRoot 'NativeHost'
    $installedNativeHost = Join-Path $installedNativeRoot 'PopoFolderPickerHost.exe'
    $nativeManifestPath = Join-Path $installedNativeRoot 'com.popo.dev_downloader.folder_picker.json'
    $installStatePath = Join-Path $devRoot 'install-state.json'
    foreach ($required in @($installedNativeHost, $nativeManifestPath, $installStatePath)) {
      if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Installed Dev component was not found: $required"
      }
    }
    if ((Get-FileHash -LiteralPath $installedNativeHost -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $sourceNativeHost -Algorithm SHA256).Hash) {
      throw 'Installed Dev native host does not match the verified package.'
    }

    $nativeManifest = Get-Content -LiteralPath $nativeManifestPath -Raw | ConvertFrom-Json
    if ([string]$nativeManifest.name -ne 'com.popo.dev_downloader.folder_picker' -or
        [System.IO.Path]::GetFullPath([string]$nativeManifest.path) -ine
          [System.IO.Path]::GetFullPath($installedNativeHost) -or
        @($nativeManifest.allowed_origins) -notcontains
          'chrome-extension://folfhehnopknchpoaajfpboibbhnlanf/') {
      throw 'Installed Dev native messaging manifest identity is invalid.'
    }
    $registryKey = Get-Item -LiteralPath `
      'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.popo.dev_downloader.folder_picker'
    $registeredManifest = [string]$registryKey.GetValue('')
    if ([System.IO.Path]::GetFullPath($registeredManifest) -ine
        [System.IO.Path]::GetFullPath($nativeManifestPath)) {
      throw 'Chrome Dev native messaging registration does not point to the installed manifest.'
    }
    $installState = Get-Content -LiteralPath $installStatePath -Raw | ConvertFrom-Json
    if ([string]$installState.extensionId -ne 'folfhehnopknchpoaajfpboibbhnlanf' -or
        [string]$installState.versionName -ne $devVersionName) {
      throw 'Installed Dev state has the wrong extension identity or version.'
    }
    Write-Output 'POPO_DEV_INSTALL=PASS'
  }

  $syncResult = $null
  if ($syncExtension) {
    $syncOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-dev-extension.ps1 -RepoRoot $repo
    if ($LASTEXITCODE -ne 0) { throw 'Dev Extension synchronization failed.' }
    $syncResult = $syncOutput | Select-Object -Last 1 | ConvertFrom-Json
    Write-Output 'POPO_DEV_SYNC=PASS'
    Write-Output "POPO_DEV_SYNC_BATCH_TIME=$([string]$syncResult.SyncBatchTime)"
  }
  else {
    Write-Output 'POPO_DEV_SYNC=NOT_REQUESTED'
  }

  [pscustomobject]@{
    Status = 'PASS'
    Commit = (& git rev-parse HEAD).Trim()
    WorkingTreeChanges = @(& git status --short).Count
    ExtensionSynchronized = [bool]$syncExtension
    DevTargetDirectory = if ($syncResult) { [string]$syncResult.TargetDirectory } else { '' }
    DevExtensionId = if ($syncResult) { [string]$syncResult.DevExtensionId } else { '' }
    VersionName = if ($syncResult) { [string]$syncResult.VersionName } else { '' }
    DevSyncBatchTime = if ($syncResult) { [string]$syncResult.SyncBatchTime } else { '' }
    DevSyncedAtUtc = if ($syncResult) { [string]$syncResult.SyncedAtUtc } else { '' }
  } | ConvertTo-Json -Compress
}
finally {
  Pop-Location
}
