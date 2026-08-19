[CmdletBinding()]
param(
    [switch]$RunAcceptance,
    [ValidateSet("Preflight", "Diagnose", "RebootStatus", "RebootPrepare", "RebootVerify", "RebootCleanup")]
    [string]$Mode = "Preflight"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$testFile = Join-Path $repoRoot "tests\agent.test.js"
$rebootScript = Join-Path $repoRoot "scripts\agent-reboot-acceptance.mjs"
$compilerPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$taskSchedulerCommand = Get-Command schtasks.exe -ErrorAction SilentlyContinue
$isWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$startupPreflightOk = $isWindows -and
    $null -ne $nodeCommand -and
    $null -ne $taskSchedulerCommand -and
    (Test-Path -LiteralPath $compilerPath -PathType Leaf) -and
    (Test-Path -LiteralPath $testFile -PathType Leaf)
$rebootPreflightOk = $isWindows -and
    $null -ne $nodeCommand -and
    $null -ne $taskSchedulerCommand -and
    (Test-Path -LiteralPath $rebootScript -PathType Leaf)

if ($RunAcceptance -and $Mode -ne "Preflight") {
    throw "Choose either -RunAcceptance or one reboot acceptance mode, not both."
}

$effectiveMode = if ($RunAcceptance) { "Startup" } else { $Mode }
$writesSystemState = $effectiveMode -in @("Startup", "RebootPrepare", "RebootVerify", "RebootCleanup")
$preflightOk = if ($effectiveMode -eq "Startup") {
    $startupPreflightOk
} elseif ($effectiveMode -eq "Diagnose") {
    $isWindows -and $null -ne $taskSchedulerCommand
} elseif ($effectiveMode -like "Reboot*") {
    $rebootPreflightOk
} else {
    $startupPreflightOk -and $rebootPreflightOk
}

$preflight = [ordered]@{
    Ok = $preflightOk
    Mode = $effectiveMode
    Windows = $isWindows
    Node = $null -ne $nodeCommand
    TaskScheduler = $null -ne $taskSchedulerCommand
    Compiler = Test-Path -LiteralPath $compilerPath -PathType Leaf
    TestFile = Test-Path -LiteralPath $testFile -PathType Leaf
    RebootScript = Test-Path -LiteralPath $rebootScript -PathType Leaf
    WritesSystemState = $writesSystemState
    RequiresExplicitRun = -not $writesSystemState
}

$preflight | ConvertTo-Json -Compress

# The default command is deliberately read-only. It never sets the acceptance
# gate and therefore cannot create or remove a scheduled task.
if ($effectiveMode -eq "Preflight") {
    return
}

if ($effectiveMode -eq "Diagnose") {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $currentProcessElevated = $principal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
    $administratorSid = "S-1-5-32-544"
    $currentUserInAdministratorsGroup = @(
        $identity.Groups | ForEach-Object { $_.Value }
    ) -contains $administratorSid
    $integritySid = @(
        & whoami.exe /groups /fo csv /nh 2>$null |
            ConvertFrom-Csv -Header "GroupName", "Type", "SID", "Attributes" |
            Where-Object { $_.SID -match "^S-1-16-\d+$" } |
            Select-Object -First 1 -ExpandProperty SID
    )
    $integrityRid = if ($integritySid.Count -eq 1) {
        [int](($integritySid[0] -split "-")[-1])
    } else {
        0
    }
    $integrityLevel = switch ($integrityRid) {
        4096 { "low" }
        8192 { "medium" }
        8448 { "medium_plus" }
        12288 { "high" }
        16384 { "system" }
        default { "unknown" }
    }
    $schedulerService = Get-CimInstance Win32_Service -Filter "Name='Schedule'" -ErrorAction SilentlyContinue
    $schedulerRunning = $null -ne $schedulerService -and $schedulerService.State -eq "Running"
    $scheduledTasksModuleAvailable = $null -ne (
        Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue
    )
    $recommendedAction = if (-not $schedulerRunning) {
        "start_task_scheduler_service"
    } elseif (-not $currentUserInAdministratorsGroup) {
        "administrator_policy_change_required"
    } elseif (-not $currentProcessElevated) {
        "retry_from_same_user_elevated_shell"
    } else {
        "retry_onlogon_acceptance"
    }
    [ordered]@{
        Ok = $schedulerRunning -and $null -ne $taskSchedulerCommand
        Mode = "startup-diagnose"
        Windows = $isWindows
        CurrentProcessElevated = $currentProcessElevated
        CurrentUserInAdministratorsGroup = $currentUserInAdministratorsGroup
        IntegrityLevel = $integrityLevel
        TaskSchedulerRunning = $schedulerRunning
        TaskSchedulerStartMode = if ($null -ne $schedulerService) {
            [string]$schedulerService.StartMode
        } else {
            "unknown"
        }
        SchtasksAvailable = $null -ne $taskSchedulerCommand
        ScheduledTasksModuleAvailable = $scheduledTasksModuleAvailable
        RecommendedAction = $recommendedAction
        WritesSystemState = $false
        MutatedSystemState = $false
    } | ConvertTo-Json -Compress
    return
}

if (-not $preflightOk) {
    throw "POPO Agent startup acceptance prerequisites are unavailable."
}

if ($effectiveMode -eq "RebootStatus") {
    & $nodeCommand.Source $rebootScript status
    if ($LASTEXITCODE -ne 0) {
        throw "POPO Agent reboot acceptance status failed with exit code $LASTEXITCODE."
    }
    return
}

if ($effectiveMode -like "Reboot*") {
    $rebootCommand = @{
        RebootPrepare = "prepare"
        RebootVerify = "verify"
        RebootCleanup = "cleanup"
    }[$effectiveMode]
    $previousRebootGate = [Environment]::GetEnvironmentVariable("POPO_AGENT_REBOOT_ACCEPTANCE", "Process")
    $rebootExitCode = 1
    try {
        $env:POPO_AGENT_REBOOT_ACCEPTANCE = "1"
        & $nodeCommand.Source $rebootScript $rebootCommand
        $rebootExitCode = $LASTEXITCODE
    } finally {
        if ($null -eq $previousRebootGate) {
            Remove-Item Env:POPO_AGENT_REBOOT_ACCEPTANCE -ErrorAction SilentlyContinue
        } else {
            $env:POPO_AGENT_REBOOT_ACCEPTANCE = $previousRebootGate
        }
    }
    if ($rebootExitCode -ne 0) {
        throw "POPO Agent reboot acceptance failed with exit code $rebootExitCode."
    }
    return
}

$testName = "installer registers, reads back, starts and removes the per-install logon task"
$previousGate = [Environment]::GetEnvironmentVariable("POPO_AGENT_STARTUP_ACCEPTANCE", "Process")
$testExitCode = 1

try {
    $env:POPO_AGENT_STARTUP_ACCEPTANCE = "1"
    & $nodeCommand.Source --test "--test-name-pattern=$testName" $testFile
    $testExitCode = $LASTEXITCODE
} finally {
    if ($null -eq $previousGate) {
        Remove-Item Env:POPO_AGENT_STARTUP_ACCEPTANCE -ErrorAction SilentlyContinue
    } else {
        $env:POPO_AGENT_STARTUP_ACCEPTANCE = $previousGate
    }
}

if ($testExitCode -ne 0) {
    throw "POPO Agent startup acceptance failed with exit code $testExitCode."
}
