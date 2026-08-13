[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$OutputPath = '',
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = if ($RepoRoot) {
  (Resolve-Path -LiteralPath $RepoRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$changelogPath = Join-Path $repoRoot 'CHANGELOG.md'
$changelog = [System.IO.File]::ReadAllText($changelogPath)
$escapedVersion = [regex]::Escape($Version)
$pattern = "(?ms)^##\s+v$escapedVersion[^\r\n]*\r?\n(?<body>.*?)(?=^##\s+v|\z)"
$match = [regex]::Match($changelog, $pattern)
if (-not $match.Success) {
  throw "CHANGELOG.md does not contain a v$Version release section."
}

$body = $match.Groups['body'].Value.Trim()
if (-not $body) { throw "The v$Version release notes are empty." }
$notes = "## POPO $Version`r`n`r`n$body`r`n"

if ($OutputPath) {
  $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
  $parent = Split-Path -Parent $fullOutputPath
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [System.IO.File]::WriteAllText($fullOutputPath, $notes, (New-Object System.Text.UTF8Encoding($false)))
}
else {
  $notes
}
