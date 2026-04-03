param(
  [string]$RootDir = "",
  [string]$VisualMonitorPython = "python",
  [string]$EverMemOSHost = "127.0.0.1",
  [int]$EverMemOSPort = 1995,
  [string]$VisualMonitorHost = "127.0.0.1",
  [int]$VisualMonitorPort = 18777
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RootDir)) {
  $RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$stackDir = Join-Path $RootDir ".socialclaw-stack"
$memoryDir = Join-Path $RootDir "memory/evermemos"
$frontendDir = Join-Path $RootDir "social_copilot/frontend"

New-Item -ItemType Directory -Force -Path $stackDir | Out-Null

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
      Write-Host "$Name already running with PID $existingPid"
      return
    } catch {
    }
  }

  $command = "Set-Location '$WorkingDirectory'; $CommandLine *> '$LogPath'"
  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", $command) `
    -WorkingDirectory $WorkingDirectory `
    -PassThru

  Set-Content -Path $PidPath -Value $process.Id
  Write-Host "$Name started with PID $($process.Id)"
}

Write-Host "[1/3] Starting EverMemOS Docker dependencies..."
Push-Location $memoryDir
docker-compose up -d
Pop-Location

Write-Host "[2/3] Starting EverMemOS API..."
Start-BackgroundProcess `
  -Name "EverMemOS API" `
  -WorkingDirectory $memoryDir `
  -CommandLine "uv run python src/run.py --host $EverMemOSHost --port $EverMemOSPort" `
  -PidPath (Join-Path $stackDir "evermemos.pid") `
  -LogPath (Join-Path $stackDir "evermemos.log")

Write-Host "[3/3] Starting Visual Monitor API..."
Start-BackgroundProcess `
  -Name "Visual Monitor API" `
  -WorkingDirectory $RootDir `
  -CommandLine "$VisualMonitorPython -m uvicorn social_copilot.visual_monitor.app:app --host $VisualMonitorHost --port $VisualMonitorPort --reload" `
  -PidPath (Join-Path $stackDir "visual-monitor.pid") `
  -LogPath (Join-Path $stackDir "visual-monitor.log")

Write-Host ""
Write-Host "Backend services started."
Write-Host "Frontend next step:"
Write-Host "Set-Location '$frontendDir'"
Write-Host "npm install"
Write-Host "npm run dev"
