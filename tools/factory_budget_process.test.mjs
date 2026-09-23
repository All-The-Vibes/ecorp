import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { mkdtemp, readFile, mkdir, writeFile, access, realpath, symlink, lstat, readdir, rmdir, unlink, open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { factoryBudgetProcessIdentity, stopFactoryBudgetProcess } from './factory_budget_process.mjs'
import { checkContainedFile } from './e2e_stopped_source_checkpoint.mjs'
import { readTrustedExecutableDigest } from './e2e_checkpoint_verification.mjs'

const execFile = promisify(execFileCallback)
const trustedNode = realpathSync(process.execPath)
const inertEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'pathext', 'temp', 'tmp'].includes(key.toLowerCase())))

test('shared native identity distinguishes inspection uncertainty from absence', {
  skip: process.platform !== 'win32', timeout: 75000,
}, async () => {
  const args = ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./local_stack_identity.test.ps1', import.meta.url))]
  if (process.env.ECORP_PROCESS_TEST_EVIDENCE_ROOT) args.push('-EvidenceRoot', process.env.ECORP_PROCESS_TEST_EVIDENCE_ROOT)
  const { stdout } = await execFile('pwsh.exe', args, { windowsHide: true, timeout: 70000, env: inertEnvironment })
  const report = JSON.parse(stdout.split('ECORP_IDENTITY_TEST_RESULT=')[1])
  assert.equal(report.cleanup_verified, true)
  assert.ok(report.cases.length >= 37)
  assert.deepEqual(report.cases.filter(c => !c.passed), [])
})

