import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

assert.ok(path.isAbsolute(process.env.ECORP_ISSUE161_QA ?? ''))
const qa = process.env.ECORP_ISSUE161_QA
const demo = JSON.parse(readFileSync(path.join(qa, 'demo.json'), 'utf8'))
const baseline = JSON.parse(readFileSync(path.join(qa, 'authority-baseline.json'), 'utf8'))
const [mode, issueText] = process.argv.slice(2)
assert.ok(['runners', 'preview', 'verified'].includes(mode))
const issue = Number(issueText)
if (mode !== 'runners') assert.ok([9161, 9162, 9165].includes(issue))
const api = 'http://127.0.0.1:18971'
const deadline = Date.now() + 120_000
let result
while (Date.now() < deadline) {
  const response = await fetch(api + '/api/corps/' + demo.corp_id + '/snapshot?actor_id=' + demo.alice_actor_id,
    { redirect: 'error', signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  const snapshot = await response.json()
  if (mode === 'runners') {
    const connected = snapshot.runners.filter(r => r.connected && ['issue161-runner-a', 'issue161-runner-b'].includes(r.id))
    if (connected.length === 2 && connected.every(r => r.capabilities.some(c => c.name === 'fake-process' && c.available))) {
      result = { connected_native_runners: connected.map(r => r.id) }
      break
    }
  } else if (mode === 'preview') {
    const host = JSON.parse(readFileSync(path.join(qa, 'host-state.json'), 'utf8').replace(/^\uFEFF/, ''))
    const previews = []
    for (const letter of ['a', 'b']) {
      const process = host.processes['preview-' + issue + '-' + letter]
      const output = readFileSync(process.stdout, 'utf8').trim()
      if (output) {
        const preview = JSON.parse(output)
        assert.equal(preview.preflight.valid, true)
        assert.equal(preview.selected.issue_number, issue)
        assert.equal(preview.claim_authority.pin_verified, true)
        assert.deepEqual(preview.mutations, [])
        previews.push(preview)
      } else {
        assert.equal(readFileSync(process.stderr, 'utf8').trim(), '', 'Preview failed; inspect retained native stderr')
      }
    }
    if (previews.length === 2) {
      result = { issue, previews, native_read_only: true }
      break
    }
  } else {
    const items = snapshot.snapshot.factory_work_items.filter(i => i.source_issue_number === issue)
    assert.ok(items.length <= 1, 'Controller race created duplicate items')
    if (items.length) {
      const item = items[0]
      const mission = snapshot.snapshot.missions.find(m => m.id === item.mission_id)
      const tasks = snapshot.snapshot.tasks.filter(t => t.mission_id === item.mission_id)
      const runs = snapshot.snapshot.runs.filter(r => tasks.some(t => t.id === r.task_id))
      assert.ok(runs.length <= 1, 'Controller race created duplicate runs')
      if (runs.some(r => ['failed', 'cancelled', 'lost'].includes(r.status))) throw new Error('Native case failed; retain all IDs')
      if (item.state === 'verified' && mission?.status === 'completed' && runs[0]?.status === 'completed') {
        assert.equal(tasks.length, 1)
        assert.equal(runs[0].verification_status, 'passed')
        assert.equal(runs[0].source_base_commit, baseline.source_commit)
        result = { issue, item_id: item.id, mission_id: mission.id, task_id: tasks[0].id, run_id: runs[0].id,
          runner_id: runs[0].runner_id, source_commit: runs[0].source_base_commit, exactly_one_item_mission_task_run: true,
          verification: 'passed' }
        break
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 250))
}
assert.ok(result, 'Timed out waiting for native ' + mode)
result.recorded_at = new Date().toISOString()
writeFileSync(path.join(qa, 'wait-' + mode + (issueText ? '-' + issue : '') + '.json'),
  JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(result))
