# SPDX-License-Identifier: MIT
# Registers a weekly Windows scheduled task (Mon 09:00) that rebuilds the c3 catalog.
# The rebuild is HTTP-only (no LLM calls), so it costs nothing but a few seconds of CPU.
$node = (Get-Command node).Source
$script = Join-Path $env:USERPROFILE ".claude\skills\ccc\scripts\build-index.mjs"
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
Register-ScheduledTask -TaskName "c3-catalog-update" -Action $action -Trigger $trigger `
    -Description "c3 (Claude Code Concierge) catalog weekly rebuild" -Force | Out-Null
Write-Host "Registered weekly task 'c3-catalog-update' (Mon 09:00)."
Write-Host "Remove with: Unregister-ScheduledTask -TaskName c3-catalog-update -Confirm:`$false"