test('recovery cleanup preserves live uncertain or mismatched children and receipts; only proven absence succeeds', {
  skip: process.platform !== 'win32', timeout: 75000,
}, async () => {
  // Execute only the existing cleanup block, never the Factory/DB/runtime driver.
  const code = await readFile(new URL('./e2e_factory_budget_recovery.mjs', import.meta.url), 'utf8')
  const first = code.indexOf('  // Release the owned fault injector normally')
  const last = code.indexOf('  report.ports_after=await ports()', first)
  assert.ok(first >= 0 && last > first, 'Review cleanup extraction when the driver changes')
  const cleanup = new Function('context', `return (async () => {
    const {assert,path,children,identity,lockProcess,lockedWorkspace,releaseSignal,writeFile,exists,
      until,stopVerifiedChild,report,process,run,pgBin,pgData}=context;
    ${code.slice(first, last)}
  })()`)
  const workspace = await mkdtemp(path.join(process.env.ECORP_PROCESS_TEST_EVIDENCE_ROOT ?? os.tmpdir(), 'ecorp-cleanup-'))
  const options = { workspace, environment: inertEnvironment }
  const child = spawn(trustedNode, ['-e', 'setTimeout(()=>{},60000)'],
    { cwd: workspace, env: inertEnvironment, windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const exited = new Promise(resolve => child.once('exit', resolve))
  let receipt
  const outcomes = []
  try {
    receipt = await factoryBudgetProcessIdentity(child.pid, options)
    const receiptPath = path.join(workspace, 'ownership.json')
    const receiptBytes = JSON.stringify(receipt)
    await writeFile(receiptPath, receiptBytes)
    const marker = path.join(workspace, '.qa-checkpoint-lock-ready')
    await writeFile(marker, 'retained synthetic marker')
    const context = {
      assert, path, children: [{ name: 'inert-runner', child, receipt }], lockProcess: child,
      lockedWorkspace: workspace, releaseSignal: path.join(workspace, 'release'), writeFile,
      exists: file => access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }),
      until: async (_label, check) => assert.equal(await check(), true),
      stopVerifiedChild: () => assert.fail('No termination is authorized in these cleanup probes'),
      run: () => assert.fail('No runtime driver command is authorized'),
    }
    // Inject a native lookup error in the real module, not a null/error adapter stub.
    const uncertainIdentity = async processId => {
      const { stdout } = await execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; Import-Module $env:TEST_MODULE -Force; " +
        "& (Get-Module local_stack) { function script:Get-Process { throw [ComponentModel.Win32Exception]::new(5) } }; " +
        'ConvertTo-Json -InputObject (Get-LocalProcessIdentity -ProcessId ([int]$env:TEST_PID)) -Compress'],
      { cwd: workspace, env: { ...inertEnvironment, TEST_PID: String(processId),
        TEST_MODULE: fileURLToPath(new URL('./local_stack.psm1', import.meta.url)) }, windowsHide: true, timeout: 10000 })
      return JSON.parse(stdout)
    }
    const uncertain = { ...context, identity: uncertainIdentity, report: { cleanup: [] }, process: { exitCode: 0 } }
    await cleanup(uncertain)
    assert.equal(uncertain.process.exitCode, 1)
    assert.deepEqual(uncertain.report.cleanup.map(x => x.status), ['unverified_preserved', 'unverified_preserved'])
    outcomes.push({ probe: 'uncertain', ...uncertain.report, exitCode: uncertain.process.exitCode })
    await assert.rejects(access(context.releaseSignal), { code: 'ENOENT' })
    assert.equal(await readFile(marker, 'utf8'), 'retained synthetic marker')
    assert.equal(await readFile(receiptPath, 'utf8'), receiptBytes)
    assert.deepEqual(await factoryBudgetProcessIdentity(child.pid, options), receipt)

    let releaseInspections = 0
    const releaseUncertain = { ...context, children: [], report: { cleanup: [] }, process: { exitCode: 0 },
      identity: pid => ++releaseInspections === 1 ? factoryBudgetProcessIdentity(pid, options) : uncertainIdentity(pid) }
    await cleanup(releaseUncertain)
    assert.equal(releaseUncertain.process.exitCode, 1)
    assert.equal(releaseUncertain.report.cleanup[0].status, 'unverified_preserved')
    assert.match(releaseUncertain.report.cleanup[0].error, /Win32Exception/)
    outcomes.push({ probe: 'release_poll_uncertain', ...releaseUncertain.report, exitCode: releaseUncertain.process.exitCode })
    assert.deepEqual(await factoryBudgetProcessIdentity(child.pid, options), receipt)

    const mismatch = { ...context, lockProcess: null, identity: pid => factoryBudgetProcessIdentity(pid, options),
      children: [{ name: 'inert-runner', child, receipt: { ...receipt, started_utc: '2000-01-01T00:00:00.0000000Z' } }],
      report: { cleanup: [] }, process: { exitCode: 0 } }
    await cleanup(mismatch)
    assert.equal(mismatch.process.exitCode, 1)
    assert.equal(mismatch.report.cleanup[0].status, 'unverified_preserved')
    outcomes.push({ probe: 'mismatch', ...mismatch.report, exitCode: mismatch.process.exitCode })
    assert.deepEqual(await factoryBudgetProcessIdentity(child.pid, options), receipt)
    assert.equal(await readFile(receiptPath, 'utf8'), receiptBytes)

    let stopInspections = 0
    const stopUncertain = { ...context, lockProcess: null, report: { cleanup: [] }, process: { exitCode: 0 },
      stopVerifiedChild: owned => stopFactoryBudgetProcess(owned.receipt, options),
      identity: pid => ++stopInspections === 1 ? factoryBudgetProcessIdentity(pid, options) : uncertainIdentity(pid) }
    await cleanup(stopUncertain)
    assert.equal(stopUncertain.process.exitCode, 1)
    assert.equal(stopUncertain.report.cleanup[0].status, 'unverified_preserved')
    assert.match(stopUncertain.report.cleanup[0].error, /Win32Exception/)
    outcomes.push({ probe: 'stop_poll_uncertain', ...stopUncertain.report, exitCode: stopUncertain.process.exitCode })
    await exited
    assert.equal(await readFile(receiptPath, 'utf8'), receiptBytes)
    const absent = { ...context, lockProcess: null, identity: pid => factoryBudgetProcessIdentity(pid, options),
      report: { cleanup: [] }, process: { exitCode: 0 } }
    await cleanup(absent)
    assert.equal(absent.process.exitCode, 0)
    assert.equal(absent.report.cleanup[0].status, 'already_exited')
    outcomes.push({ probe: 'confirmed_absence', ...absent.report, exitCode: absent.process.exitCode })
  } finally {
    if (receipt && child.exitCode === null) await stopFactoryBudgetProcess(receipt, options)
    await exited
    await writeFile(path.join(workspace, 'report.json'), JSON.stringify({ receipt, outcomes, cleanup_verified: child.exitCode !== null }, null, 2))
  }
})

