param(
  [string]$RootDir = ""
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($RootDir)) {
  $RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$stackDir = Join-Path $RootDir ".socialclaw-stack"
$memoryDir = Join-Path $RootDir "memory/evermemos"

function Stop-PidFileProcess {
  param(
    [string]$Name,
    [string]$PidPath
  )

  if (-not (Test-Path $PidPath)) {
    Write-Host "$Name not running (no pid file)."
    return
  }

  try {
    $pid = [int](Get-Content $PidPath -Raw)
    Stop-Process -Id $pid -Force -ErrorAction Stop
    Write-Host "Stopped $Name (PID $pid)"
  } catch {
    Write-Host "Failed to stop $Name or process already exited."
  }

  Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
}

Stop-PidFileProcess -Name "Visual Monitor API" -PidPath (Join-Path $stackDir "visual-monitor.pid")
Stop-PidFileProcess -Name "EverMemOS API" -PidPath (Join-Path $stackDir "evermemos.pid")

Write-Host "Stopping EverMemOS Docker dependencies..."
Push-Location $memoryDir
docker-compose down
Pop-Location
