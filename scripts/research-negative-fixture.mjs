import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const negativeFixtureCases = Object.freeze([
  'missing-file', 'oversized-file', 'invalid-probe', 'failed-parent',
])
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

export function negativeFixtureSelection(mission, environment = process.env) {
  const matches = [...mission.matchAll(/\[issue297-adversarial:([a-z-]+):([0-9a-f-]+)\]/g)]
  if (!mission.includes('[issue297-adversarial:')) return null
  const headers = [...mission.matchAll(/^MISSION: (\[issue297-adversarial:[^\r\n]+\])$/gm)]
  assert.equal(headers.length, 1, 'One exact native MISSION fixture header required')
  assert.equal(matches.length, mission.split('[issue297-adversarial:').length - 1, 'Malformed fixture marker')
  // The native prompt repeats the mission title in the task objective.
  assert.ok(matches.length > 0 && matches.every(match => match[0] === headers[0][1]), 'Conflicting fixture markers')
  const [, case_id, nonce] = matches[0]
  assert.ok(negativeFixtureCases.includes(case_id) && uuid.test(nonce), 'Unknown negative fixture case/nonce')
  assert.ok(environment.CRONY_ISSUE297_ADVERSARIAL_NONCE === nonce,
    'Adversarial fixture requires the operator-bound runner nonce')
  return { case_id, nonce }
}

// Called only by the deterministic fake process, after creating its own declared files.
// No shared worktree, signing key, service, database or production execution hook.
export async function applyNegativeResearchFixture({ selection, files, workspace, runId }) {
  assert.ok(selection && negativeFixtureCases.includes(selection.case_id) && uuid.test(selection.nonce))
  assert.match(runId, uuid)
  assert.ok(Array.isArray(files) && files.length === 2)
  assert.ok(['specialist-a', 'specialist-b'].some(key =>
    files[0] === `handoffs/${key}.md` && files[1] === `handoffs/${key}-probe.json`),
  'Negative fixture requires exact native research paths')
  for (const directory of [workspace, path.join(workspace, 'handoffs')]) {
    const metadata = await lstat(directory)
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Plain owned fixture directory required')
  }
  for (const file of files) {
    const metadata = await lstat(path.join(workspace, file))
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 &&
      metadata.size <= 6144, 'Fresh bounded declared files required')
  }
  const target = path.join(workspace, selection.case_id === 'invalid-probe' ? files[1] : files[0])
  if (selection.case_id === 'missing-file') await unlink(target)
  if (selection.case_id === 'oversized-file') await writeFile(target, 'x'.repeat(6145))
  if (selection.case_id === 'invalid-probe') await writeFile(target, '{"observed":')
  const observed = []
  for (const file of files) {
    if (selection.case_id === 'missing-file' && file === files[0]) {
      await assert.rejects(lstat(path.join(workspace, file)), { code: 'ENOENT' })
      observed.push({ path: file, missing: true })
    } else {
      const bytes = await readFile(path.join(workspace, file))
      observed.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  return { ...selection, run_id: runId, files: observed }
}
