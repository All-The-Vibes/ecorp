import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, mkdir, writeFile, access, realpath, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { factoryBudgetProcessIdentity, stopFactoryBudgetProcess } from './factory_budget_process.mjs'

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
      '-QaRoot',qa,'-Workspace',workspace,'-ReleaseSignal',release],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']})
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
  const options = { workspace }
  // Inert bounded child, not an existing process. Retain the tiny diagnostic root.
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},45000)'], { cwd: workspace, windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const exited = new Promise(resolve => child.once('exit', resolve))
  let receipt
  try {
    receipt = await factoryBudgetProcessIdentity(child.pid, options)
    assert.equal(receipt.pid, child.pid)
    assert.equal(path.resolve(receipt.executable).toLowerCase(), path.resolve(process.execPath).toLowerCase())
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
