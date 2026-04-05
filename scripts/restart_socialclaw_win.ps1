param(
  [string]$RootDir = "",
  [string]$VisualMonitorPython = "D:\conda_envs\emos2\python.exe",
  [string]$EverMemOSPython = "D:\conda_envs\emos2\python.exe",
  [string]$FrontendDir = "social_copilot/frontend",
  [string]$NodeExe = "D:\conda_envs\emos2\node.exe",
  [string]$NpmCmd = "D:\conda_envs\emos2\npm.cmd",
  [int]$DependencyTimeoutSec = 300,
  [string]$EverMemOSHost = "127.0.0.1",
  [int]$EverMemOSPort = 1995,
  [string]$VisualMonitorHost = "127.0.0.1",
  [int]$VisualMonitorPort = 18777,
  [int]$HealthTimeoutSec = 180,
  [switch]$ForceDockerRestart
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RootDir)) {
  $RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$stopScript = Join-Path $PSScriptRoot "stop_socialclaw_win.ps1"
$startScript = Join-Path $PSScriptRoot "start_socialclaw_win.ps1"

Write-Host "[1/3] Stopping stack..."
& $stopScript -RootDir $RootDir -SkipDocker:(-not $ForceDockerRestart)

Write-Host "[2/3] Starting stack..."
& $startScript `
  -RootDir $RootDir `
  -VisualMonitorPython $VisualMonitorPython `
  -EverMemOSPython $EverMemOSPython `
  -FrontendDir $FrontendDir `
  -NodeExe $NodeExe `
  -NpmCmd $NpmCmd `
  -DependencyTimeoutSec $DependencyTimeoutSec `
  -EverMemOSHost $EverMemOSHost `
  -EverMemOSPort $EverMemOSPort `
  -VisualMonitorHost $VisualMonitorHost `
  -VisualMonitorPort $VisualMonitorPort `
  -SkipDocker:(-not $ForceDockerRestart)

Write-Host "[3/3] Waiting for health checks..."
$everMemUrl = "http://$EverMemOSHost`:$EverMemOSPort/health"
$visualUrl = "http://$VisualMonitorHost`:$VisualMonitorPort/health"

$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$everMemOk = $false
$visualOk = $false

while ((Get-Date) -lt $deadline) {
  try {
    $everMemResp = Invoke-WebRequest -UseBasicParsing -Uri $everMemUrl -TimeoutSec 5
    if ($everMemResp.StatusCode -eq 200) { $everMemOk = $true }
  } catch {}

  try {
    $visualResp = Invoke-WebRequest -UseBasicParsing -Uri $visualUrl -TimeoutSec 5
    if ($visualResp.StatusCode -eq 200) { $visualOk = $true }
  } catch {}

  if ($everMemOk -and $visualOk) {
    break
  }

  Start-Sleep -Seconds 3
}

Write-Host "EverMemOS health: $everMemOk ($everMemUrl)"
Write-Host "Visual Monitor health: $visualOk ($visualUrl)"

if (-not ($everMemOk -and $visualOk)) {
  Write-Error "Restart completed but health checks failed."
  exit 1
}

Write-Host "Restart completed and health checks passed."
