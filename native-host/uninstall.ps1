[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'POPOStableDownloader\NativeHost')
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.popo.stable_downloader.folder_picker'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

function Get-AgentTaskName([string]$ProductRoot) {
  $normalized = [System.IO.Path]::GetFullPath($ProductRoot).TrimEnd('\').ToUpperInvariant()
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized))
    $suffix = [BitConverter]::ToString($hash, 0, 6).Replace('-', '')
    return "POPO Stable Downloader Update Agent $suffix"
  } finally {
    $sha256.Dispose()
  }
}

$productRoot = Split-Path -Parent $InstallRoot
$agentTaskName = Get-AgentTaskName $productRoot
$agentRunValueName = $agentTaskName.Replace(' ', '_')
$agentRunPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$taskQuery = & schtasks.exe /Query /TN $agentTaskName 2>$null
if ($LASTEXITCODE -eq 0) {
  & schtasks.exe /Delete /F /TN $agentTaskName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Cannot remove the POPO update agent startup task.'
  }
}
if (Test-Path -LiteralPath $agentRunPath) {
  Remove-ItemProperty -LiteralPath $agentRunPath -Name $agentRunValueName -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $registryPath) {
  Remove-Item -LiteralPath $registryPath -Recurse -Force
}
if (Test-Path -LiteralPath $InstallRoot) {
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
Write-Output 'POPO native folder picker was removed for the current user.'
