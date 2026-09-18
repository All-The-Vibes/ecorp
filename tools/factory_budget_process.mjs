// Thin Windows-fixture adapter. Native ownership/handle checks stay in local_stack.psm1.
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const modulePath = fileURLToPath(new URL('./local_stack.psm1', import.meta.url))
const setup = "$ErrorActionPreference='Stop'; Import-Module -Name $env:ECORP_QA_OWNERSHIP_MODULE -Force; "

async function nativeOwnership(script, values, { workspace, environment = process.env }) {
  assert.equal(process.platform, 'win32', 'Windows native process receipts required')
  assert.ok(path.isAbsolute(workspace), 'Explicit absolute owned workspace required')
  const { stdout } = await execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', setup + script], {
    cwd: workspace, windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024,
    env: { ...environment, ECORP_QA_OWNERSHIP_MODULE: modulePath, ECORP_QA_WORKSPACE: workspace, ...values },
  })
  return stdout.trim() ? JSON.parse(stdout) : null
}

export async function factoryBudgetProcessIdentity(processId, options) {
  assert.ok(Number.isSafeInteger(processId) && processId > 0, 'Valid owned child PID required')
  return nativeOwnership(
    '$identity = Get-LocalProcessIdentity -ProcessId ([int]$env:ECORP_QA_PROCESS_ID); ' +
    'if ($identity) { $identity.workspace=$env:ECORP_QA_WORKSPACE; $identity | ConvertTo-Json -Compress }',
    { ECORP_QA_PROCESS_ID: String(processId) }, options,
  )
}

export async function stopFactoryBudgetProcess(receipt, options) {
  assert.ok(receipt && Number.isSafeInteger(receipt.pid) && receipt.pid > 0, 'Owned receipt required')
  // No CIM timestamp conversion, PID-only kill or fallback termination is permitted.
  const result = await nativeOwnership(
    '$record = ConvertFrom-Json -InputObject $env:ECORP_QA_PROCESS_RECEIPT -AsHashtable; ' +
    'if (!(Stop-LocalOwnedProcess -Record $record -Workspace $env:ECORP_QA_WORKSPACE)) { ' +
    "throw 'QA process ownership changed or is unverifiable; preserved' }; " +
    "@{stopped=$true} | ConvertTo-Json -Compress",
    { ECORP_QA_PROCESS_RECEIPT: JSON.stringify(receipt) }, options,
  )
  assert.equal(result?.stopped, true)
}
