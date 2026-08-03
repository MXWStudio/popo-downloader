[CmdletBinding()]
param(
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId = '',

  [string]$ExtensionRoot = (Split-Path -Parent $PSScriptRoot),

  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'POPOStableDownloader\NativeHost'),

  [string]$BundledGopeedRoot = ''
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.popo.stable_downloader.folder_picker'
$sourceFile = Join-Path $PSScriptRoot 'FolderPickerHost.cs'
$binDirectory = Join-Path $PSScriptRoot 'bin'
$builtExe = Join-Path $binDirectory 'PopoFolderPickerHost.exe'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $ExtensionRoot)) {
  throw "Extension directory was not found: $ExtensionRoot"
}
$ExtensionRoot = (Resolve-Path -LiteralPath $ExtensionRoot).Path.TrimEnd('\')

New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null
if (Test-Path -LiteralPath $compiler) {
  & $compiler /nologo /target:winexe /optimize+ /codepage:65001 `
    /reference:System.Windows.Forms.dll `
    /reference:System.Drawing.dll `
    /reference:System.Web.Extensions.dll `
    /out:$builtExe $sourceFile
  if ($LASTEXITCODE -ne 0) {
    throw 'The native folder picker host failed to compile.'
  }
}
if (-not (Test-Path -LiteralPath $builtExe)) {
  throw 'The prebuilt native host is missing and no compiler is available.'
}

if (-not $ExtensionId) {
  $chromeUserData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  $extensionIds = @()
  Get-ChildItem -LiteralPath $chromeUserData -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } |
    ForEach-Object {
      foreach ($preferencesName in @('Secure Preferences', 'Preferences')) {
        $preferencesPath = Join-Path $_.FullName $preferencesName
        if (-not (Test-Path -LiteralPath $preferencesPath)) { continue }
        try {
          $preferences = [System.IO.File]::ReadAllText($preferencesPath) | ConvertFrom-Json
          $settings = $preferences.extensions.settings
          if (-not $settings) { continue }
          foreach ($property in $settings.PSObject.Properties) {
            $candidatePath = [string]$property.Value.path
            if (-not $candidatePath) { continue }
            try {
              $candidateRoot = [System.IO.Path]::GetFullPath($candidatePath).TrimEnd('\')
              if ($candidateRoot -ieq $ExtensionRoot) {
                $extensionIds += $property.Name
              }
            } catch {}
          }
        } catch {}
      }
    }
  $extensionIds = @($extensionIds | Where-Object { $_ -match '^[a-p]{32}$' } | Sort-Object -Unique)
  if ($extensionIds.Count -eq 0) {
    throw 'Chrome extension ID was not found. Load the extension folder in chrome://extensions first, then run this installer again.'
  }
  if ($extensionIds.Count -gt 1) {
    throw "Multiple extension IDs were found: $($extensionIds -join ', '). Pass -ExtensionId explicitly."
  }
  $ExtensionId = $extensionIds[0]
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$installedExe = Join-Path $InstallRoot 'PopoFolderPickerHost.exe'
$manifestPath = Join-Path $InstallRoot "$hostName.json"
Copy-Item -LiteralPath $builtExe -Destination $installedExe -Force

$installedGopeed = ''
if ($BundledGopeedRoot) {
  if (-not (Test-Path -LiteralPath $BundledGopeedRoot)) {
    throw "Bundled Gopeed directory was not found: $BundledGopeedRoot"
  }
  $BundledGopeedRoot = (Resolve-Path -LiteralPath $BundledGopeedRoot).Path.TrimEnd('\')
  $sourceGopeedExe = Join-Path $BundledGopeedRoot 'gopeed.exe'
  if (-not (Test-Path -LiteralPath $sourceGopeedExe)) {
    throw "Bundled Gopeed executable was not found: $sourceGopeedExe"
  }

  $gopeedInstallRoot = Join-Path $InstallRoot 'Gopeed'
  $resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $resolvedGopeedTarget = [System.IO.Path]::GetFullPath($gopeedInstallRoot).TrimEnd('\')
  if (-not $resolvedGopeedTarget.StartsWith($resolvedInstallRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a Gopeed path outside the native host directory: $resolvedGopeedTarget"
  }

  $sourceMarker = Join-Path $BundledGopeedRoot '.popo-bundle-version'
  $targetMarker = Join-Path $resolvedGopeedTarget '.popo-bundle-version'
  $sameBundle = $false
  if ((Test-Path -LiteralPath $sourceMarker) -and (Test-Path -LiteralPath $targetMarker)) {
    $sourceVersion = [System.IO.File]::ReadAllText($sourceMarker).Trim()
    $targetVersion = [System.IO.File]::ReadAllText($targetMarker).Trim()
    $sameBundle = $sourceVersion -and
      ($sourceVersion -eq $targetVersion) -and
      (Test-Path -LiteralPath (Join-Path $resolvedGopeedTarget 'gopeed.exe')) -and
      (Test-Path -LiteralPath (Join-Path $resolvedGopeedTarget 'libgopeed.dll'))
  }

  if (-not $sameBundle) {
    if (Test-Path -LiteralPath $resolvedGopeedTarget) {
      $runningBundle = Get-Process -Name 'gopeed' -ErrorAction SilentlyContinue |
        Where-Object {
          try { [System.IO.Path]::GetFullPath($_.Path) -ieq (Join-Path $resolvedGopeedTarget 'gopeed.exe') }
          catch { $false }
        }
      if ($runningBundle) {
        throw 'Bundled Gopeed is running. Exit it from the system tray, then run START-HERE.cmd again.'
      }
      Remove-Item -LiteralPath $resolvedGopeedTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Path $resolvedGopeedTarget -Force | Out-Null
    Get-ChildItem -LiteralPath $BundledGopeedRoot -Force |
      Where-Object { $_.Name -ne '.popo-bundle-version' } |
      Copy-Item -Destination $resolvedGopeedTarget -Recurse -Force
    if (Test-Path -LiteralPath $sourceMarker) {
      Copy-Item -LiteralPath $sourceMarker -Destination $targetMarker -Force
    }
  }
  $installedGopeed = Join-Path $resolvedGopeedTarget 'gopeed.exe'
}

$manifest = [ordered]@{
  name = $hostName
  description = 'POPO Stable Downloader Windows folder picker'
  path = $installedExe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8NoBom)

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

[pscustomobject]@{
  HostName = $hostName
  ExtensionId = $ExtensionId
  Executable = $installedExe
  Manifest = $manifestPath
  RegistryPath = $registryPath
  BundledGopeed = $installedGopeed
} | ConvertTo-Json -Compress
