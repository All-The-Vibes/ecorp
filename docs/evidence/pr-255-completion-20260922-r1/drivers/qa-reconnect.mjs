import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
assert.ok(path.isAbsolute(process.env.ECORP_ISSUE161_QA ?? ''), 'Explicit owned QA root required')
const qa = path.resolve(process.env.ECORP_ISSUE161_QA)
assert.ok(path.isAbsolute(process.env.ECORP_ISSUE161_REPOSITORY ?? ''), 'Explicit product root required')
const root = path.resolve(process.env.ECORP_ISSUE161_REPOSITORY)
const demo = JSON.parse(readFileSync(path.join(qa,'demo.json'),'utf8'))
const baseline = JSON.parse(readFileSync(path.join(qa,'authority-baseline.json'),'utf8'))
const api = 'http://127.0.0.1:18971'
const issue = Number(process.argv[2] ?? 9163)
assert.ok([9163,9164].includes(issue))
const read = name => JSON.parse(readFileSync(path.join(qa,name),'utf8'))
const save = (name,value) => writeFileSync(path.join(qa,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms))
const record = { started_at:new Date().toISOString(), physical_multi_host_acceptance:false }
async function snapshot() {
  const response = await fetch(`${api}/api/corps/${demo.corp_id}/snapshot?actor_id=${demo.alice_actor_id}`,{
    redirect:'error',signal:AbortSignal.timeout(5000) })
  assert.equal(response.status,200)
  return response.json()
}
async function until(label, condition, timeout=90_000) {
  const end=Date.now()+timeout
  while(Date.now()<end) { const value=await condition();if(value)return value;await delay(250) }
  throw new Error(`Timed out: ${label}`)
}
async function host(dry) {
  await run(process.env.ECORP_QA_PWSH,['-NoProfile','-NonInteractive','-File',path.join(import.meta.dirname,'qa-host.ps1'),
    '-Action','Controllers','-Issue',String(issue),...(dry?['-DryRun']:[])],{cwd:root,windowsHide:true,timeout:40_000})
}
await host(true)
await until('both read-only controller previews',async()=>{
  const state=read('host-state.json')
  for(const letter of ['a','b']) {
    const p=state.processes[`preview-${issue}-${letter}`]
    const text=readFileSync(p.stdout,'utf8')
    if(!text.trim()) {
      const error=readFileSync(p.stderr,'utf8')
      assert.equal(error.trim(),'','Native preview failed; inspect retained stderr')
      return false
    }
    const preview=JSON.parse(text)
    assert.equal(preview.preflight.valid,true)
    assert.equal(preview.selected.issue_number,issue)
    assert.equal(preview.claim_authority.pin_verified,true)
    assert.deepEqual(preview.mutations,[])
  }
  return true
})
console.log('Both reconnect-case dry runs passed; executing the approved synthetic case.')
await host(false)
const started=await until('native run startup',async()=>{
  const current=await snapshot()
  const item=current.snapshot.factory_work_items.find(i=>i.source_issue_number===issue)
  const tasks=current.snapshot.tasks.filter(t=>t.mission_id===item?.mission_id)
  const candidate=current.snapshot.runs.find(r=>tasks.some(t=>t.id===r.task_id))
  return candidate?.status==='running' && candidate.workspace_path ? {current,item,run:candidate} : null
})
record.item_id=started.item.id;record.mission_id=started.item.mission_id;record.run_id=started.run.id
record.before_restart_status=started.run.status
record.runner_ids=started.current.runners.map(r=>r.id)
record.runner_processes=Object.fromEntries(['runner-a','runner-b'].map(k=>[k,read('host-state.json').processes[k].pid]))
record.credential_before=Object.fromEntries(['a','b'].map(k=>[k,createHash('sha256').update(readFileSync(path.join(qa,`credentials/runner-${k}-credential.json`))).digest('hex')]))
save(`reconnect-${issue}-before.json`,record)
console.log('Native run is active; restarting only the receipt-owned shared API.')
const restart=await run(process.execPath,[path.join(import.meta.dirname,'qa-api.mjs'),'restart-shared'],{
  cwd:root,windowsHide:true,timeout:90_000})
record.api_restart=JSON.parse(restart.stdout.trim())
assert.notEqual(record.api_restart.old_server_pid,record.api_restart.new_server_pid)
const completed=await until('same native run verified after reconnect',async()=>{
  const current=await snapshot()
  const item=current.snapshot.factory_work_items.find(i=>i.id===record.item_id)
  const candidate=current.snapshot.runs.find(r=>r.id===record.run_id)
  assert.ok(item)
  assert.equal(item.mission_id,record.mission_id)
  if(['failed','cancelled','lost'].includes(candidate?.status)) throw new Error(`Native run became ${candidate.status}`)
  return item.state==='verified' && candidate?.status==='completed' ? {current,item,run:candidate} : null
})
assert.equal(completed.run.verification_status,'passed')
assert.equal(completed.run.source_base_commit,baseline.source_commit)
assert.equal(completed.current.snapshot.factory_work_items.filter(i=>i.source_issue_number===issue).length,1)
const taskIds=completed.current.snapshot.tasks.filter(t=>t.mission_id===record.mission_id).map(t=>t.id)
assert.equal(completed.current.snapshot.runs.filter(r=>taskIds.includes(r.task_id)).length,1)
assert.equal(completed.current.runners.filter(r=>r.connected && record.runner_ids.includes(r.id)).length,2)
record.credential_after=Object.fromEntries(['a','b'].map(k=>[k,createHash('sha256').update(readFileSync(path.join(qa,`credentials/runner-${k}-credential.json`))).digest('hex')]))
for(const key of ['a','b']) assert.notEqual(record.credential_before[key],record.credential_after[key])
record.verification_status=completed.run.verification_status
record.source_commit=completed.run.source_base_commit
record.exact_run_and_mission_retained=true
record.fixture_credentials_rotated=true
record.completed_at=new Date().toISOString()
save(`reconnect-${issue}-result.json`,record)
console.log(JSON.stringify(record,null,2))
