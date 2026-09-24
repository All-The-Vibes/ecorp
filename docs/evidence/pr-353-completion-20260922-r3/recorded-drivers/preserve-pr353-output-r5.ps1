$ErrorActionPreference='Stop'
$product=[IO.Path]::GetFullPath('<reviewed-worktree>')
$output=[IO.Path]::GetFullPath((Join-Path $product 'output'))
$preserve=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'pr353-preserved-output-before-r5'))
if (!$output.StartsWith($product+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
    !$preserve.StartsWith([IO.Path]::GetFullPath($PSScriptRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Preservation escaped the named workspaces.' }
if(Test-Path -LiteralPath $preserve){throw 'Preserve the existing destination.'}
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force -DisableNameChecking
$state=Read-LocalStackState -Path (Join-Path $output 'local-pids.json') -Workspace $product
if(!$state){throw 'Missing prior ownership.'}
foreach($role in @('server','runner','web')) {
  $record=$state.processes[$role]
  if(!$record.stopped_at -or $record.stop_outcome -ne 'verified_root_stopped'){throw 'Prior process stop was not verified.'}
  if(Test-LocalOwnedProcess -Record $record -Workspace $product){throw 'Prior owned process is still running.'}
}
$moves=@()
foreach($name in @('local-pids.json','runner','local-stack','playwright')) {
  $from=[IO.Path]::GetFullPath((Join-Path $output $name))
  $to=[IO.Path]::GetFullPath((Join-Path $preserve $name))
  if(!$from.StartsWith($output+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or !$to.StartsWith($preserve+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid exact target.'}
  if(!(Test-Path -LiteralPath $from)){continue}
  $item=Get-Item -LiteralPath $from -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Do not move an aliased target.'}
  $entries=if($item.PSIsContainer){@(Get-ChildItem -LiteralPath $from -Recurse -Force)}else{@($item)}
  if(@($entries | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Do not traverse links during preservation.'}
  $files=@($entries | Where-Object {!$_.PSIsContainer} | ForEach-Object {@{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}})
  $moves+=@{source=$from;destination=$to;files=$files}
}
New-Item -ItemType Directory -Path $preserve | Out-Null
foreach($move in $moves){Move-Item -LiteralPath $move.source -Destination $move.destination}
foreach($move in $moves){foreach($file in $move.files){
  $preservedFile=$move.destination+$file.path.Substring($move.source.Length)
  if((Get-FileHash -LiteralPath $preservedFile).Hash.ToLowerInvariant() -cne $file.sha256){throw 'Preserved content hash differs.'}
}}
@{preserved_at=[DateTimeOffset]::UtcNow.ToString('o');moves=$moves} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $preserve 'receipt.json') -Encoding utf8
Write-Output 'Prior startup outputs preserved with verified content hashes.'

# The moved Playwright directory includes a tracked empty placeholder. Restore
# only that exact index blob, keeping every real prior output in preservation.
$placeholder = Join-Path $product 'output/playwright/.gitkeep'
if (!(Test-Path -LiteralPath $placeholder)) {
  $blob = (& git -C $product rev-parse ':output/playwright/.gitkeep').Trim()
  if ($LASTEXITCODE -or $blob -cne 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391') { throw 'Unexpected tracked placeholder bytes.' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $placeholder) -Force | Out-Null
  [IO.File]::WriteAllBytes($placeholder, [byte[]]@())
}
if (& git -C $product diff --name-only) { throw 'Source drift after output preservation.' }
