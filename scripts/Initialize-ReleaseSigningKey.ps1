[CmdletBinding()]
param(
  [switch]$Rotate
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$keyRoot = Join-Path $env:LOCALAPPDATA 'POPORelease'
$keyPath = Join-Path $keyRoot 'release-signing-key.dpapi'
$entropy = [System.Text.Encoding]::UTF8.GetBytes('POPO stable release signing key v1')

function Read-PrivateKeyXml {
  param([string]$Path)
  $protectedBytes = [System.IO.File]::ReadAllBytes($Path)
  $privateBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    return [System.Text.Encoding]::UTF8.GetString($privateBytes)
  }
  finally {
    [Array]::Clear($privateBytes, 0, $privateBytes.Length)
  }
}

if ((Test-Path -LiteralPath $keyPath) -and -not $Rotate) {
  $privateXml = Read-PrivateKeyXml -Path $keyPath
  $created = $false
}
else {
  New-Item -ItemType Directory -Path $keyRoot -Force | Out-Null
  $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 3072
  try {
    $privateXml = $rsa.ToXmlString($true)
    $privateBytes = [System.Text.Encoding]::UTF8.GetBytes($privateXml)
    try {
      $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $privateBytes,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      [System.IO.File]::WriteAllBytes($keyPath, $protectedBytes)
    }
    finally {
      [Array]::Clear($privateBytes, 0, $privateBytes.Length)
    }
  }
  finally {
    $rsa.Dispose()
  }
  $created = $true
}

$publicRsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
try {
  $publicRsa.FromXmlString($privateXml)
  $publicXml = $publicRsa.ToXmlString($false)
  $publicKeyBase64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($publicXml)
  )
}
finally {
  $publicRsa.Dispose()
  $privateXml = $null
}

[pscustomobject]@{
  Created = $created
  KeyPath = $keyPath
  Protection = 'Windows DPAPI CurrentUser'
  PublicKeyBase64 = $publicKeyBase64
} | ConvertTo-Json -Compress
