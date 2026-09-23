$ErrorActionPreference = 'Stop'
$product = '<reviewed-worktree>'
$relative = 'output/playwright/.gitkeep'
$source = Join-Path $PSScriptRoot 'pr353-preserved-output-before-r5/playwright/.gitkeep'
$destination = Join-Path $product $relative
$receiptPath = Join-Path $PSScriptRoot 'pr353-placeholder-restoration-r5.json'
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $receiptPath)) { throw 'Preserve existing destination and receipt.' }
$expected = (& git -C $product rev-parse ":$relative").Trim()
if ($LASTEXITCODE -or $expected -cne '8b137891791fe96927ad78e64b0aad7bded08bdc') { throw 'Unexpected index placeholder.' }
$preservedBlob = (& git -C $product hash-object --path=$relative -- $source).Trim()
if ($LASTEXITCODE -or $preservedBlob -cne $expected) { throw 'Preserved bytes do not match the index after Git clean conversion.' }
$bytes = [IO.File]::ReadAllBytes($source)
if ([Convert]::ToHexString($bytes) -cne '0D0A') { throw 'Preserved placeholder is not the observed CRLF newline.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination
if ((Get-FileHash -LiteralPath $destination).Hash -cne (Get-FileHash -LiteralPath $source).Hash) { throw 'Restored working bytes differ.' }
if (& git -C $product diff --name-only) { throw 'Unstaged source differs after restoration.' }
$tree = (& git -C $product write-tree).Trim()
$validation = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pr353-validation-r9/validation.json') -Raw | ConvertFrom-Json
if ($LASTEXITCODE -or $validation.status -ne 'passed' -or $tree -cne $validation.staged_tree) { throw 'Staged tree differs from completed validation.' }
@{
  restored_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
  relative_path = $relative
  index_blob = $expected
  preserved_working_bytes = 2
  working_sha256 = (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant()
  validated_staged_tree = $tree
  prior_helper_sha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'preserve-pr353-output-r5.ps1')).Hash.ToLowerInvariant()
  correction = 'Prior preservation succeeded; its final empty-blob assumption failed. Restore the exact preserved CRLF newline, whose Git clean blob matches the index. Prior helper, outputs and receipt remain unchanged.'
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
Write-Output "Restored verified placeholder; staged tree remains $tree."
