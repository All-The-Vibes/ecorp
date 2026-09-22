import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import path from 'node:path';

const execute=promisify(execFile);
const qa=process.env.ECORP_COMPLETION_QA_ROOT;
const product=process.env.ECORP_COMPLETION_PRODUCT;
assert.match(qa??'',/[\\/]qa[\\/]pr359-agent-pinning-20260922-r\d+$/);
assert.equal(process.env.ECORP_COMPLETION_PR,'359');
const state=JSON.parse(await readFile(path.join(qa,'ownership.json'),'utf8'));
assert.equal(state.purpose,'pr359-agent-pinning');
assert.equal(state.test_owned,true);
assert.equal(state.plan.server,'http://127.0.0.1:59031');
assert.equal(state.plan.web,'http://127.0.0.1:59032');
assert.equal(state.plan.runner_id,'runner-issue48-42269426');
const output=path.join(qa,'evidence');
const privateDirectory=path.join(qa,'private');
await mkdir(privateDirectory,{recursive:false});
const env={...process.env,CRONY_PIN_TEST:'1',CRONY_SERVER_HTTP:state.plan.server,CRONY_PIN_WEB:state.plan.web,
CRONY_PIN_OUTPUT:output,CRONY_PIN_PRIVATE:privateDirectory,CRONY_CLI_BINARY:path.join(product,'target/debug/crony-cli.exe'),
CRONY_PIN_SOURCE:path.join(qa,'source'),ECORP_PSQL_BINARY:process.env.ECORP_COMPLETION_PSQL,
PGHOST:'127.0.0.1',PGPORT:'59030',PGDATABASE:'issue48_app',PGUSER:'issue48'};
const receipt={status:'running',started_at:new Date().toISOString(),scope:'Actual native Edge office controls and owned development-principal server/runner/CLI fixture; deterministic provider, no external effects.',phases:[],captures:[],requests:[],browser_errors:[],blocked_requests:[]};
const receiptPath=path.join(output,'browser-driver.json');
const save=()=>writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function phase(name){
  const command=path.join(product,'tools/e2e_agent_pinning.mjs');
  let result;
  try {
    result=await execute(process.execPath,[command,'--phase',name],{cwd:product,env,windowsHide:true,timeout:240000,maxBuffer:4*1024*1024});
    await writeFile(path.join(output,name+'.stdout.log'),result.stdout);
    await writeFile(path.join(output,name+'.stderr.log'),result.stderr);
    receipt.phases.push({name,exit_code:0,stdout_sha256:sha(result.stdout),stderr_sha256:sha(result.stderr)});
  } catch(error) {
    await writeFile(path.join(output,name+'.stdout.log'),error.stdout??'');
    await writeFile(path.join(output,name+'.stderr.log'),error.stderr??'');
    receipt.phases.push({name,exit_code:error.code??'unknown'});
    await save(); throw error;
  }
  await save();
  return JSON.parse(await readFile(path.join(output,'native-agent-pinning.json'),'utf8'));
}
async function capture(page,name) {
  const file=path.join(output,name+'.png');
  await page.screenshot({path:file,fullPage:true});
  receipt.captures.push({file:path.basename(file),sha256:sha(await readFile(file))});
  await save();
}
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CRONY_PLAYWRIGHT_MODULE);
let browser;
try {
  let checkpoint=await phase('prepare');
  browser=await chromium.launch({channel:'msedge',headless:true});
  receipt.browser=browser.version();
  async function viewer(actor) {
    const context=await browser.newContext({viewport:{width:1440,height:1050}});
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(['data:','blob:'].includes(url.protocol)||url.hostname==='127.0.0.1') return route.continue();
      receipt.blocked_requests.push(url.origin);
      return route.abort();
    });
    const page=await context.newPage();
    page.on('pageerror',error=>receipt.browser_errors.push(String(error)));
    await page.goto(state.plan.web+'/#floor',{waitUntil:'networkidle',timeout:30000});
    await page.locator('.live-indicator.live-live').waitFor({timeout:30000});
    await page.locator('#operator-actor').selectOption(actor);
    await page.getByLabel('Show offline and test identities',{exact:true}).check();
    await page.locator('.pixel-office-roster').getByRole('button',{name:/^Inspect /}).first().click();
    return page;
  }
  const alice=await viewer(checkpoint.ids.alice_actor_id);
  await capture(alice,'alice-before-pin');
  const pinResponse=alice.waitForResponse(r=>r.url()===state.plan.server+'/api/corps/'+checkpoint.ids.corp_id+'/agents/'+checkpoint.agent+'/pin'&&r.request().method()==='POST');
  await alice.getByRole('button',{name:/^Pin /}).click();
  const pinned=await pinResponse;
  assert.equal(pinned.status(),200);
  receipt.requests.push({actor:'Alice',request:pinned.request().postDataJSON(),response:await pinned.json()});
  await alice.getByRole('button',{name:/^Unpin /}).waitFor();
  await capture(alice,'alice-pinned');
  checkpoint=await phase('start');
  const bob=await viewer(checkpoint.ids.bob_actor_id);
  await capture(bob,'bob-before-unpin');
  const unpinResponse=bob.waitForResponse(r=>r.url()===state.plan.server+'/api/corps/'+checkpoint.ids.corp_id+'/agents/'+checkpoint.agent+'/pin'&&r.request().method()==='POST');
  await bob.getByRole('button',{name:/^Unpin /}).click();
  const unpinned=await unpinResponse;
  assert.equal(unpinned.status(),200);
  receipt.requests.push({actor:'Bob',request:unpinned.request().postDataJSON(),response:await unpinned.json()});
  await bob.getByRole('button',{name:/^Pin /}).waitFor();
  await capture(bob,'bob-unpinned-active-obligations');
  checkpoint=await phase('complete');
  assert.equal(checkpoint.phase,'complete');
  await alice.reload({waitUntil:'networkidle'});
  await capture(alice,'completed-retention-history');
  assert.deepEqual(receipt.browser_errors,[]);
  assert.deepEqual(receipt.blocked_requests,[]);
  receipt.status='passed';
} catch(error) {
  receipt.status='failed';receipt.failure=String(error);throw error;
} finally {
  receipt.finished_at=new Date().toISOString();await save();
  if(browser)await browser.close();
}
console.log(JSON.stringify({status:receipt.status,phases:receipt.phases.length,captures:receipt.captures.length,receipt:receiptPath}));
