$scriptPath = Join-Path $PSScriptRoot "start_socialclaw_win.ps1"
& $scriptPath @args
exit $LASTEXITCODE
