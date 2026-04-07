param(
  [string]$RootDir = "",
  [switch]$SkipDocker
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($RootDir)) {
  $RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$stackDir = Join-Path $RootDir ".socialclaw-stack"
$memoryDir = Join-Path $RootDir "memory/evermemos"

function Stop-ProcessTreeByTaskkill {
  param(
    [int]$TargetProcessId,
    [string]$Name,
    [string]$Reason
  )

  if (-not $TargetProcessId -or $TargetProcessId -le 0) {
    return
  }

  $out = & taskkill /PID $TargetProcessId /T /F 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Stopped $Name by $Reason (PID $TargetProcessId, taskkill /T /F)"
  } else {
    Write-Host "Failed to stop $Name by $Reason (PID $TargetProcessId): $($out -join '; ')"
  }
}

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
    Stop-ProcessTreeByTaskkill -TargetProcessId $pid -Name $Name -Reason "pid file"
  } catch {
    Write-Host "Failed to stop $Name or process already exited."
  }

  Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
}

function Stop-ListeningProcessByPort {
  param(
    [int]$Port,
    [string]$Name
  )

  $connections = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $connections) {
    return
  }

  $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($owningPid in $pids) {
    if (-not $owningPid -or $owningPid -le 0) { continue }
    Stop-ProcessTreeByTaskkill -TargetProcessId $owningPid -Name $Name -Reason "port $Port"
  }
}

function Stop-ProcessByCommandPattern {
  param(
    [string]$Name,
    [string[]]$Patterns
  )

  try {
    $all = Get-CimInstance Win32_Process -ErrorAction Stop
  } catch {
    Write-Host "Skipping command-pattern cleanup for $Name (Win32_Process access denied)."
    return
  }

  $matched = $all | Where-Object {
    $cmd = $_.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }
    foreach ($pattern in $Patterns) {
      if ($cmd -like $pattern) { return $true }
    }
    return $false
  }

  foreach ($proc in $matched) {
    Stop-ProcessTreeByTaskkill -TargetProcessId ([int]$proc.ProcessId) -Name $Name -Reason "pattern"
  }
}

Stop-PidFileProcess -Name "Frontend Dev" -PidPath (Join-Path $stackDir "frontend.pid")
Stop-PidFileProcess -Name "Visual Monitor API" -PidPath (Join-Path $stackDir "visual-monitor.pid")
Stop-PidFileProcess -Name "EverMemOS API" -PidPath (Join-Path $stackDir "evermemos.pid")

Stop-ListeningProcessByPort -Name "Frontend Dev" -Port 5173
Stop-ListeningProcessByPort -Name "Visual Monitor API" -Port 18777
Stop-ListeningProcessByPort -Name "EverMemOS API" -Port 1995

Stop-ProcessByCommandPattern -Name "Frontend Dev" -Patterns @(
  "*SocialClaw*social_copilot*frontend*electron-vite*",
  "*SocialClaw*social_copilot*frontend*npm*run dev*",
  "*SocialClaw*social_copilot*frontend*node_modules*electron*"
)
Stop-ProcessByCommandPattern -Name "Visual Monitor API" -Patterns @(
  "*social_copilot.visual_monitor.app:app*",
  "*uvicorn*127.0.0.1*18777*",
  "*uvicorn*--port 18777*--reload*",
  "*uvicorn*subprocess*18777*"
)
Stop-ProcessByCommandPattern -Name "EverMemOS API" -Patterns @(
  "*memory*evermemos*src/run.py*--port 1995*",
  "*memory*evermemos*uv run python src/run.py*"
)

if ($SkipDocker) {
  Write-Host "Skipping EverMemOS Docker dependencies stop."
} else {
  Write-Host "Stopping EverMemOS Docker dependencies..."
  Push-Location $memoryDir
  docker-compose down
  Pop-Location
}