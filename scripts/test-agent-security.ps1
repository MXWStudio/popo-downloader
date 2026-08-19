[CmdletBinding()]
param(
    [switch]$RunScan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-CommandAvailable {
    param([Parameter(Mandatory = $true)][string]$Name)

    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-SafeErrorCode {
    param([Parameter(Mandatory = $true)][System.Exception]$Exception)

    if ($Exception -is [System.UnauthorizedAccessException]) {
        return "access_denied"
    }
    return "query_failed"
}

function Get-AntivirusProviders {
    try {
        $names = @(
            Get-CimInstance -Namespace "root/SecurityCenter2" -ClassName "AntiVirusProduct" -ErrorAction Stop |
                ForEach-Object { [string]$_.displayName } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                Sort-Object -Unique
        )
        return [pscustomobject]@{
            Readable = $true
            ErrorCode = $null
            Names = $names
        }
    }
    catch {
        return [pscustomobject]@{
            Readable = $false
            ErrorCode = Get-SafeErrorCode $_.Exception
            Names = @()
        }
    }
}

function Get-DefenderStatus {
    $available = Get-CommandAvailable "Get-MpComputerStatus"
    if (-not $available) {
        return [pscustomobject]@{
            Available = $false
            Readable = $false
            ErrorCode = "command_unavailable"
            AntivirusEnabled = $null
            RealTimeProtectionEnabled = $null
            BehaviorMonitorEnabled = $null
            IoavProtectionEnabled = $null
            EngineVersion = $null
            SignatureVersion = $null
        }
    }

    try {
        $status = Get-MpComputerStatus -ErrorAction Stop
        return [pscustomobject]@{
            Available = $true
            Readable = $true
            ErrorCode = $null
            AntivirusEnabled = [bool]$status.AntivirusEnabled
            RealTimeProtectionEnabled = [bool]$status.RealTimeProtectionEnabled
            BehaviorMonitorEnabled = [bool]$status.BehaviorMonitorEnabled
            IoavProtectionEnabled = [bool]$status.IoavProtectionEnabled
            EngineVersion = [string]$status.AMEngineVersion
            SignatureVersion = [string]$status.AntivirusSignatureVersion
        }
    }
    catch {
        return [pscustomobject]@{
            Available = $true
            Readable = $false
            ErrorCode = Get-SafeErrorCode $_.Exception
            AntivirusEnabled = $null
            RealTimeProtectionEnabled = $null
            BehaviorMonitorEnabled = $null
            IoavProtectionEnabled = $null
            EngineVersion = $null
            SignatureVersion = $null
        }
    }
}

function Convert-DefenderResourceToPath {
    param([AllowNull()][object]$Resource)

    if ($null -eq $Resource) {
        return $null
    }
    $value = ([string]$Resource).Trim()
    if ($value.StartsWith("file:_", [System.StringComparison]::OrdinalIgnoreCase)) {
        $value = $value.Substring(6)
    }
    try {
        if (-not [System.IO.Path]::IsPathRooted($value)) {
            return $null
        }
        return [System.IO.Path]::GetFullPath($value)
    }
    catch {
        return $null
    }
}

function Get-DetectionKey {
    param([Parameter(Mandatory = $true)][object]$Detection)

    $parts = @()
    foreach ($name in @("DetectionID", "ThreatID", "InitialDetectionTime", "LastThreatStatusChangeTime")) {
        $property = $Detection.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            $parts += [string]$property.Value
        }
    }
    if ($parts.Count -eq 0) {
        return "related-detection"
    }
    return $parts -join "|"
}

function Get-RelatedDetections {
    param([Parameter(Mandatory = $true)][string]$ExpectedAgentPath)

    if (-not (Get-CommandAvailable "Get-MpThreatDetection")) {
        return [pscustomobject]@{
            Readable = $false
            ErrorCode = "command_unavailable"
            Keys = @()
        }
    }

    try {
        $keys = @()
        foreach ($detection in @(Get-MpThreatDetection -ErrorAction Stop)) {
            $resourcesProperty = $detection.PSObject.Properties["Resources"]
            if ($null -eq $resourcesProperty) {
                continue
            }
            $matches = $false
            foreach ($resource in @($resourcesProperty.Value)) {
                $resourcePath = Convert-DefenderResourceToPath $resource
                if ($null -ne $resourcePath -and
                    [string]::Equals($resourcePath, $ExpectedAgentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $matches = $true
                    break
                }
            }
            if ($matches) {
                $keys += Get-DetectionKey $detection
            }
        }
        return [pscustomobject]@{
            Readable = $true
            ErrorCode = $null
            Keys = @($keys | Sort-Object -Unique)
        }
    }
    catch {
        return [pscustomobject]@{
            Readable = $false
            ErrorCode = Get-SafeErrorCode $_.Exception
            Keys = @()
        }
    }
}

function Get-AgentFileStatus {
    param([Parameter(Mandatory = $true)][string]$ExpectedAgentPath)

    $exists = Test-Path -LiteralPath $ExpectedAgentPath -PathType Leaf
    $sha256 = $null
    $signatureStatus = "file_missing"
    if ($exists) {
        $sha256 = (Get-FileHash -LiteralPath $ExpectedAgentPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if (Get-CommandAvailable "Get-AuthenticodeSignature") {
            try {
                $signatureStatus = [string](Get-AuthenticodeSignature -LiteralPath $ExpectedAgentPath).Status
            }
            catch {
                $signatureStatus = "unreadable"
            }
        }
        else {
            $signatureStatus = "command_unavailable"
        }
    }
    return [pscustomobject]@{
        Exists = $exists
        Sha256 = $sha256
        AuthenticodeStatus = $signatureStatus
    }
}

function Write-ResultAndExit {
    param(
        [Parameter(Mandatory = $true)][object]$Result,
        [Parameter(Mandatory = $true)][int]$ExitCode
    )

    $Result | ConvertTo-Json -Depth 6 -Compress
    exit $ExitCode
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or
    -not [System.IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is unavailable or invalid."
}

$localRoot = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd("\")
$acceptanceRoot = [System.IO.Path]::GetFullPath((Join-Path $localRoot "POPO\Acceptance\AgentRebootV1"))
$agentPath = [System.IO.Path]::GetFullPath((Join-Path $acceptanceRoot "Agent\PopoAgent.exe"))
$expectedAgentPath = [System.IO.Path]::GetFullPath((Join-Path $localRoot "POPO\Acceptance\AgentRebootV1\Agent\PopoAgent.exe"))
if (-not [string]::Equals($agentPath, $expectedAgentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The fixed security acceptance Agent path is invalid."
}

$agentLocation = "%LOCALAPPDATA%\POPO\Acceptance\AgentRebootV1\Agent\PopoAgent.exe"
$providers = Get-AntivirusProviders
$defender = Get-DefenderStatus
$agent = Get-AgentFileStatus $agentPath
$detectionsBefore = Get-RelatedDetections $agentPath

$baseResult = [ordered]@{
    SchemaVersion = 1
    Mode = if ($RunScan) { "defender_custom_scan" } else { "security_status" }
    Coverage = "microsoft_defender_fixed_agent_only"
    AgentLocation = $agentLocation
    AgentExists = $agent.Exists
    AgentSha256 = $agent.Sha256
    AuthenticodeStatus = $agent.AuthenticodeStatus
    AuthenticodeRequired = $false
    AntivirusProvidersReadable = $providers.Readable
    AntivirusProvidersErrorCode = $providers.ErrorCode
    AntivirusProviderCount = $providers.Names.Count
    AntivirusProviderNames = $providers.Names
    DefenderAvailable = $defender.Available
    DefenderStatusReadable = $defender.Readable
    DefenderStatusErrorCode = $defender.ErrorCode
    AntivirusEnabled = $defender.AntivirusEnabled
    RealTimeProtectionEnabled = $defender.RealTimeProtectionEnabled
    BehaviorMonitorEnabled = $defender.BehaviorMonitorEnabled
    IoavProtectionEnabled = $defender.IoavProtectionEnabled
    DefenderEngineVersion = $defender.EngineVersion
    DefenderSignatureVersion = $defender.SignatureVersion
    RelatedDetectionsReadable = $detectionsBefore.Readable
    RelatedDetectionsErrorCode = $detectionsBefore.ErrorCode
    RelatedDetectionCount = $detectionsBefore.Keys.Count
    SettingsChanged = $false
    ExclusionsChanged = $false
    AutomaticElevationUsed = $false
    SmartScreenVerified = $false
    ThirdPartyScanVerified = $false
}

if (-not $RunScan) {
    $baseResult.Ok = $true
    $baseResult.MutatedSystemState = $false
    Write-ResultAndExit ([pscustomobject]$baseResult) 0
}

$baseResult.MutatedSystemState = $true
if (-not $agent.Exists) {
    $baseResult.Ok = $false
    $baseResult.ErrorCode = "acceptance_agent_missing"
    Write-ResultAndExit ([pscustomobject]$baseResult) 1
}
if (-not (Get-CommandAvailable "Start-MpScan")) {
    $baseResult.Ok = $false
    $baseResult.ErrorCode = "scan_command_unavailable"
    Write-ResultAndExit ([pscustomobject]$baseResult) 1
}
if (-not $defender.Readable -or $defender.AntivirusEnabled -ne $true) {
    $baseResult.Ok = $false
    $baseResult.ErrorCode = "defender_not_active"
    Write-ResultAndExit ([pscustomobject]$baseResult) 1
}
if (-not $detectionsBefore.Readable) {
    $baseResult.Ok = $false
    $baseResult.ErrorCode = "detection_history_unreadable"
    Write-ResultAndExit ([pscustomobject]$baseResult) 1
}

$sha256Before = $agent.Sha256
try {
    Start-MpScan -ScanType CustomScan -ScanPath $agentPath -ErrorAction Stop | Out-Null
}
catch {
    $baseResult.Ok = $false
    $baseResult.ErrorCode = "defender_scan_failed"
    Write-ResultAndExit ([pscustomobject]$baseResult) 1
}

$agentAfter = Get-AgentFileStatus $agentPath
$detectionsAfter = Get-RelatedDetections $agentPath
$beforeKeys = @{}
foreach ($key in $detectionsBefore.Keys) {
    $beforeKeys[[string]$key] = $true
}
$newDetectionCount = 0
foreach ($key in $detectionsAfter.Keys) {
    if (-not $beforeKeys.ContainsKey([string]$key)) {
        $newDetectionCount += 1
    }
}

$baseResult.AgentExistsAfterScan = $agentAfter.Exists
$baseResult.AgentSha256AfterScan = $agentAfter.Sha256
$baseResult.RelatedDetectionsReadableAfterScan = $detectionsAfter.Readable
$baseResult.RelatedDetectionCountAfterScan = $detectionsAfter.Keys.Count
$baseResult.NewRelatedDetectionCount = $newDetectionCount
$baseResult.HashUnchanged = $agentAfter.Exists -and $sha256Before -eq $agentAfter.Sha256
$baseResult.Ok = $agentAfter.Exists -and
    $baseResult.HashUnchanged -and
    $detectionsAfter.Readable -and
    $newDetectionCount -eq 0
$baseResult.ErrorCode = if ($baseResult.Ok) { $null } elseif (-not $agentAfter.Exists) {
    "agent_removed_or_quarantined"
} elseif (-not $baseResult.HashUnchanged) {
    "agent_hash_changed"
} elseif (-not $detectionsAfter.Readable) {
    "detection_history_unreadable"
} else {
    "defender_detected_agent"
}

Write-ResultAndExit ([pscustomobject]$baseResult) $(if ($baseResult.Ok) { 0 } else { 1 })
