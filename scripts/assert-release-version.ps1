[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = if ($RepoRoot) {
  (Resolve-Path -LiteralPath $RepoRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$manifest = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'manifest.json')) | ConvertFrom-Json
$package = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'package.json')) | ConvertFrom-Json
$packageLockVersionsJson = & node -e "const lock=require(process.argv[1]); process.stdout.write(JSON.stringify({version:lock.version,rootVersion:lock.packages?.['']?.version}));" (Join-Path $repoRoot 'package-lock.json')
if ($LASTEXITCODE -ne 0) { throw 'Node.js could not read package-lock.json.' }
$packageLockVersions = $packageLockVersionsJson | ConvertFrom-Json

$version = [string]$manifest.version_name
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Stable releases require a semantic version such as 1.2.3; found '$version'."
}

$expectedTag = "v$version"
if ($Tag -ne $expectedTag) {
  throw "Release tag '$Tag' does not match manifest version '$expectedTag'."
}

foreach ($entry in @(
  @{ Name = 'manifest.json version'; Value = [string]$manifest.version },
  @{ Name = 'package.json version'; Value = [string]$package.version },
  @{ Name = 'package-lock.json version'; Value = [string]$packageLockVersions.version },
  @{ Name = 'package-lock.json root version'; Value = [string]$packageLockVersions.rootVersion }
)) {
  if ($entry.Value -ne $version) {
    throw "$($entry.Name) '$($entry.Value)' does not match release version '$version'."
  }
}

Push-Location $repoRoot
try {
  $tagObjectType = (& git cat-file -t "refs/tags/$Tag" 2>$null).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Release tag '$Tag' does not exist locally." }
  if ($tagObjectType -ne 'tag') { throw "Stable release tag '$Tag' must be annotated." }

  $tagCommit = (& git rev-list -n 1 $Tag).Trim()
  $headCommit = (& git rev-parse HEAD).Trim()
  if ($tagCommit -ne $headCommit) {
    throw "Checked-out commit '$headCommit' is not the target of release tag '$Tag' ($tagCommit)."
  }

  & git merge-base --is-ancestor $headCommit refs/remotes/origin/main
  if ($LASTEXITCODE -ne 0) {
    throw "Release tag '$Tag' is not reachable from origin/main."
  }
}
finally {
  Pop-Location
}

[pscustomobject]@{
  Ok = $true
  Tag = $Tag
  Version = $version
  ChromeVersion = [string]$manifest.version
} | ConvertTo-Json -Compress