test('budget process adapter delegates exact identity and stop to the existing native helper', async () => {
  const adapter = await readFile(new URL('./factory_budget_process.mjs', import.meta.url), 'utf8')
  assert.match(adapter, /Get-LocalProcessIdentity/)
  assert.match(adapter, /Stop-LocalOwnedProcess/)
  assert.doesNotMatch(adapter, /Get-CimInstance|\$pid\s*=|\.kill\(|\.Kill\(/i)
  const driver = await readFile(new URL('./e2e_factory_budget_recovery.mjs', import.meta.url), 'utf8')
  assert.match(driver, /factoryBudgetProcessIdentity/)
  assert.match(driver, /stopFactoryBudgetProcess/)
  assert.doesNotMatch(driver, /Get-CimInstance|\$pid\s*=/i)
})

test('actual lock helper cleans its handshake on release and preserves a pre-existing marker on failure', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'ecorp-budget-lock-'))
  const qa = path.join(root,'qa','issue-50-factory-recovery')
  const attempt = path.join(qa,'attempts','test')
  const workspace = path.join(attempt,'runner-workspaces','worktrees','task','run')
  await mkdir(workspace,{recursive:true})
  const file = path.join(workspace,'README.md'), marker = path.join(workspace,'.qa-checkpoint-lock-ready')
  const release = path.join(attempt,'release')
  await writeFile(file,'unchanged synthetic bytes\n')
  const start = () => {
    const child=spawn('pwsh.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./qa_hold_checkpoint_file.ps1',import.meta.url)),
      '-QaRoot',qa,'-Workspace',workspace,'-ReleaseSignal',release],{cwd:root,env:inertEnvironment,windowsHide:true,stdio:['ignore','ignore','pipe']})
    let stderr=''
    child.stderr.on('data',chunk=>{stderr+=chunk;assert.ok(stderr.length<8192)})
    return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,stderr}))})
  }
  const done=start()
  let result
  done.then(value=>{result=value})
  try {
    const deadline=Date.now()+10000
    while (!(await access(marker).then(()=>true,()=>false))) {
      assert.ok(!result, result?.stderr)
      assert.ok(Date.now()<deadline,'Owned lock handshake deadline')
      await new Promise(resolve=>setTimeout(resolve,50))
    }
  } finally { await writeFile(release,'release') }
  const finished=await done
  assert.equal(finished.code,0,finished.stderr)
  await assert.rejects(access(marker),{code:'ENOENT'})
  assert.equal(await readFile(file,'utf8'),'unchanged synthetic bytes\n')
  await writeFile(marker,'pre-existing unknown file')
  assert.notEqual((await start()).code,0)
  assert.equal(await readFile(marker,'utf8'),'pre-existing unknown file')
  assert.equal(await readFile(file,'utf8'),'unchanged synthetic bytes\n')
})

