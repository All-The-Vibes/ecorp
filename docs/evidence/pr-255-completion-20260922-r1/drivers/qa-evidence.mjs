import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

assert.ok(path.isAbsolute(process.env.ECORP_ISSUE161_QA ?? ''), 'Explicit owned QA root required')
const qa = path.resolve(process.env.ECORP_ISSUE161_QA)
const api = 'http://127.0.0.1:18971'
const demo = JSON.parse(readFileSync(path.join(qa,'demo.json'),'utf8'))
const response = await fetch(`${api}/api/corps/${demo.corp_id}/snapshot?actor_id=${demo.alice_actor_id}`,{
  redirect:'error',signal:AbortSignal.timeout(10000) })
assert.equal(response.status,200)
const data=await response.json()
const browser=data.snapshot.missions.filter(m=>m.title.includes('QA browser-to-runner authority regression'))
assert.equal(browser.length,1)
assert.equal(browser[0].status,'completed')
const browserTasks=data.snapshot.tasks.filter(t=>t.mission_id===browser[0].id)
assert.equal(browserTasks.length,1)
assert.deepEqual(browserTasks[0].verification_policy.checks.map(c=>c.type).sort(),['artifact','file'])
assert.equal(browserTasks[0].verification_policy.checks.find(c=>c.type==='file').path,'result.md')
assert.equal(data.snapshot.factory_work_items.some(i=>i.mission_id===browser[0].id),false)
const runs=[]
for(const r of data.snapshot.runs) {
  assert.equal(r.status,'completed')
  assert.equal(r.verification_status,'passed')
  assert.match(r.artifact_uri,new RegExp(`^/api/corps/${demo.corp_id}/artifacts/[a-f0-9-]+$`))
  const artifact=await fetch(api+r.artifact_uri+`?actor_id=${demo.alice_actor_id}`,{redirect:'error',signal:AbortSignal.timeout(10000)})
  assert.equal(artifact.status,200)
  const bytes=Buffer.from(await artifact.arrayBuffer())
  assert.ok(bytes.length>0 && bytes.length<=16*1024*1024)
  const digest=createHash('sha256').update(bytes).digest('hex')
  assert.equal(digest,r.artifact_sha256)
  const workspace=realpathSync(r.workspace_path)
  assert.ok(['runner-a','runner-b'].some(name=>workspace.toLowerCase().startsWith(path.join(qa,name).toLowerCase()+path.sep)))
  const terminated=data.snapshot.events.filter(e=>(e.type??e.event_type)==='run.session_terminated' && e.aggregate_id===r.id)
  assert.equal(terminated.length,1)
  assert.equal(terminated[0].payload.provider_process_alive,false)
  runs.push({run_id:r.id,runner_id:r.runner_id,artifact_id:r.artifact_id,downloaded_bytes:bytes.length,
    sha256:digest,workspace,verification:'passed',provider_terminated:true})
}
assert.equal(new Set(runs.map(r=>r.runner_id)).size,2,'Both independently enrolled native runners must receive work across these cases')
const browserRun=data.snapshot.runs.filter(r=>r.task_id===browserTasks[0].id)
assert.equal(browserRun.length,1)
const report={checked_at:new Date().toISOString(),browser_mission_id:browser[0].id,browser_run_id:browserRun[0].id,
  browser_initiated:true,custom_artifact_and_file_checks:true,runs,independent_download_hashes_match:true,
  both_native_runners_exercised:true,physical_multi_host_acceptance:false}
writeFileSync(path.join(qa,'artifact-and-browser-result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
writeFileSync(path.join(qa,'pre-drift-snapshot.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(report,null,2))
