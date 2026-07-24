# SPDX-License-Identifier: MIT
# c3 installer: copies the skill + /c3 alias into ~/.claude and writes the feature config.
# Options:
#   -NoFulltext          lite install: skip document-body indexing (smaller catalog)
#   -Vectors <provider>  enable hybrid vector search (gemini | voyage | openai).
#                        Provider validity is checked by the installer and runtime
#                        (single source of truth: PROVIDERS in scripts/embed.mjs).
param(
    [switch]$NoFulltext,
    [string]$Vectors = 'none'
)
$Vectors = $Vectors.ToLowerInvariant()
$allowedVectors = @('none', 'gemini', 'voyage', 'openai')
if ($allowedVectors -notcontains $Vectors) {
    Write-Error "Invalid -Vectors provider: $Vectors (expected none, gemini, voyage, or openai)"
    exit 1
}
$dest = Join-Path $env:USERPROFILE ".claude"
foreach ($d in 'skills', 'commands', 'ccc') {
    New-Item -ItemType Directory -Force (Join-Path $dest $d) | Out-Null
}
Copy-Item -Recurse -Force "skills/ccc" (Join-Path $dest "skills")
# Keep MIT notice with the installed skill (source of truth: repo-root LICENSE).
Copy-Item -Force "LICENSE" (Join-Path $dest "skills\ccc\LICENSE")
Copy-Item -Force "commands/c3.md" (Join-Path $dest "commands")
$fulltext = -not $NoFulltext
$config = [ordered]@{
    fulltext = $fulltext
    vectors = [ordered]@{ provider = $Vectors }
}
# Write UTF-8 without BOM. `Out-File -Encoding utf8` adds a BOM that Node's JSON.parse rejects.
$configPath = Join-Path $dest "ccc\config.json"
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 3), [System.Text.UTF8Encoding]::new($false))

Write-Host "Installed /ccc and /c3 (fulltext=$($fulltext.ToString().ToLowerInvariant()), vectors=$Vectors)."
if ($Vectors -ne 'none') {
    Write-Host "NOTE: set the $($Vectors.ToUpper())_API_KEY environment variable (default name) before the first catalog build."
}
Write-Host "Restart your Claude Code session to load the skill."
