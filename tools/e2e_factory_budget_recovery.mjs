import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, access, realpath, lstat, open } from 'node:fs/promises'
import { constants, openSync, closeSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fixtureMode, referenceSnapshotUrl } from './factory_budget_fixture_config.mjs'
import { factoryBudgetProcessIdentity, stopFactoryBudgetProcess } from './factory_budget_process.mjs'
// Both modules guard their native entrypoints; these imports only reuse read checks.
import { checkContainedFile } from './e2e_stopped_source_checkpoint.mjs'
import { readTrustedExecutableDigest } from './e2e_checkpoint_verification.mjs'

// Operator-owned, synthetic-only Windows fixture. No retained-stack defaults.
const execFile = promisify(execFileCallback)
const suite = 'issue-50-factory-budget-recovery-v1'
const root = path.resolve(import.meta.dirname, '..')
const qa = process.env.ECORP_ISSUE50_QA_ROOT
const pgBin = process.env.ECORP_ISSUE50_PG_BIN
assert.equal(process.platform, 'win32', 'This fixture requires Windows process receipts')
assert.ok(qa && path.isAbsolute(qa) && pgBin && path.isAbsolute(pgBin), 'Explicit QA root and PG bin required')
assert.equal(path.basename(qa), 'issue-50-factory-recovery')
assert.equal(path.basename(path.dirname(qa)), 'qa')
assert.ok(!qa.toLowerCase().startsWith(root.toLowerCase()), 'QA must be outside the source worktree')
const api = 'http://127.0.0.1:18450'
const pgPort = 55450
const runnerId = 'runner-qa-issue50'
const { execute, overrun, missingCheckpoint } = fixtureMode(process.argv.slice(2))
const referenceUrl = referenceSnapshotUrl(process.env.ECORP_ISSUE50_REFERENCE_SNAPSHOT_URL, api)
const source = path.join(qa, 'source')
const sourceReadme = '# Synthetic issue 50 source\nNo real application or credentials.\n'
const pgData = path.join(qa, 'pg-data')
const stamp = new Date().toISOString().replace(/[^0-9]/g, '')
const attempt = path.join(qa, 'attempts', stamp)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'userprofile',
    'homedrive', 'homepath', 'localappdata', 'appdata', 'programfiles', 'programfiles(x86)',
    'programdata', 'systemdrive', 'number_of_processors', 'processor_architecture'].includes(key.toLowerCase())))
