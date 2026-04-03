$scriptPath = Join-Path $PSScriptRoot "stop_socialclaw_win.ps1"
& $scriptPath @args
exit $LASTEXITCODE
