param(
    [string]$SessionName = "pi-teams",
    [string[]]$Workers = @("alice", "bob")
)

$ErrorActionPreference = "Stop"

function Quote-PowerShell([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-ShellCommand {
    if (Get-Command pwsh -ErrorAction SilentlyContinue) { return "pwsh" }
    return "powershell.exe"
}

$ShellExe = Get-ShellCommand
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$ExtEntry = Join-Path $RepoDir "extensions/teams/index.ts"

if (-not (Test-Path $ExtEntry)) {
    throw "Extension entry not found: $ExtEntry"
}

$TeamsRoot = if ($env:PI_TEAMS_ROOT_DIR) {
    $env:PI_TEAMS_ROOT_DIR
} else {
    Join-Path $env:TEMP ("pi-teams-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
New-Item -ItemType Directory -Force -Path $TeamsRoot | Out-Null

function New-WindowCommand([hashtable]$Vars) {
    $Assignments = foreach ($Entry in $Vars.GetEnumerator()) {
        '$env:{0} = {1}' -f $Entry.Key, (Quote-PowerShell $Entry.Value)
    }

    return (@(
        $Assignments
        ('Set-Location ' + (Quote-PowerShell $RepoDir))
        ('& pi -e ' + (Quote-PowerShell $ExtEntry))
    ) -join '; ')
}

Write-Host "Starting leader..."
$LeaderCommand = New-WindowCommand @{
    PI_TEAMS_ROOT_DIR = $TeamsRoot
}
Start-Process -FilePath $ShellExe -WorkingDirectory $RepoDir -ArgumentList @("-NoExit", "-Command", $LeaderCommand) | Out-Null

$TeamId = $null
for ($i = 0; $i -lt 80; $i++) {
    $TeamDir = Get-ChildItem -Path $TeamsRoot -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($TeamDir) {
        $TeamId = $TeamDir.Name
        break
    }
    Start-Sleep -Milliseconds 250
}

if (-not $TeamId) {
    throw "Timed out waiting for team directory under $TeamsRoot"
}

Write-Host "TeamId: $TeamId"
Write-Host "Starting workers: $($Workers -join ', ')"

foreach ($Worker in $Workers) {
    $WorkerCommand = New-WindowCommand @{
        PI_TEAMS_ROOT_DIR = $TeamsRoot
        PI_TEAMS_WORKER = "1"
        PI_TEAMS_TEAM_ID = $TeamId
        PI_TEAMS_AGENT_NAME = $Worker
    }
    Start-Process -FilePath $ShellExe -WorkingDirectory $RepoDir -ArgumentList @("-NoExit", "-Command", $WorkerCommand) | Out-Null
}

Write-Host ""
Write-Host "OK"
Write-Host ""
Write-Host "launcher:     scripts/start-team-windows.ps1"
Write-Host "teams root:   $TeamsRoot"
Write-Host "team id:      $TeamId"
Write-Host ""
Write-Host "In the leader window, try:"
Write-Host "  /team help"
Write-Host "  /team task add $($Workers[0]): say hello"
Write-Host "  /team task list"
