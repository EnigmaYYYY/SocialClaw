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
  [switch]$SkipDocker
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RootDir)) {
  $RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$stackDir = Join-Path $RootDir ".socialclaw-stack"
$memoryDir = Join-Path $RootDir "memory/evermemos"
$frontendDirResolved = if ([System.IO.Path]::IsPathRooted($FrontendDir)) { $FrontendDir } else { Join-Path $RootDir $FrontendDir }
$nodeDir = Split-Path -Parent $NodeExe

New-Item -ItemType Directory -Force -Path $stackDir | Out-Null

if (-not (Test-Path $memoryDir)) {
  throw "EverMemOS directory not found: $memoryDir"
}
if (-not (Test-Path $frontendDirResolved)) {
  throw "Frontend directory not found: $frontendDirResolved"
}
if (-not (Test-Path $VisualMonitorPython)) {
  throw "VisualMonitorPython not found: $VisualMonitorPython"
}
if (-not (Test-Path $EverMemOSPython)) {
  throw "EverMemOSPython not found: $EverMemOSPython"
}
if (-not (Test-Path $NodeExe)) {
  throw "NodeExe not found: $NodeExe"
}
if (-not (Test-Path $NpmCmd)) {
  throw "NpmCmd not found: $NpmCmd"
}

function Start-BackgroundProcess {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$CommandLine,
    [string]$PidPath,
    [string]$LogPath
  )

  if (Test-Path $PidPath) {
    try {
      $existingPid = [int](Get-Content $PidPath -Raw)
      $null = Get-Process -Id $existingPid -ErrorAction Stop
      $killOut = & taskkill /PID $existingPid /T /F 2>&1
      if ($LASTEXITCODE -eq 0) {
        Write-Host "$Name old PID $existingPid stopped before restart (taskkill /T /F)."
      } else {
        Write-Host "$Name old PID $existingPid stop failed: $($killOut -join '; ')"
      }
      Start-Sleep -Milliseconds 300
    } catch {
      Write-Host "$Name old PID not running or invalid, continuing."
    } finally {
      Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
    }
  }

  $utf8Bootstrap = "[Console]::InputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; `$OutputEncoding=[System.Text.Encoding]::UTF8; `$env:PYTHONUTF8='1'; `$env:PYTHONIOENCODING='utf-8'"
  $command = "$utf8Bootstrap; Set-Location '$WorkingDirectory'; $CommandLine 2>&1 | Tee-Object -FilePath '$LogPath' -Append"
  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", $command) `
    -WorkingDirectory $WorkingDirectory `
    -PassThru

  Set-Content -Path $PidPath -Value $process.Id
  Write-Host "$Name started with PID $($process.Id)"
}

function Wait-TcpPortReady {
  param(
    [string]$Name,
    [string]$TargetHost,
    [int]$Port,
    [DateTime]$Deadline
  )

  while ((Get-Date) -lt $Deadline) {
    $client = $null
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $asyncResult = $client.BeginConnect($TargetHost, $Port, $null, $null)
      $connected = $asyncResult.AsyncWaitHandle.WaitOne(1500)
      if ($connected -and $client.Connected) {
        $client.EndConnect($asyncResult)
        Write-Host "$Name is ready at $TargetHost`:$Port"
        return
      }
    } catch {
    } finally {
      if ($client) { $client.Dispose() }
    }
    Start-Sleep -Seconds 2
  }

  throw "$Name did not become ready at $TargetHost`:$Port within ${DependencyTimeoutSec}s."
}

function Wait-HttpReady {
  param(
    [string]$Name,
    [string]$Url,
    [DateTime]$Deadline
  )

  while ((Get-Date) -lt $Deadline) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
      if ($resp.StatusCode -eq 200) {
        Write-Host "$Name is ready at $Url"
        return
      }
    } catch {
    }
    Start-Sleep -Seconds 2
  }

  throw "$Name did not become ready at $Url within ${DependencyTimeoutSec}s."
}

Write-Host "[0/4] Cleaning residual processes before startup..."
& (Join-Path $PSScriptRoot "stop_social_stack.ps1") -RootDir $RootDir -SkipDocker

if ($SkipDocker) {
  Write-Host "[1/4] Skipping EverMemOS Docker dependencies startup..."
} else {
  Write-Host "[1/4] Starting EverMemOS Docker dependencies..."
  Push-Location $memoryDir
  docker-compose up -d
  Pop-Location

  $dependencyDeadline = (Get-Date).AddSeconds($DependencyTimeoutSec)
  Wait-TcpPortReady -Name "MongoDB" -TargetHost "127.0.0.1" -Port 27017 -Deadline $dependencyDeadline
  Wait-TcpPortReady -Name "Redis" -TargetHost "127.0.0.1" -Port 6379 -Deadline $dependencyDeadline
  Wait-TcpPortReady -Name "Milvus" -TargetHost "127.0.0.1" -Port 19530 -Deadline $dependencyDeadline
  Wait-HttpReady -Name "Elasticsearch" -Url "http://127.0.0.1:19200/_cluster/health" -Deadline $dependencyDeadline
}

Write-Host "[2/4] Starting EverMemOS API..."
Start-BackgroundProcess `
  -Name "EverMemOS API" `
  -WorkingDirectory $memoryDir `
  -CommandLine "`$env:UV_PYTHON='$EverMemOSPython'; uv run python src/run.py --host $EverMemOSHost --port $EverMemOSPort" `
  -PidPath (Join-Path $stackDir "evermemos.pid") `
  -LogPath (Join-Path $stackDir "evermemos.log")

Write-Host "Waiting for EverMemOS health endpoint..."
$evermemosDeadline = (Get-Date).AddSeconds($DependencyTimeoutSec)
Wait-HttpReady `
  -Name "EverMemOS API" `
  -Url "http://$EverMemOSHost`:$EverMemOSPort/health" `
  -Deadline $evermemosDeadline

Write-Host "[3/4] Starting Visual Monitor API..."
Start-BackgroundProcess `
  -Name "Visual Monitor API" `
  -WorkingDirectory $RootDir `
  -CommandLine "$VisualMonitorPython -m uvicorn social_copilot.visual_monitor.app:app --host $VisualMonitorHost --port $VisualMonitorPort --reload" `
  -PidPath (Join-Path $stackDir "visual-monitor.pid") `
  -LogPath (Join-Path $stackDir "visual-monitor.log")

Write-Host "[4/4] Starting Frontend (Electron Dev)..."
Start-BackgroundProcess `
  -Name "Frontend Dev" `
  -WorkingDirectory $frontendDirResolved `
  -CommandLine "`$env:Path='$nodeDir;' + `$env:Path; Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; & '$NpmCmd' run dev" `
  -PidPath (Join-Path $stackDir "frontend.pid") `
  -LogPath (Join-Path $stackDir "frontend.log")

Write-Host ""
Write-Host "Services started."
Write-Host "Logs: $stackDir"
