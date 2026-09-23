#requires -Version 7.4
param([Parameter(Mandatory)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../../local_stack.psm1') -Force -DisableNameChecking
$identity = Get-LocalProcessIdentity -ProcessId $ProcessId
if (!$identity) { throw 'The fixture process identity is unverifiable.' }
$identity | ConvertTo-Json -Compress
