# c3 installer: copies the skill + /c3 alias into ~/.claude and writes the feature config.
# Options:
#   -NoFulltext          lite install: skip document-body indexing (smaller catalog)
#   -Vectors <provider>  enable hybrid vector search: gemini | voyage | openai
#                        (requires GEMINI_API_KEY / VOYAGE_API_KEY / OPENAI_API_KEY env var)
param(
    [switch]$NoFulltext,
    [ValidateSet('none', 'gemini', 'voyage', 'openai')]
    [string]$Vectors = 'none'
)
$dest = Join-Path $env:USERPROFILE ".claude"
New-Item -ItemType Directory -Force (Join-Path $dest "skills") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $dest "commands") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $dest "ccc") | Out-Null
Copy-Item -Recurse -Force "skills/ccc" (Join-Path $dest "skills")
Copy-Item -Force "commands/c3.md" (Join-Path $dest "commands")
$fulltext = if ($NoFulltext) { 'false' } else { 'true' }
@"
{
    "fulltext": $fulltext,
    "vectors": { "provider": "$Vectors" }
}
"@ | Out-File -Encoding utf8 (Join-Path $dest "ccc\config.json")

Write-Host "Installed /ccc and /c3 (fulltext=$fulltext, vectors=$Vectors)."
if ($Vectors -ne 'none') {
    Write-Host "NOTE: set the $($Vectors.ToUpper())_API_KEY environment variable before the first catalog build."
}
Write-Host "Restart your Claude Code session to load the skill."
