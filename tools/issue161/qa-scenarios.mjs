import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const qa = 'C:\\Users\\aabdelsalam\\.ecorp\\qa\\issue-161-shared-authority'
const source = path.join(qa, 'source')
const apis = { shared: 'http://127.0.0.1:18971', independent: 'http://127.0.0.1:18972' }
const action = process.argv[2]
assert.ok(['prepare','snapshot','negative','drift','summarize','add-reconnect-case','add-runner-b-case'].includes(action))
assert.equal(realpathSync(qa).toLowerCase(), path.resolve(qa).toLowerCase())
const save = (name, value) => writeFileSync(path.join(qa, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
const load = name => JSON.parse(readFileSync(path.join(qa, name), 'utf8'))
const git = args => execFileSync('git', ['-C',source,...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()

async function request(which, route, body) {
  const receipt = load(`api-${which}.json`)
  assert.equal(receipt.server_url, apis[which])
  assert.equal(receipt.server_state, 'running')
  assert.equal(receipt.test_owned, true)
  assert.equal(receipt.workspace.toLowerCase(), qa.toLowerCase())
  const response = await fetch(apis[which] + route, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}
async function ok(which, route, body) {
  const result = await request(which, route, body)
  assert.ok(result.status >= 200 && result.status < 300, `${which} request failed (${result.status})`)
  return result.body
}
async function snapshot(which = 'shared') {
  const demo = load(which === 'shared' ? 'demo.json' : 'demo-independent.json')
  return ok(which, `/api/corps/${demo.corp_id}/snapshot?actor_id=${demo.alice_actor_id}`)
}
function issue(number, title) {
  return { id: `I_QA161_${number}`, number, title,
    body: '## Outcome\n\nExercise a synthetic shared-authority fixture only.\n\n## Acceptance criteria\n\n- [ ] result.md exists with passing native verification.\n\n## Dependencies\n\nNo blockers.\n',
    url: `https://github.com/All-The-Vibes/ecorp/issues/${number}`, state: 'OPEN',
    createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z', labels: [{ name: 'factory:ready' }] }
}

if (action === 'prepare') {
  assert.equal(existsSync(source), false, 'Never adopt or reset a retained source')
  mkdirSync(source)
  writeFileSync(path.join(source, 'README.md'), '# Synthetic #161 source\nNo application, credentials or external effects.\n', { flag: 'wx' })
  git(['init','--initial-branch=main'])
  git(['add','README.md'])
  git(['-c','user.name=ECorp QA','-c','user.email=qa@example.invalid','commit','-m','Synthetic shared authority fixture'])
  git(['remote','add','origin','https://github.com/All-The-Vibes/ecorp.git'])
  const demo = await ok('shared','/api/demo/bootstrap',{ seed_agents: true })
  const other = await ok('independent','/api/demo/bootstrap',{ seed_agents: true })
  save('demo.json', demo); save('demo-independent.json', other)
  const readAuthority = (which, ids) => ok(which, `/api/corps/${ids.corp_id}/factory/authority?actor_id=${ids.alice_actor_id}`)
  const a = await readAuthority('shared',demo)
  const b = await readAuthority('independent',other)
  assert.equal(demo.corp_id, other.corp_id)
  assert.notEqual(a.authority.claim_authority_id,b.authority.claim_authority_id)
  save('authority-baseline.json', { checked_at: new Date().toISOString(), source_commit: git(['rev-parse','HEAD']),
    shared: a, independent: b, same_corp_id: true, different_ledgers: true })
  const cases = [issue(9161,'[slow] Shared authority concurrent controllers'),
    issue(9162,'Reject stale source before claim'), issue(9163,'[slow] Reconnect shared authority')]
  const github = { repository: 'all-the-vibes/ecorp',
    project: { id: 'PVT_QA161', number: 161, owner: 'ecorp-qa', title: 'Synthetic shared authority',
      status_field_id: 'PVTSSF_QA161', status_options: [{ id: 'todo', name: 'Todo' },
        { id: 'in-progress', name: 'In Progress' }, { id: 'done', name: 'Done' }] },
    items: cases.map(i => ({ id: `PVTI_QA161_${i.number}`, status: 'Todo', content: { ...i, type: 'Issue', repository: 'all-the-vibes/ecorp' } })),
    issues: Object.fromEntries(cases.map(i => [String(i.number),i])), item_edits: 0 }
  // Independent controlled reads deliberately let both contenders observe Todo.
  // The native shared database, never fake Project status, must decide ownership.
  save('fake-github-a.json',github); save('fake-github-b.json',github)
  console.log(JSON.stringify({ source_commit: git(['rev-parse','HEAD']), ...a.authority,
    independent_authority_id: b.authority.claim_authority_id, mode: 'synthetic_same_host' }))
} else if (['add-reconnect-case','add-runner-b-case'].includes(action)) {
  // Retain the failed #9163 helper attempt. This is a separately identified
  // bounded fixture case, not a replacement mission for its original item.
  for (const letter of ['a','b']) {
    const file = `fake-github-${letter}.json`
    const state = load(file)
    const number = action === 'add-reconnect-case' ? 9164 : 9165
    assert.equal(state.issues[String(number)],undefined)
    const added = issue(number, action === 'add-reconnect-case'
      ? '[slow] Reconnect after native QA timestamp correction' : 'Exercise the second native QA runner')
    state.issues[String(number)]=added
    state.items.push({id:`PVTI_QA161_${number}`,status:'Todo',content:{...added,type:'Issue',repository:'all-the-vibes/ecorp'}})
    writeFileSync(path.join(qa,file),JSON.stringify(state,null,2)+'\n')
  }
  console.log('Added one distinct bounded fixture; all prior case histories retained.')
} else if (action === 'snapshot') {
  const result = await snapshot()
  const file = `snapshot-${Date.now()}.json`
  save(file, result)
  console.log(JSON.stringify({ file, runners: result.runners.map(r => ({ id:r.id, connected:r.connected, connection_epoch:r.connection_epoch,
    fake_ready:r.capabilities.some(c=>c.name==='fake-process' && c.available) })),
    items:result.snapshot.factory_work_items.map(i=>({id:i.id,issue:i.source_issue_number,state:i.state,mission:i.mission_id})),
    runs:result.snapshot.runs.map(r=>({id:r.id,status:r.status,runner:r.runner_id,workspace:r.workspace_path,source:r.source_base_commit})) },null,2))
} else if (action === 'negative') {
  const baseline = load('authority-baseline.json')
  const demo = load('demo-independent.json')
  const before = await snapshot('independent')
  const policy = { source_base_ref:'HEAD',source_base_commit:baseline.source_commit,
    claim_authority_id:baseline.shared.authority.claim_authority_id }
  const denied = await request('independent',`/api/corps/${demo.corp_id}/factory/work-items/claim`,{
    actor_id:demo.alice_actor_id,source_project_owner:'ecorp-qa',source_project_number:161,
    source_project_item_id:'PVTI_QA161_NEGATIVE',source_repository_owner:'all-the-vibes',source_repository_name:'ecorp',
    source_issue_number:9161,source_issue_node_id:'I_QA161_NEGATIVE',source_issue_url:'https://github.com/All-The-Vibes/ecorp/issues/9161',
    source_title:'Independent-ledger rejection',source_revision:'revision-1',idempotency_key:'issue161-independent-negative',
    lease_seconds:300,policy })
  assert.equal(denied.status,409)
  assert.match(JSON.stringify(denied.body),/authority mismatch/)
  const after = await snapshot('independent')
  for (const field of ['factory_work_items','missions','tasks','runs','events']) assert.deepEqual(after.snapshot[field], before.snapshot[field])
  save('independent-ledger-negative.json',{same_corp_id:true,wrong_pin_rejected:true,status:denied.status,unchanged:true})
  console.log('Independent ledger rejected the shared pin; item/mission/task/run/event state stayed unchanged.')
} else if (action === 'drift') {
  const baseline = load('authority-baseline.json')
  assert.equal(git(['rev-parse','HEAD']),baseline.source_commit)
  assert.equal(git(['status','--porcelain']),'')
  writeFileSync(path.join(source,'drift.md'),'# Synthetic source changed after runner registration\n',{flag:'wx'})
  git(['add','drift.md'])
  git(['-c','user.name=ECorp QA','-c','user.email=qa@example.invalid','commit','-m','Synthetic source drift rejection case'])
  save('source-drift.json',{old_commit:baseline.source_commit,new_commit:git(['rev-parse','HEAD'])})
  console.log('Advanced only the synthetic source; registered runners still advertise their original immutable commit.')
} else {
  const result = await snapshot()
  const items = result.snapshot.factory_work_items.filter(i=>i.source_issue_number===9161)
  assert.equal(items.length,1)
  assert.equal(items[0].state,'verified')
  const mission = result.snapshot.missions.find(m=>m.id===items[0].mission_id)
  assert.equal(mission.status,'completed')
  const tasks = result.snapshot.tasks.filter(t=>t.mission_id===mission.id)
  const runs = result.snapshot.runs.filter(r=>tasks.some(t=>t.id===r.task_id))
  assert.equal(tasks.length,1); assert.equal(runs.length,1); assert.equal(runs[0].status,'completed')
  assert.equal(runs[0].verification_status,'passed')
  const baseline = load('authority-baseline.json')
  assert.equal(runs[0].source_base_commit,baseline.source_commit)
  const report = { checked_at:new Date().toISOString(),mode:'native_same_host_synthetic_providers',
    item_id:items[0].id,mission_id:mission.id,task_id:tasks[0].id,run_id:runs[0].id,runner_id:runs[0].runner_id,
    source_commit:runs[0].source_base_commit,authority:baseline.shared.authority,
    exactly_one_item_mission_task_run:true,verification_status:runs[0].verification_status,
    runner_ids:result.runners.map(r=>r.id),physical_multi_host_acceptance:false,
    original_source_readme_sha256:createHash('sha256').update(readFileSync(path.join(source,'README.md'))).digest('hex') }
  save(`native-result-${Date.now()}.json`,report)
  console.log(JSON.stringify(report,null,2))
}
