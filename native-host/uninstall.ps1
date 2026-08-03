[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'POPOStableDownloader\NativeHost')
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.popo.stable_downloader.folder_picker'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
if (Test-Path -LiteralPath $registryPath) {
  Remove-Item -LiteralPath $registryPath -Recurse -Force
}
if (Test-Path -LiteralPath $InstallRoot) {
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
Write-Output 'POPO native folder picker was removed for the current user.'