const children = []
const report = { suite, started_at: new Date().toISOString(), api, postgres_port: pgPort,
  qa_root: qa, attempt, scenario:missingCheckpoint?'native-missing-checkpoint':overrun?'revised-budget-hard-stop':'bounded-recovery',
  real_model_calls: 0, real_github_mutations: 0, cleanup: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
const run = (program, args, extra = {}) => execFile(program, args, {
  cwd: qa, env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...extra,
})
async function exists(file) {
  try { await access(file); return true }
  catch(error) { if(error.code === 'ENOENT') return false; throw error }
}
async function assertUnlinkedDirectory(directory, allowMissing = false) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    try {
      const info = await lstat(current)
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Refuse linked or non-directory QA path: ${current}`)
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error
    }
    if (current === path.dirname(current)) break
  }
  if (!allowMissing) assert.equal((await realpath(directory)).toLowerCase(), path.resolve(directory).toLowerCase(),
    'QA directory must not redirect outside its declared path')
}
async function ports() {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in 55450,18450,18550 | Select-Object LocalPort,OwningProcess) | ConvertTo-Json -Compress'], { cwd: root })
  return stdout.trim() ? [].concat(JSON.parse(stdout)) : []
}
async function identity(pid) {
  return factoryBudgetProcessIdentity(pid, { workspace: qa, environment: env })
}
async function start(name, program, args, extraEnv = {}) {
  const out = openSync(path.join(attempt, `${name}.stdout.log`), 'a')
  const err = openSync(path.join(attempt, `${name}.stderr.log`), 'a')
  const child = spawn(program, args, { cwd: qa, env: { ...env, ...extraEnv }, windowsHide: true,
    stdio: ['ignore', out, err] })
  closeSync(out); closeSync(err)
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const owned = { name, program, child, receipt: null }
  children.push(owned)
  owned.receipt = await identity(child.pid)
  assert.ok(owned.receipt, `${name} exited before ownership could be verified`)
  assert.equal(path.resolve(owned.receipt.executable).toLowerCase(), path.resolve(program).toLowerCase())
  await json(path.join(attempt, 'processes.json'), children.map(c => ({name:c.name,...c.receipt})))
  return child
}
async function stopVerifiedChild(owned) {
  await stopFactoryBudgetProcess(owned.receipt, { workspace: qa, environment: env })
}
async function until(label, check, ms = 60000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await sleep(150)
  }
  throw new Error(`Timed out: ${label}`)
}
async function request(route, body) {
  const response = await fetch(`${api}${route}`, { redirect:'error', signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }) })
  const text = await response.text()
  return { status:response.status, body:text ? JSON.parse(text) : null }
}
async function ok(route, body) {
  const result = await request(route, body)
  assert.ok(result.status >= 200 && result.status < 300, `${route}: ${JSON.stringify(result)}`)
  return result.body
}
// Actual tested-input binding. No Git diff/source bytes or environment values in receipts.
async function sourceFileDigest(sourceRoot, relative) {
  assert.ok(relative && !/[:\\\x00-\x1f]/u.test(relative) &&
    relative.split('/').every(part => part && part !== '.' && part !== '..'),
  'Unsafe source path')
  assert.ok(!relative.split('/').some(part => /^(?:\.git|\.codex|\.omx|credentials|pg-data|runner-workspaces|worktrees)$/iu.test(part)) &&
    !/(?:^|\/)(?:\.env(?!\.example$)(?:\..*)?|credential\.json|enrollment\.token)$|\.(?:pem|key|pfx|p12|sqlite|db)$/iu.test(relative),
  'Private path is not a source input')
  const file = path.join(sourceRoot, relative)
  try { await checkContainedFile(sourceRoot, file) }
  catch (error) {
    if (error.code === 'ENOENT') return { path: relative, missing: true }
    throw error
  }
  const before = await lstat(file)
  assert.ok(before.size <= 64 * 1024 * 1024, 'Source file exceeds binding bound')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    assert.ok(opened.isFile() && opened.nlink === 1 && opened.dev === before.dev &&
      opened.ino === before.ino && opened.size === before.size, 'Source identity changed before read')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let bytes = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes)
      if (!bytesRead) break
      bytes += bytesRead
      assert.ok(bytes <= before.size, 'Source grew during binding')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    await checkContainedFile(sourceRoot, file)
    const current = await lstat(file)
    assert.ok(bytes === opened.size && [after, current].every(info =>
      info.dev === opened.dev && info.ino === opened.ino && info.size === opened.size &&
      info.mtimeMs === opened.mtimeMs && info.ctimeMs === opened.ctimeMs && info.nlink === 1),
    'Source identity changed during binding')
    return { path: relative, bytes, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}
async function captureSourceBinding(sourceRoot, programs) {
  const git = async args => (await run('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: sourceRoot })).stdout
  const head = (await git(['rev-parse', 'HEAD'])).trim()
  // Git enumerates tracked names; untracked discovery is restricted to code/config/test
  // roots. Never walk QA data, credentials, arbitrary ignored files or private workspaces.
  const untrackedRoots = ['apps', 'crates', 'db/migrations', 'deploy', 'scenarios', 'scripts', 'tests', 'tools', '.github',
    '.gitignore', '.gitattributes', '.npmrc', '.env.example',
    ...['toml', 'lock', 'json', 'yaml', 'yml', 'mjs', 'js', 'ps1', 'py'].map(ext => `:(top,glob)*.${ext}`)]
  const excluded = ['.git', '.codex', '.omx', 'credentials', 'pg-data', 'runner-workspaces', 'worktrees',
    'target', 'node_modules', 'output'].map(name => `:(exclude,glob)**/${name}/**`)
  const tracked = await git(['ls-files', '--cached', '-z', '--', '.', ...excluded])
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...untrackedRoots, ...excluded])
  const paths = [...new Set((tracked + untracked).split('\0').filter(Boolean))].sort()
  assert.ok(paths.length > 0 && paths.length <= 25000, 'Source inventory exceeds binding bound')
  const files = []
  for (const relative of paths) files.push(await sourceFileDigest(sourceRoot, relative))
  assert.equal((await git(['rev-parse', 'HEAD'])).trim(), head, 'HEAD changed during binding')
  const executables = {}
  for (const name of Object.keys(programs).sort()) {
    const file = programs[name]
    assert.ok(path.isAbsolute(file), 'Explicit executable path required')
    executables[name] = { path: file, sha256: await readTrustedExecutableDigest(file) }
  }
  return { source: { head, untracked_roots: untrackedRoots, excluded_pathspecs: excluded, files,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }, executables }
}
async function finishSourceBinding(report, sourceRoot, programs) {
  report.provenance.consistent = false
  report.provenance.after = await captureSourceBinding(sourceRoot, programs)
  report.provenance.consistent =
    JSON.stringify(report.provenance.before) === JSON.stringify(report.provenance.after)
  assert.ok(report.provenance.consistent, 'Tested source/executable binding changed')
}
async function readReference() {
  if (!referenceUrl) return null
  // Deliberately separate from QA requests: reference access has no write path,
  // request body, credentials, arbitrary route, or redirect to another host.
  const response = await fetch(referenceUrl, { method:'GET', redirect:'error', signal:AbortSignal.timeout(10000) })
  assert.equal(response.status,200,'The explicit reference snapshot must be readable')
  return stableState(await response.json())
}
function stableState(data) {
  const s = data.snapshot
  return { missions:s.missions.map(({id,status,budget_tokens})=>({id,status,budget_tokens})),
    tasks:s.tasks.map(({id,status})=>({id,status})),
    runs:s.runs.map(({id,status,breaker_stage,workspace_disposition,workspace_fingerprint,input_tokens,output_tokens})=>
      ({id,status,breaker_stage,workspace_disposition,workspace_fingerprint,input_tokens,output_tokens})),
    factory_items:s.factory_work_items.map(({id,state,version})=>({id,state,version})),
    controllers:s.factory_controllers.length, publications:s.pull_request_publications?.length ?? 0 }
}
// Refuse linked paths even before the read-only preflight commands.
await assertUnlinkedDirectory(attempt, true)
report.retained_before = await readReference()
report.retained_comparison = referenceUrl ? 'requested' : 'not_requested'
report.ports_before = await ports()
assert.equal(report.ports_before.length, 0, 'A QA port is already occupied; do not stop it')
report.source_code_commit = (await run('git', ['rev-parse', 'HEAD'], {cwd:root})).stdout.trim()
if (!execute) {
  console.log(JSON.stringify({...report, dry_run:true, proposed: ['create/reuse only receipt-owned QA cluster',
    'loopback-only trust authentication for synthetic data; no operator credentials',
    'new per-attempt test database', 'native server and fake Codex runner',
    'fake-GitHub one-shot Factory, budget revision and explicit resume',
    ...(missingCheckpoint?['hold only the unchanged synthetic QA README.md unreadable during checkpoint capture; release before native resume; never edit persisted checkpoint proof']:[]),
    'stop only receipt-owned QA processes; retain evidence']}, null, 2))
  process.exit(0)
}
const trustedNode = await realpath(process.execPath)
const provenancePrograms = {
  server: path.join(root, 'target/debug/crony-server.exe'),
  runner: path.join(root, 'target/debug/crony-runner.exe'),
  cli: path.join(root, 'target/debug/crony-cli.exe'),
  node: trustedNode,
  ...Object.fromEntries(['initdb', 'postgres', 'psql', 'createdb', 'pg_ctl'].map(name =>
    [name, path.join(pgBin, `${name}.exe`)])),
}
let demo
let lockedWorkspace
let lockedFileBytes
let lockProcess
let attemptAdmitted = false
const releaseSignal=path.join(attempt,'release-checkpoint-read-lock')
try {
  report.provenance = { schema_version: 1, assurance: 'input identity only; not build or native-scenario proof',
    before: await captureSourceBinding(root, provenancePrograms), consistent: null }
  assert.equal(report.provenance.before.source.head, report.source_code_commit, 'HEAD changed after preflight')
  // Check every existing ancestor, including dangling links, before creating anything.
  await assertUnlinkedDirectory(attempt, true)
  const ownerFile = path.join(qa, 'ownership.json')
  if (await exists(qa)) {
    assert.equal((await realpath(qa)).toLowerCase(),path.resolve(qa).toLowerCase(),'QA path must not redirect outside its owned root')
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'))
    assert.equal(owner.suite, suite)
    assert.equal(owner.qa_root, qa)
    assert.equal(owner.source_worktree, root)
  } else {
    let ancestor = path.dirname(qa)
    while (!(await exists(ancestor))) ancestor = path.dirname(ancestor)
    assert.equal((await realpath(ancestor)).toLowerCase(),path.resolve(ancestor).toLowerCase(),'QA parent must not redirect outside its declared path')
    await mkdir(qa, {recursive:true})
    await json(ownerFile, {suite, qa_root:qa, source_worktree:root, created_at:new Date().toISOString()})
  }
  assert.equal((await realpath(qa)).toLowerCase(),path.resolve(qa).toLowerCase(),'QA path must not redirect outside its owned root')
  await mkdir(path.dirname(attempt), {recursive:true})
  await assertUnlinkedDirectory(path.dirname(attempt))
  // Never adopt a timestamp collision or an unknown pre-existing attempt.
  await mkdir(attempt)
  await assertUnlinkedDirectory(attempt)
  attemptAdmitted = true
  await json(path.join(attempt, 'provenance-before.json'), report.provenance)
  // Stop dotenv discovery at the QA root; never inherit a parent .env file.
  const dotenvFile=path.join(qa,'.env')
  if(await exists(dotenvFile))assert.equal(await readFile(dotenvFile,'utf8'),'# Synthetic QA only\n')
  else await writeFile(dotenvFile,'# Synthetic QA only\n',{flag:'wx'})
  if (!(await exists(pgData))) {
    await run(path.join(pgBin,'initdb.exe'), ['-D',pgData,'-U','ecorp_qa50','-A','trust','--encoding=UTF8','--locale=C'])
  }
  assert.equal((await readFile(path.join(pgData,'PG_VERSION'),'utf8')).trim(), '17')
  assert.equal((await realpath(pgData)).toLowerCase(),path.resolve(pgData).toLowerCase())
  assert.equal(await exists(path.join(pgData,'postmaster.pid')), false, 'Retained QA postmaster receipt exists; inspect before reuse')
  if (!(await exists(source))) {
    await mkdir(source)
    await writeFile(path.join(source,'README.md'), sourceReadme)
    await run('git',['init','--initial-branch=main',source])
    await run('git',['-C',source,'add','README.md'])
    await run('git',['-C',source,'-c','user.name=ECorp QA','-c','user.email=qa@example.invalid','commit','-m','Synthetic recovery fixture'])
    await run('git',['-C',source,'remote','add','origin','https://github.com/All-The-Vibes/ecorp.git'])
  }
  assert.equal((await realpath(source)).toLowerCase(),path.resolve(source).toLowerCase(),'Fixture source path must not redirect outside QA root')
  const sourceRelative = path.relative(qa, path.resolve(source))
  assert.ok(sourceRelative && !sourceRelative.startsWith('..') && !path.isAbsolute(sourceRelative), 'Fixture source must remain inside QA root')
  assert.equal((await readFile(path.join(source,'README.md'),'utf8')), sourceReadme, 'Fixture source README must remain synthetic')
  assert.equal((await run('git',['-C',source,'remote','get-url','origin'])).stdout.trim(), 'https://github.com/All-The-Vibes/ecorp.git')
  assert.equal((await run('git',['-C',source,'ls-files'])).stdout.trim(), 'README.md')
  assert.equal((await run('git',['-C',source,'status','--porcelain'])).stdout.trim(), '')
  report.fixture_source_commit = (await run('git',['-C',source,'rev-parse','HEAD'])).stdout.trim()
  const pgChild = await start('postgres',path.join(pgBin,'postgres.exe'), ['-D',pgData,'-p',String(pgPort),'-h','127.0.0.1'])
  await until('QA PostgreSQL listener', async()=> (await ports()).some(p=>p.LocalPort===pgPort && p.OwningProcess===pgChild.pid))
  const pgEnv = {...env, PGHOST:'127.0.0.1',PGPORT:String(pgPort),PGUSER:'ecorp_qa50',PGDATABASE:'postgres'}
  const verified = (await run(path.join(pgBin,'psql.exe'), ['-X','-At','-v','ON_ERROR_STOP=1','-c',
    "SELECT current_setting('data_directory') || '|' || current_setting('port') || '|' || current_user"], {env:pgEnv})).stdout.trim().split('|')
  assert.equal(path.resolve(verified[0]).toLowerCase(),path.resolve(pgData).toLowerCase())
  assert.equal(verified[1],String(pgPort)); assert.equal(verified[2],'ecorp_qa50')
  const db = `ecorp_qa50_${stamp}`
  await run(path.join(pgBin,'createdb.exe'), [db], {env:pgEnv})
  report.database = db
  const apiChild = await start('server',path.join(root,'target/debug/crony-server.exe'),
    ['--bind','127.0.0.1:18450','--mode','development','--object-store-local-root',path.join(attempt,'artifacts')],
    { DATABASE_URL:`postgres://ecorp_qa50@127.0.0.1:${pgPort}/${db}`, CRONY_RUNNER_CREDENTIAL_TTL_SECS:'1800' })
  await until('QA API ready', async()=> { try{return (await request('/health')).body.status==='ok'}catch{return false} })
  assert.ok((await ports()).some(p=>p.LocalPort===18450 && p.OwningProcess===apiChild.pid))
  demo = await ok('/api/demo/bootstrap', {})
  const prefix = `/api/corps/${demo.corp_id}`
  const snapshot = ()=>ok(`${prefix}/snapshot?actor_id=${demo.alice_actor_id}`)
  const token = await ok(`${prefix}/runners/enroll`, {actor_id:demo.alice_actor_id,runner_id:runnerId,expires_in_seconds:600})
  const enrollment = path.join(attempt,'enrollment.token')
  await writeFile(enrollment,token.enrollment_token)
  await start('runner',path.join(root,'target/debug/crony-runner.exe'),
    ['--server-ws','ws://127.0.0.1:18450/ws/runner','--runner-id',runnerId,'--corp-id',demo.corp_id,
      '--credential-file',path.join(attempt,'credential.json'),'--enrollment-token-file',enrollment,
      '--workspace',path.join(attempt,'runner-workspaces'),'--source-repository',source,'--source-base-ref','HEAD',
      '--codex-command',trustedNode,'--codex-command-arg',path.join(root,'scripts/fake-codex-app-server.mjs'),
      '--claude-command',path.join(qa,'disabled-claude.exe'),'--opencode-command',path.join(qa,'disabled-opencode.exe'),
      '--copilot-cli-path',path.join(qa,'disabled-copilot.exe'),'--copilot-home',path.join(attempt,'copilot-home'),
      '--connections-directory',path.join(attempt,'connections'),'--github-command',path.join(qa,'disabled-gh.exe'),
      '--fake-agent-script',path.join(root,'scripts/fake-agent.mjs')], {CRONY_COPILOT_USE_LOGGED_IN_USER:'false'})
  await until('QA fake Codex runner ready',async()=> (await snapshot()).runners.some(r=>r.id===runnerId && r.connected && r.capabilities.some(c=>c.name==='codex' && c.available)))
  await ok(`${prefix}/budget-policy`, {actor_id:demo.alice_actor_id,actor_tokens_per_24h:10000000,
    actor_cost_microusd_per_24h:1000000000,corp_tokens_per_24h:100000000,corp_cost_microusd_per_24h:10000000000,
    no_progress_event_limit:100,repeated_tool_limit:100})
  const ghState = path.join(attempt,'fake-github.json')
  const verifier = path.join(attempt,'verifier.json')
  await json(verifier,{checks:[{type:'artifact',min_bytes:1},{type:'file',path:'resumed.txt',min_bytes:1}],
    manual_gate:{type:'independent_review',roles:['member','owner','admin'],exclude_requester:true}})
  const issue = {id:'I_QA50',number:9050,title:`[budget-stream] ${missingCheckpoint?'[checkpoint-read-lock] ':''}Resume incomplete synthetic Factory work`,
    body:'## Outcome\n\nContinue the same session after an authorized budget revision.\n\n## Acceptance criteria\n\n- [ ] resumed.txt exists after continuation\n- [ ] preserved source and spent usage remain intact\n\n## Dependencies\n\nNo blockers.\n',
    url:'https://github.com/All-The-Vibes/ecorp/issues/9050',state:'OPEN',createdAt:'2026-09-11T00:00:00Z',
    updatedAt:'2026-09-11T00:00:00Z',labels:[{name:'factory:ready'}]}
  await json(ghState,{repository:'all-the-vibes/ecorp',project:{id:'PVT_QA50',number:50,owner:'ecorp-qa',title:'Synthetic QA',
    status_field_id:'PVTSSF_QA50',status_options:[{id:'todo',name:'Todo'},{id:'in-progress',name:'In Progress'},{id:'done',name:'Done'}]},
    items:[{id:'PVTI_QA50',status:'Todo',content:{...issue,type:'Issue',repository:'all-the-vibes/ecorp'}}],issues:{'9050':issue},item_edits:0})
  async function controller(dry = false) {
    const args = ['--server',api,'factory',demo.corp_id,demo.alice_actor_id,'--owner','ecorp-qa','--project-number','50',
      '--repository','All-The-Vibes/ecorp','--source-repository-path',source,'--source-base-ref','HEAD','--adapter','codex',
      '--strategy','single','--budget-tokens','6000','--budget-cost-microusd','10000000','--lease-seconds','300',
      '--github-cli',trustedNode,'--issue','9050','--write-scope','**','--verification-policy-file',verifier,...(dry?['--dry-run']:[])]
    try {
      const {stdout}=await run(path.join(root,'target/debug/crony-cli.exe'),args,{env:{...env,
        ECORP_GITHUB_CLI_PREFIX_ARGS_JSON:JSON.stringify([path.join(root,'tools/fake_github_cli.mjs')]),ECORP_FAKE_GITHUB_STATE:ghState}})
      return {ok:true,body:JSON.parse(stdout)}
    } catch(error) { return {ok:false,detail:error.stderr?.trim() || error.message} }
  }
  report.preview_attempts=0
  const preview = await until('read-only Factory source/runtime admission',async()=> {
    report.preview_attempts++
    const preview=await controller(true)
    if(preview.ok)return preview
    // Registration is visible before the server's dispatch-readiness barrier.
    // Retry only this read-only admission result, never a claim or launch.
    assert.match(preview.detail,/no connected runner can staff/,JSON.stringify(preview))
    return null
  })
  await json(path.join(attempt,'factory-dry-run.json'),preview)
  console.log('QA factory dry-run passed; executing the approved synthetic issue.')
  report.initial_controller = await controller()
  assert.ok(report.initial_controller.ok,JSON.stringify(report.initial_controller))
  if(missingCheckpoint) {
    const started=await until('synthetic source file ready',async()=>{
      const s=await snapshot();const r=s.snapshot.runs[0]
      return r?.workspace_path && await exists(path.join(r.workspace_path,'base.txt'))?r:null
    })
    lockedWorkspace=started.workspace_path
    assert.equal(await readFile(path.join(lockedWorkspace,'base.txt'),'utf8'),'base\n')
    lockedFileBytes=await readFile(path.join(lockedWorkspace,'README.md'))
    // Git may apply CRLF checkout conversion. Bind to the tracked content here;
    // compare exact physical bytes before/after the lock within this worktree.
    await run('git',['-C',lockedWorkspace,'diff','--quiet','HEAD','--','README.md'])
    await run('git',['-C',lockedWorkspace,'status','--porcelain'])
    const pwsh=(await run('powershell.exe',['-NoProfile','-Command','(Get-Command pwsh.exe -ErrorAction Stop).Source'])).stdout.trim()
    lockProcess=await start('qa-read-lock',pwsh,['-NoProfile','-NonInteractive','-File',path.join(root,'tools/qa_hold_checkpoint_file.ps1'),
      '-QaRoot',qa,'-Workspace',lockedWorkspace,'-ReleaseSignal',releaseSignal])
  }
  const initial = await until('synthetic budget suspension',async()=> {
    const data=await snapshot(); const r=data.snapshot.runs.find(r=>r.breaker_stage==='suspend')
    return r && ['cancelled','failed'].includes(r.status) && r.workspace_disposition==='preserved' ? {data,run:r} : null
  })
  report.initial = stableState(initial.data)
  report.initial_run_summary=initial.run.summary
  report.initial_workspace_detail=initial.run.workspace_detail
  report.initial_events=initial.data.snapshot.events.map(e=>({id:e.id,seq:e.seq,type:e.type,aggregate_id:e.aggregate_id,
    error:e.payload?.error,reason:e.payload?.reason,outcome:e.payload?.outcome,provider_process_alive:e.payload?.provider_process_alive}))
  if(missingCheckpoint) {
    assert.equal(initial.run.workspace_fingerprint,null,'Fault injection must not create checkpoint proof')
    assert.equal(initial.run.status,'cancelled','Fault injection must reach checkpoint capture, not adapter runtime failure')
    assert.match(initial.run.workspace_detail,/workspace fingerprint path .*README\.md/i)
    report.missing_checkpoint_detail=initial.run.workspace_detail
    await writeFile(releaseSignal,'release synthetic QA file handle\n')
    await until('synthetic file handle released',async()=>(await identity(lockProcess.pid))===null,10000)
    assert.equal(await exists(path.join(lockedWorkspace,'.qa-checkpoint-lock-ready')),false,'Lock handshake marker must not contaminate resumed source')
    assert.equal(await readFile(path.join(lockedWorkspace,'base.txt'),'utf8'),'base\n')
    assert.deepEqual(await readFile(path.join(lockedWorkspace,'README.md')),lockedFileBytes)
    report.synthetic_locked_file='README.md'
    report.synthetic_bytes_unchanged_after_release=true
  }
  const r = initial.run
  const task = initial.data.snapshot.tasks.find(t=>t.id===r.task_id)
  const mission = initial.data.snapshot.missions.find(m=>m.id===task.mission_id)
  assert.deepEqual(task.verification_policy,JSON.parse(await readFile(verifier,'utf8')))
  assert.equal(r.input_tokens+r.output_tokens,6000)
  assert.ok(r.provider_session_id)
  report.lineage = {mission_id:mission.id,task_id:task.id,source_run_id:r.id,provider_session_id:r.provider_session_id,
    workspace_run_id:r.workspace_run_id,source_repository:r.source_repository,source_base_commit:r.source_base_commit}
  report.no_approval_resume = await request(`${prefix}/runs/${r.id}/resume`,{requested_by:demo.alice_actor_id,prompt:'Finish only the approved remaining work.'})
  assert.equal(report.no_approval_resume.status,409)
  report.controller_after_suspend = await controller()
  if(missingCheckpoint) {
    assert.equal(report.controller_after_suspend.ok,false)
    assert.match(report.controller_after_suspend.detail,/no stopped-source checkpoint proof/)
  }
  report.after_controller = stableState(await snapshot())
  const proposalBody={actor_id:demo.alice_actor_id,expected_budget_tokens:6000,expected_budget_cost_microusd:10000000,
    proposed_budget_tokens:overrun?10000:20000,proposed_budget_cost_microusd:10000000,rationale:'Synthetic test: preserve spent usage; authorize bounded continuation.',
    idempotency_key:randomUUID(),finish_scope:{task_id:task.id,objective:'Finish only the remaining synthetic fixture.',
      expected_output:'Verified resumed.txt from the same provider session.',acceptance_tests:['resumed.txt exists'],
      write_scope:['**'],budget_tokens:4000,budget_cost_microusd:1000000,verification_policy:task.verification_policy}}
  report.member_proposal=await request(`${prefix}/missions/${mission.id}/budget-revisions`,{
    ...proposalBody,actor_id:demo.bob_actor_id,idempotency_key:randomUUID()})
  assert.equal(report.member_proposal.status,403)
  report.proposal=await request(`${prefix}/missions/${mission.id}/budget-revisions`,proposalBody)
  if (report.proposal.status===200) {
    const rev=report.proposal.body.revision
    const replay=await ok(`${prefix}/missions/${mission.id}/budget-revisions`,proposalBody)
    assert.equal(replay.revision.id,rev.id); assert.equal(replay.replayed,true)
    report.proposal_replay_verified=true
    const decisionBody={actor_id:demo.alice_actor_id,expected_version:rev.version,approved:true,
      note:'Synthetic owner approves the bounded finish; no real model or publication authority.',decision_key:randomUUID()}
    report.member_decision=await request(`${prefix}/missions/${mission.id}/budget-revisions/${rev.id}/decision`,{
      ...decisionBody,actor_id:demo.bob_actor_id,decision_key:randomUUID()})
    assert.equal(report.member_decision.status,403)
    report.stale_decision=await request(`${prefix}/missions/${mission.id}/budget-revisions/${rev.id}/decision`,{
      ...decisionBody,expected_version:rev.version+1,decision_key:randomUUID()})
    assert.equal(report.stale_decision.status,400)
    assert.match(JSON.stringify(report.stale_decision.body),/version/)
    assert.equal((await snapshot()).snapshot.mission_budget_revisions.find(x=>x.id===rev.id).status,'pending')
    report.approval=await request(`${prefix}/missions/${mission.id}/budget-revisions/${rev.id}/decision`,decisionBody)
    if(report.approval.status===200) {
      const replayDecision=await ok(`${prefix}/missions/${mission.id}/budget-revisions/${rev.id}/decision`,decisionBody)
      assert.equal(replayDecision.replayed,true);report.decision_replay_verified=true
      const resumePrompt=overrun?'[budget-stream] Synthetic overrun of the revised finish budget.':'[budget-recovery-finish] Complete the bounded synthetic finish now.'
      report.resume=await request(`${prefix}/runs/${r.id}/resume`,{requested_by:demo.alice_actor_id,prompt:resumePrompt})
      if(report.resume.status===200) {
        const newId=report.resume.body.run_id
        report.duplicate_resume=await request(`${prefix}/runs/${r.id}/resume`,{requested_by:demo.alice_actor_id,prompt:resumePrompt})
        assert.equal(report.duplicate_resume.status,409)
        await until('resumed synthetic run ready for review or terminal',async()=>{
          const s=await snapshot(); const n=s.snapshot.runs.find(n=>n.id===newId)
          return n && ['waiting_for_approval','completed','failed','cancelled','lost'].includes(n.status)
        })
        const reviewState=await snapshot()
        if(!overrun) {
          const s=reviewState.snapshot
          const n=s.runs.find(n=>n.id===newId)
          assert.equal(n?.status,'waiting_for_approval','Recovery must observe the pending review, not direct completion')
          assert.equal(n.verification_status,'waiting_for_approval')
          const pendingTask=s.tasks.find(t=>t.id===n.task_id)
          assert.equal(pendingTask?.id,task.id)
          assert.equal(pendingTask.status,'awaiting_approval')
          assert.deepEqual(pendingTask.verification_policy,task.verification_policy)
          const gate=s.verification_requests.find(g=>g.run_id===newId)
          assert.ok(gate,'Recovery requires a persisted pending review')
          assert.equal(gate.corp_id,demo.corp_id)
          assert.equal(gate.task_id,task.id)
          assert.equal(gate.gate_type,'independent_review')
          assert.deepEqual(gate.gate,task.verification_policy.manual_gate)
          assert.equal(gate.gate.type,'independent_review')
          assert.equal(gate.gate.exclude_requester,true)
          assert.equal(gate.status,'pending')
          assert.equal(gate.decided_by,null)
          assert.equal(gate.decided_at,null)
          assert.equal(mission.requested_by,demo.alice_actor_id)
          const reviewer=s.actors.find(a=>a.id===demo.bob_actor_id)
          assert.equal(reviewer?.corp_id,demo.corp_id)
          assert.equal(reviewer.kind,'human')
          assert.ok(gate.gate.roles.includes(reviewer.role))
          assert.notEqual(reviewer.id,mission.requested_by)
          const producer=s.agents.find(a=>a.id===n.agent_id)
          assert.ok(producer)
          assert.notEqual(reviewer.id,producer.actor_id)
          report.pending_review=gate
          report.self_review=await request(`${prefix}/runs/${newId}/verification-decision`,{
            actor_id:demo.alice_actor_id,approved:true,note:'Negative synthetic check: requester must not self-review.'})
          assert.equal(report.self_review.status,403)
          const denied=await snapshot()
          assert.equal(denied.snapshot.runs.find(n=>n.id===newId)?.status,'waiting_for_approval')
          assert.deepEqual(denied.snapshot.verification_requests.find(g=>g.run_id===newId),gate,
            'Rejected requester decision must leave the pending review unchanged')
          report.independent_review=await request(`${prefix}/runs/${newId}/verification-decision`,{actor_id:demo.bob_actor_id,approved:true,
            note:'Synthetic independent reviewer confirms resumed.txt and verifier evidence; no publication.'})
          assert.equal(report.independent_review.status,200)
          assert.equal(report.independent_review.body.run_id,newId)
          assert.equal(report.independent_review.body.status,'approved')
          report.independent_review_verified=true
        }
        const resumed=await until('resumed synthetic run terminal',async()=>{
          const s=await snapshot();const n=s.snapshot.runs.find(n=>n.id===newId)
          return n && ['completed','failed','cancelled','lost'].includes(n.status) && n.workspace_disposition==='preserved'?{s,n}:null
        })
        assert.equal(resumed.n.provider_session_id,r.provider_session_id)
        assert.equal(resumed.n.workspace_run_id,r.workspace_run_id)
        assert.equal(resumed.n.resumed_from_run_id,r.id)
        report.same_session_and_workspace=true
        report.resume_run={id:newId,status:resumed.n.status,breaker_stage:resumed.n.breaker_stage,
          budget_tokens_limit:resumed.n.budget_tokens_limit,input_tokens:resumed.n.input_tokens,output_tokens:resumed.n.output_tokens}
        if(overrun) {
          assert.equal(resumed.n.breaker_stage,'stop')
          assert.notEqual(resumed.n.status,'completed')
          const count=resumed.s.snapshot.runs.length
          report.stopped_ancestor_resume=await request(`${prefix}/runs/${r.id}/resume`,{
            requested_by:demo.alice_actor_id,prompt:'[budget-recovery-finish] Attempt to bypass a stopped descendant.'})
          assert.equal(report.stopped_ancestor_resume.status,409)
          assert.match(JSON.stringify(report.stopped_ancestor_resume.body),/stop-stage/)
          assert.equal((await snapshot()).snapshot.runs.length,count)
          report.hard_stop_protected=true
        }
        report.controller_after_resume=await controller()
      }
    }
  }
  const final=await snapshot()
  report.final=stableState(final)
  const original=final.snapshot.runs.find(x=>x.id===r.id)
  assert.equal(original.input_tokens+original.output_tokens,6000)
  assert.equal(original.breaker_stage,'suspend')
  assert.deepEqual(original,r,'Original suspended run, including missing fingerprint and spend, must remain unchanged')
  const originalEvents=initial.data.snapshot.events.filter(e=>e.aggregate_id===r.id)
  assert.ok(originalEvents.length,'Original run history must be present')
  for(const event of originalEvents) {
    assert.deepEqual(final.snapshot.events.find(e=>e.id===event.id),event,'Original suspension history must remain unchanged')
  }
  const incidents=initial.data.snapshot.circuit_breaker_incidents.filter(i=>i.run_id===r.id)
  assert.ok(incidents.some(i=>i.stage==='suspend'),'Original suspension incident must be present')
  assert.deepEqual(final.snapshot.circuit_breaker_incidents.filter(i=>i.run_id===r.id),incidents)
  report.original_spend_and_breaker_preserved=true
  if(report.resume_run) {
    const s=final.snapshot
    const n=s.runs.find(n=>n.id===report.resume_run.id)
    assert.ok(n)
    assert.equal(n.id,report.resume.body.run_id)
    assert.equal(n.corp_id,r.corp_id)
    assert.equal(n.task_id,task.id)
    assert.equal(n.provider_session_id,r.provider_session_id)
    assert.equal(n.workspace_run_id,r.workspace_run_id)
    assert.equal(n.resumed_from_run_id,r.id)
    const finishedTask=s.tasks.find(t=>t.id===task.id)
    assert.ok(finishedTask)
    assert.equal(finishedTask.corp_id,task.corp_id)
    assert.equal(finishedTask.mission_id,mission.id)
    for(const field of ['source_repository','source_base_ref','source_base_commit']) {
      assert.ok(r[field],`Suspended source tuple omitted ${field}`)
      assert.equal(task.contract[field],r[field])
      assert.equal(n[field],r[field])
      assert.equal(finishedTask.contract[field],r[field])
    }
    assert.equal(n.workspace_connection_id,r.workspace_connection_id)
    assert.deepEqual(finishedTask.verification_policy,task.verification_policy)
    const revision=s.mission_budget_revisions.find(v=>v.id===report.proposal.body.revision.id)
    assert.ok(revision,'Approved finish-budget revision must be persisted')
    assert.equal(revision.corp_id,mission.corp_id)
    assert.equal(revision.mission_id,mission.id)
    assert.equal(revision.status,'approved')
    assert.equal(revision.decided_by,demo.alice_actor_id)
    assert.equal(revision.replacement_task_id,task.id)
    assert.deepEqual(revision.previous_contract,task.contract)
    assert.deepEqual(revision.previous_verification_policy,task.verification_policy)
    assert.deepEqual(revision.replacement_verification_policy,task.verification_policy)
    const {task_id,verification_policy,...finishContract}=proposalBody.finish_scope
    assert.deepEqual(revision.replacement_contract,{...task.contract,...finishContract})
    assert.deepEqual(finishedTask.contract,revision.replacement_contract)
    assert.equal(n.budget_tokens_limit,finishContract.budget_tokens)
    assert.equal(n.budget_cost_microusd_limit,finishContract.budget_cost_microusd)
    assert.equal(revision.consumed_tokens_at_proposal,r.input_tokens+r.output_tokens)
    assert.equal(revision.consumed_cost_microusd_at_proposal,r.cost_microusd)
    const finishedMission=s.missions.find(m=>m.id===mission.id)
    assert.ok(finishedMission)
    for(const field of ['budget_tokens','budget_cost_microusd']) {
      assert.equal(revision[`current_${field}`],mission[field])
      assert.equal(revision[`proposed_${field}`],proposalBody[`proposed_${field}`])
      assert.equal(finishedMission[field],proposalBody[`proposed_${field}`])
      assert.equal(finishedMission[`original_${field}`],mission[`original_${field}`])
    }
    if(overrun) {
      assert.equal(n.breaker_stage,'stop')
      assert.notEqual(n.status,'completed')
    } else {
      assert.equal(n.status,'completed')
      assert.equal(n.verification_status,'passed')
      assert.equal(finishedTask.status,'completed')
      assert.equal(finishedTask.verification_status,'passed')
      assert.equal(report.pending_review?.status,'pending')
      assert.equal(report.self_review?.status,403)
      assert.equal(report.independent_review?.status,200)
      assert.equal(report.independent_review.body.run_id,n.id)
      assert.equal(report.independent_review.body.status,'approved')
      assert.equal(report.independent_review_verified,true)
      const decision=s.verification_requests.find(g=>g.run_id===n.id)
      assert.ok(decision,'Completed recovery requires a persisted independent decision')
      for(const field of ['run_id','corp_id','task_id','gate_type','gate','requested_at']) {
        assert.deepEqual(decision[field],report.pending_review[field])
      }
      assert.equal(decision.status,'approved')
      assert.equal(decision.decided_by,demo.bob_actor_id)
      assert.notEqual(decision.decided_by,mission.requested_by)
      assert.ok(decision.decided_at)
      const evidence=s.verification_evidence.filter(e=>e.run_id===n.id).sort((a,b)=>a.check_index-b.check_index)
      assert.equal(evidence.length,task.verification_policy.checks.length)
      task.verification_policy.checks.forEach((check,index)=>{
        assert.equal(evidence[index].corp_id,n.corp_id)
        assert.equal(evidence[index].task_id,task.id)
        assert.equal(evidence[index].check_index,index)
        assert.equal(evidence[index].kind,check.type)
        assert.equal(evidence[index].status,'passed')
      })
      assert.ok(n.artifact_id,'Artifact check requires persisted artifact linkage')
      report.recovery_proof_verified=true
    }
  }
  report.status=report.resume_run?.status==='completed' && report.final.missions.find(m=>m.id===mission.id)?.status==='completed'
    && report.final.factory_items[0]?.state==='verified' && report.independent_review_verified===true
    && report.recovery_proof_verified===true ? 'recovery_passed' : 'recovery_not_complete'
  if(overrun && report.hard_stop_protected)report.status='hard_stop_protected'
  if(report.status==='recovery_not_complete')process.exitCode=1
  await json(path.join(attempt,'qa-state.json'),{...report.final,revisions:final.snapshot.mission_budget_revisions,
    runs:final.snapshot.runs.map(({provider_session_id,workspace_run_id,resumed_from_run_id,...r})=>({...r,provider_session_id,workspace_run_id,resumed_from_run_id}))})
} catch(error) {
  report.status='fixture_error'
  report.error=error.message
  process.exitCode=1
} finally {
  if (attemptAdmitted) {
    try { await assertUnlinkedDirectory(attempt) }
    catch (error) {
      attemptAdmitted = false
      report.status = 'fixture_error'
      report.path_error = error.message
      report.cleanup.push({name:'qa-attempt-path',status:'unverified_preserved',error:error.message})
      process.exitCode = 1
    }
  }
  // Refusal must not release locks, probe processes, or report through an unowned path.
  if (attemptAdmitted) {
  // Release the owned fault injector normally even after a failed assertion so
  // its finally block can remove the marker before any provider resume/reuse.
  if (lockProcess) {
    try {
      if ((await identity(lockProcess.pid))!==null) {
        await writeFile(releaseSignal,'release synthetic QA file handle\n')
        await until('fault injector cleanup',async()=>(await identity(lockProcess.pid))===null,10000)
      }
      assert.equal(await exists(path.join(lockedWorkspace,'.qa-checkpoint-lock-ready')),false,'Lock marker cleanup must be verified')
    } catch (error) {
      report.cleanup.push({name:'qa-read-lock-marker',status:'unverified_preserved',error:error.message})
      process.exitCode=1
    }
  }
  for (const owned of [...children].reverse()) {
    try {
      const current=await identity(owned.child.pid)
      if(current===null) {report.cleanup.push({name:owned.name,status:'already_exited'});continue}
      assert.deepEqual(current,owned.receipt,'Process identity changed; preserve unknown process')
      if(owned.name==='postgres') {
        await run(path.join(pgBin,'pg_ctl.exe'),['-D',pgData,'stop','-m','fast','-w','-t','30'])
      } else await stopVerifiedChild(owned)
      await until(`${owned.name} stopped`,async()=> (await identity(owned.child.pid))===null,30000)
      report.cleanup.push({name:owned.name,status:'stopped_verified_qa_process',pid:owned.child.pid})
    }catch(error){report.cleanup.push({name:owned.name,status:'unverified_preserved',error:error.message});process.exitCode=1}
  }
  report.ports_after=await ports()
  report.retained_after=await readReference()
  report.retained_unchanged=referenceUrl ? JSON.stringify(report.retained_before)===JSON.stringify(report.retained_after) : null
  if(report.retained_unchanged===false || report.ports_after.length)process.exitCode=1
  try { await finishSourceBinding(report, root, provenancePrograms) }
  catch {
    report.status='fixture_error'
    report.provenance_error='Source/executable binding changed or could not be verified; preserve receipts'
    process.exitCode=1
  }
  report.finished_at=new Date().toISOString()
  await json(path.join(attempt,'report.json'),report)
  }
  console.log(JSON.stringify({status:report.status,error:report.error,path_error:report.path_error,
    report:attemptAdmitted?path.join(attempt,'report.json'):null,
    resume:report.resume,cleanup:report.cleanup,retained_unchanged:report.retained_unchanged,ports_after:report.ports_after},null,2))
}
