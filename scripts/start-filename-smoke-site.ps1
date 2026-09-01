param(
    [string]$SiteRoot = 'D:\POPO\Validation\FilenameSmokeSite'
)

$ErrorActionPreference = 'Stop'

$resolvedRoot = [System.IO.Path]::GetFullPath($SiteRoot).TrimEnd('\')
if ($resolvedRoot -ne 'D:\POPO\Validation\FilenameSmokeSite') {
    throw "Refusing unexpected filename smoke site root: $resolvedRoot"
}

$scriptPath = Join-Path $resolvedRoot 'scripts\filename-smoke-server.mjs'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Filename smoke server is missing: $scriptPath"
}

$gopeed = Get-Process -Name 'gopeed' -ErrorAction Stop |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
$listener = Get-NetTCPConnection -State Listen -OwningProcess $gopeed.Id -ErrorAction Stop |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
    Select-Object -First 1
if (-not $listener) {
    throw 'The running Gopeed process has no 127.0.0.1 TCP API listener.'
}

$existingSite = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort 18790 -ErrorAction SilentlyContinue
if ($existingSite) {
    throw "Filename smoke site port 18790 is already owned by process $($existingSite.OwningProcess)."
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$env:GOPEED_ENDPOINT = "http://127.0.0.1:$($listener.LocalPort)"
$stdout = Join-Path $resolvedRoot 'server.log'
$stderr = Join-Path $resolvedRoot 'server.err.log'
$process = Start-Process -FilePath $node `
    -ArgumentList $scriptPath `
    -WorkingDirectory $resolvedRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

Start-Sleep -Milliseconds 500
$site = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18790/' -TimeoutSec 4
if ($site.StatusCode -ne 200) {
    throw "Filename smoke site did not become ready; HTTP $($site.StatusCode)."
}

[pscustomobject]@{
    Status = 'PASS'
    Url = 'http://127.0.0.1:18790/'
    ProcessId = $process.Id
    GopeedEndpoint = $env:GOPEED_ENDPOINT
    DownloadRoot = 'D:\POPO\Validation\FilenameSmoke'
    StableTouched = 'NO'
} | ConvertTo-Json -Compress
