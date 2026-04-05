$scriptPath = Join-Path $PSScriptRoot "restart_socialclaw_win.ps1"
& $scriptPath @args
exit $LASTEXITCODE