test('actual Windows budget-fixture child stop preserves mismatches and terminates only the verified receipt', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ecorp-budget-process-'))
  const options = { workspace, environment: inertEnvironment }
  // Inert bounded child, not an existing process. Retain the tiny diagnostic root.
  const child = spawn(trustedNode, ['-e', 'setTimeout(()=>{},45000)'], { cwd: workspace, env: inertEnvironment, windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const exited = new Promise(resolve => child.once('exit', resolve))
  let receipt
  try {
    receipt = await factoryBudgetProcessIdentity(child.pid, options)
    assert.equal(receipt.pid, child.pid)
    assert.equal(path.resolve(receipt.executable).toLowerCase(), path.resolve(trustedNode).toLowerCase())
    assert.match(receipt.started_utc, /\.\d{7}(?:Z|\+00:00)$/)
    assert.deepEqual(await factoryBudgetProcessIdentity(child.pid, options), receipt)
    for (const invalid of [
      { ...receipt, executable: path.join(workspace, 'different.exe') },
      { ...receipt, started_utc: '2000-01-01T00:00:00.0000000Z' },
      { ...receipt, workspace: path.join(workspace, 'different') },
    ]) {
      await assert.rejects(stopFactoryBudgetProcess(invalid, options), /ownership changed|unverifiable/)
      assert.deepEqual(await factoryBudgetProcessIdentity(child.pid, options), receipt)
    }
    await stopFactoryBudgetProcess(receipt, options)
    await exited
    assert.equal(await factoryBudgetProcessIdentity(child.pid, options), null)
  } finally {
    if (receipt && child.exitCode === null) await stopFactoryBudgetProcess(receipt, options)
  }
})

test('actual budget source-admission block rejects redirected or non-synthetic retained sources', async () => {
  const code=await readFile(new URL('./e2e_factory_budget_recovery.mjs',import.meta.url),'utf8')
  const first=code.indexOf('  assert.equal((await realpath(source))')
  const last=code.indexOf('  const pgChild',first)
  assert.ok(first>=0 && last>first,'Review source-admission extraction when the driver changes')
  const validate=new Function('context',`return (async () => { const {assert,path,realpath,readFile,source,qa,sourceReadme,run,report}=context; ${code.slice(first,last)} })()`)
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'ecorp-budget-source-'))
  const qa=path.join(root,'qa'),source=path.join(qa,'source'),foreign=path.join(root,'foreign')
  await mkdir(source,{recursive:true});await mkdir(foreign)
  const sourceReadme='# Synthetic issue 50 source\nNo real application or credentials.\n'
  await writeFile(path.join(source,'README.md'),sourceReadme)
  const outputs={'remote get-url origin':'https://github.com/All-The-Vibes/ecorp.git','ls-files':'README.md','status --porcelain':'','rev-parse HEAD':'a'.repeat(40)}
  const make=(changes={})=>({assert,path,realpath,readFile,source,qa,sourceReadme,report:{},run:async(program,args)=>{
    assert.equal(program,'git');assert.deepEqual(args.slice(0,2),['-C',source])
    return {stdout:({...outputs,...changes})[args.slice(2).join(' ')]}
  }})
  await validate(make())
  for(const invalid of [{'remote get-url origin':'https://github.com/other/repo.git'},{'ls-files':'README.md\nforeign.txt'},{'status --porcelain':'?? foreign.txt'}]) {
    await assert.rejects(validate(make(invalid)))
  }
  await writeFile(path.join(source,'README.md'),'unrelated retained repository')
  await assert.rejects(validate(make()),/remain synthetic/)
  const alias=path.join(qa,'alias')
  await symlink(foreign,alias,process.platform==='win32'?'junction':'dir')
  let called=false
  await assert.rejects(validate({...make(),source:alias,run:async()=>{called=true;throw Error('must not reach Git')}}),/must not redirect/)
  assert.equal(called,false)
})

