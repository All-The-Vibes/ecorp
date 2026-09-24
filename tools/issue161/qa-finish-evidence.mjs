import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const qa='C:\\Users\\aabdelsalam\\.ecorp\\qa\\issue-161-shared-authority'
const read=name=>JSON.parse(readFileSync(path.join(qa,name),'utf8'))
const save=(name,value)=>{
  if(existsSync(path.join(qa,name))) { assert.deepEqual(read(name),value,'Retained evidence differs; do not overwrite it');return }
  writeFileSync(path.join(qa,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
}
const demo=read('demo.json')
const before=read('pre-drift-snapshot.json')
const api='http://127.0.0.1:18971'
const response=await fetch(`${api}/api/corps/${demo.corp_id}/snapshot?actor_id=${demo.alice_actor_id}`,{redirect:'error',signal:AbortSignal.timeout(10000)})
assert.equal(response.status,200)
const after=await response.json()
for(const field of ['factory_work_items','missions','tasks','runs']) {
  for(const original of before.snapshot[field]) assert.deepEqual(after.snapshot[field].find(item=>item.id===original.id),original)
}
const driftItems=after.snapshot.factory_work_items.filter(item=>item.source_issue_number===9162)
assert.equal(driftItems.length,1)
assert.equal(driftItems[0].state,'blocked')
const driftTasks=after.snapshot.tasks.filter(t=>t.mission_id===driftItems[0].mission_id)
assert.equal(after.snapshot.runs.filter(r=>driftTasks.some(t=>t.id===r.task_id)).length,0)
const host=read('host-state.json')
for(const letter of ['a','b']) {
  const preview=JSON.parse(readFileSync(host.processes[`preview-9162-${letter}`].stdout,'utf8'))
  assert.equal(preview.preflight.valid,true)
  assert.equal(preview.claim_authority.pin_verified,true)
  assert.deepEqual(preview.mutations,[])
}
const errors=['a','b'].map(letter=>readFileSync(host.processes[`controller-9162-${letter}`].stderr,'utf8'))
assert.ok(errors.some(error=>/no connected runner advertises that immutable checkout/.test(error)))
assert.ok(errors.some(error=>/is claimed until/.test(error)))
const sourceDrift={...read('source-drift.json'),preflight_accepted_plan:true,dispatch_rejected:true,
  blocked_item_id:driftItems[0].id,blocked_mission_id:driftItems[0].mission_id,new_run_count:0,prior_state_unchanged:true,
  limitation:'The deterministic preflight validates the plan but did not reject runtime source unavailability before claim/materialization.'}
save('source-drift-result.json',sourceDrift)
const bundleProof=[]
for(const d of after.snapshot.source_deliverables) {
  assert.equal(d.corp_id,demo.corp_id)
  assert.match(d.uri,new RegExp(`^/api/corps/${demo.corp_id}/artifacts/[a-f0-9-]+$`))
  const download=await fetch(api+d.uri+`?actor_id=${demo.alice_actor_id}`,{redirect:'error',signal:AbortSignal.timeout(10000)})
  assert.equal(download.status,200)
  const bytes=Buffer.from(await download.arrayBuffer())
  assert.equal(bytes.length,d.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'),d.sha256)
  bundleProof.push({id:d.id,run_id:d.run_id,bytes:bytes.length,sha256:d.sha256,form:d.form})
}
const browserRunId=read('artifact-and-browser-result.json').browser_run_id
assert.equal(bundleProof.filter(bundle=>bundle.run_id===browserRunId).length,1)
const report={checked_at:new Date().toISOString(),source_drift:sourceDrift,source_bundles:bundleProof,
  helper:{base_commit:'b31a38a62330aacba80c3953142e1da957a63ecd',
    patched_sha256:'aa0d3c377847c479c69e8be6e1f809bf4b155c53dc6903c1d6922fde4732e144',
    refused_attempt_retained:'reconnect-before.json',native_cim_precision_difference_ticks:[2,4],native_lifecycle_tests_passed:7},
  completed_missions:after.snapshot.missions.filter(m=>m.status==='completed').length,
  completed_runs:after.snapshot.runs.filter(r=>r.status==='completed').length,
  active_runs:after.snapshot.runs.filter(r=>!['completed','failed','cancelled','lost'].includes(r.status)).length,
  physical_multi_host_acceptance:false,production_identity_acceptance:false,real_provider_inference:false,real_github_effects:false}
assert.equal(report.active_runs,0)
save('final-runtime-result.json',report)
save('final-runtime-snapshot.json',after)
console.log(JSON.stringify(report,null,2))
