# c3 installer: copies the skill and the /c3 alias into ~/.claude
$dest = Join-Path $env:USERPROFILE ".claude"
New-Item -ItemType Directory -Force (Join-Path $dest "skills") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $dest "commands") | Out-Null
Copy-Item -Recurse -Force "skills/ccc" (Join-Path $dest "skills")
Copy-Item -Force "commands/c3.md" (Join-Path $dest "commands")
Write-Host "Installed /ccc and /c3. Restart your Claude Code session to load them."