test('actual budget attempt admission refuses linked and unknown paths before effects, including finally', async t => {
  // Controlled extraction of actual admission + catch/finally; never execute the driver.
  const code=(await readFile(new URL('./e2e_factory_budget_recovery.mjs',import.meta.url),'utf8')).replace(/\r\n/g,'\n')
  const helperStart=code.indexOf('async function exists(file)')
  const helperEnd=code.indexOf('async function ports()',helperStart)
  const bindingStart=code.indexOf('// Actual tested-input binding.')
  const bindingEnd=code.indexOf('async function readReference()',bindingStart)
  const first=code.indexOf('let demo\n'), last=code.indexOf('  // Stop dotenv discovery',first)
  const tail=code.indexOf("} catch(error) {\n  report.status='fixture_error'",last)
  assert.ok(helperStart>=0 && helperEnd>helperStart && bindingStart>=0 && bindingEnd>bindingStart &&
    first>=0 && last>first && tail>last,
    'Review attempt-admission extraction when the driver changes')
  const validate=new Function('context',`return (async () => {
    const {assert,path,access,lstat,realpath,readFile,mkdir,writeFile,qa,attempt,root,suite,
      report,process,children,ports,readReference,referenceUrl,console,lifecycle,
      createHash,constants,open,checkContainedFile,readTrustedExecutableDigest,run,provenancePrograms}=context;
    const json=(file,value)=>writeFile(file,JSON.stringify(value));
    ${code.slice(helperStart,helperEnd)}
    ${code.slice(bindingStart,bindingEnd)}
    ${code.slice(first,last)}
      await lifecycle();
    ${code.slice(tail)}
  })()`)
  const evidence=process.env.ECORP_PATH_TEST_EVIDENCE_ROOT
  const outcomes=[]
  const snapshot=async directory=>{
    const entries=[]
    for(const name of (await readdir(directory)).sort()) {
      const file=path.join(directory,name), info=await lstat(file)
      assert.equal(info.isSymbolicLink(),false,'Outside fixture must not contain links')
      entries.push([name,info.isDirectory()?await snapshot(file):(await readFile(file)).toString('hex')])
    }
    return entries
  }
  try {
    for(const scenario of ['attempts-junction','dangling-attempts-junction','attempt-junction',
      'unknown-attempt','invalid-owner','new-attempt-junction','finally-attempt-junction','plain']) {
      await t.test(scenario,async()=>{
        const temp=await realpath(os.tmpdir())
        const root=await mkdtemp(path.join(temp,'ecorp-attempt-owned-'))
        const outside=await mkdtemp(path.join(temp,'ecorp-attempt-outside-'))
        const qa=path.join(root,'qa','issue-50-factory-recovery'), attempts=path.join(qa,'attempts')
        const attempt=path.join(attempts,'test'), suite='issue-50-factory-budget-recovery-v1'
        const head='a'.repeat(40), input='inert source input\n'
        await writeFile(path.join(root,'input.mjs'),input)
        const executable=path.join(root,'inert.exe')
        await writeFile(executable,'inert executable bytes; never execute\n')
        const bindingCalls=[]
        // Only Git's inventory is synthetic; actual source/executable readers and hashes run.
        const run=async(program,args,options)=>{
          assert.equal(program,'git')
          assert.equal(options.cwd,root)
          assert.deepEqual(args.slice(0,2),['-c','core.fsmonitor=false'])
          bindingCalls.push(args.slice(2))
          if(args[2]==='rev-parse') {
            assert.deepEqual(args.slice(2),['rev-parse','HEAD'])
            return {stdout:head}
          }
          assert.equal(args[2],'ls-files')
          assert.ok(['--cached','--others'].includes(args[3]))
          return {stdout:args[3]==='--cached'?'input.mjs\0':''}
        }
        const links=[]
        const link=async(target,file)=>{
          await symlink(target,file,process.platform==='win32'?'junction':'dir')
          links.push(file)
        }
        await mkdir(qa,{recursive:true})
        await writeFile(path.join(qa,'ownership.json'),JSON.stringify({
          suite:scenario==='invalid-owner'?'unknown':suite,qa_root:qa,source_worktree:root,
        }))
        await writeFile(path.join(outside,'sentinel.txt'),'outside must remain unchanged\n')
        if(scenario==='attempts-junction') {
          await mkdir(path.join(outside,'test'))
          await link(outside,attempts)
          assert.equal(await realpath(attempts),outside)
        }
        else if(scenario==='dangling-attempts-junction')await link(path.join(outside,'missing'),attempts)
        else if(scenario==='attempt-junction') {await mkdir(attempts);await link(outside,attempt)}
        else if(['unknown-attempt','invalid-owner'].includes(scenario)) {
          await mkdir(attempt,{recursive:true})
          await writeFile(path.join(attempt,'sentinel.txt'),'unknown attempt must be preserved\n')
        }
        const before=await snapshot(outside), calls=[], report={cleanup:[],source_code_commit:head}, fakeProcess={exitCode:0}
        const result={scenario,root,outside,links,before,cleanup:'pending'}
        outcomes.push(result)
        try {
          await validate({assert,path,access,lstat,realpath,readFile,writeFile,qa,attempt,root,suite,report,
            createHash,constants,open,checkContainedFile,readTrustedExecutableDigest,run,
            provenancePrograms:{fixture:executable},
            process:fakeProcess,children:[],referenceUrl:null,console:{log(){}},
            ports:async()=>{calls.push('ports');return []},
            readReference:async()=>{calls.push('reference');return null},
            mkdir:async(file,options)=>{
              await mkdir(file,options)
              if(scenario==='new-attempt-junction' && file===attempt) {
                await rmdir(attempt);await link(outside,attempt)
              }
            },
            lifecycle:async()=>{
              calls.push('lifecycle')
              if(scenario==='finally-attempt-junction') {
                // Admission now persists provenance. Remove only that known receipt before the swap.
                assert.deepEqual(JSON.parse(await readFile(path.join(attempt,'provenance-before.json'),'utf8')),
                  report.provenance)
                await unlink(path.join(attempt,'provenance-before.json'))
                await rmdir(attempt);await link(outside,attempt)
              }
            },
          })
          result.after=await snapshot(outside)
          result.calls=calls
          result.report=report
          result.exitCode=fakeProcess.exitCode
          assert.deepEqual(result.after,before,'No mkdir or report write may escape into the owned outside directory')
          assert.doesNotMatch(report.error ?? '',/ReferenceError|is not defined/)
          assert.equal(report.provenance.before.source.files[0].sha256,
            createHash('sha256').update(input).digest('hex'))
          assert.equal(bindingCalls.length,scenario==='plain'?8:4,
            'Only admitted, still-unlinked paths may run finally source probes')
          if(scenario==='plain') {
            assert.deepEqual(calls,['lifecycle','ports','reference'])
            assert.equal(fakeProcess.exitCode,0)
            assert.equal(report.provenance.consistent,true)
            assert.deepEqual(report.provenance.after,report.provenance.before)
            assert.ok(await readFile(path.join(attempt,'report.json')))
          } else {
            assert.equal(report.provenance.after,undefined)
            assert.deepEqual(calls,scenario==='finally-attempt-junction'?['lifecycle']:[],
              'Rejected paths must not reach lifecycle commands or finally probes')
            assert.equal(fakeProcess.exitCode,1)
            assert.match(report.error ?? report.path_error,/redirect|linked|EEXIST|unknown/i)
            if(['unknown-attempt','invalid-owner'].includes(scenario)) {
              assert.deepEqual(await readdir(attempt),['sentinel.txt'])
              assert.equal(await readFile(path.join(attempt,'sentinel.txt'),'utf8'),'unknown attempt must be preserved\n')
            }
          }
        } finally {
          // Unlink only exact links created by this test; retain both owned roots.
          for(const file of links) {
            assert.ok(path.relative(root,file) && !path.relative(root,file).startsWith('..'))
            assert.equal((await lstat(file)).isSymbolicLink(),true)
            await unlink(file)
            await assert.rejects(lstat(file),{code:'ENOENT'})
          }
          result.cleanup='owned links removed and verified absent; owned roots retained'
          result.outside_final=await snapshot(outside)
          t.diagnostic(JSON.stringify(result))
        }
      })
    }
  } finally {
    if(evidence)await writeFile(path.join(evidence,'path-fixtures.json'),JSON.stringify(outcomes,null,2))
  }
})
