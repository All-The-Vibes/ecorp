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
const receipt={viewports:[],browser_environment_keys:[],status:'running',started_at:new Date().toISOString(),scope:'Actual native Edge office controls and owned development-principal server/runner/CLI fixture; deterministic provider, no external effects.',phases:[],captures:[],requests:[],browser_errors:[],blocked_requests:[]};
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
// Only startup variables reach Edge. Fixture children receive the separate env
// above, which includes their scoped database password-file locator.
const browserEnvironment={};
const browserKeys=new Set(['systemroot','windir','comspec','path','pathext','temp','tmp','userprofile','localappdata','appdata','programfiles','programfiles(x86)','programdata']);
for(const [key,value] of Object.entries(process.env)) if(browserKeys.has(key.toLowerCase())) browserEnvironment[key]=value;
assert.equal(Object.keys(browserEnvironment).some(key=>/^(PG|DATABASE_URL|CRONY_|ECORP_)/i.test(key)),false);
receipt.browser_environment_keys=Object.keys(browserEnvironment).sort();
async function viewport(page,width,label) {
  await page.setViewportSize({width,height:width===390?844:1050});
  await page.waitForFunction(()=>document.fonts.status==='loaded');
  const sizes=await page.evaluate(()=>({width:window.innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  receipt.viewports.push({label,...sizes});
  await save();
  assert.equal(sizes.width,width);
  assert.ok(sizes.scroll<=sizes.client,JSON.stringify({label,...sizes}));
}
let browser;
try {
  let checkpoint=await phase('prepare');
  browser=await chromium.launch({channel:'msedge',headless:true,env:browserEnvironment});
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
  await viewport(alice,1440,'desktop before Pin');
  await capture(alice,'desktop-alice-before-pin');
  await viewport(alice,390,'390px before Pin');
  await capture(alice,'mobile-alice-before-pin');
  const pinResponse=alice.waitForResponse(r=>r.url()===state.plan.server+'/api/corps/'+checkpoint.ids.corp_id+'/agents/'+checkpoint.agent+'/pin'&&r.request().method()==='POST');
  await alice.getByRole('button',{name:/^Pin /}).click();
  const pinned=await pinResponse;
  assert.equal(pinned.status(),200);
  receipt.requests.push({actor:'Alice',request:pinned.request().postDataJSON(),response:await pinned.json()});
  await alice.getByRole('button',{name:/^Unpin /}).waitFor();
  await viewport(alice,390,'390px pinned');
  await capture(alice,'mobile-alice-pinned');
  await viewport(alice,1440,'desktop pinned');
  await capture(alice,'desktop-alice-pinned');
  checkpoint=await phase('start');
  const bob=await viewer(checkpoint.ids.bob_actor_id);
  await viewport(bob,1440,'desktop before Unpin');
  await capture(bob,'desktop-bob-before-unpin');
  await viewport(bob,390,'390px before Unpin');
  await capture(bob,'mobile-bob-before-unpin');
  const unpinResponse=bob.waitForResponse(r=>r.url()===state.plan.server+'/api/corps/'+checkpoint.ids.corp_id+'/agents/'+checkpoint.agent+'/pin'&&r.request().method()==='POST');
  await bob.getByRole('button',{name:/^Unpin /}).click();
  const unpinned=await unpinResponse;
  assert.equal(unpinned.status(),200);
  receipt.requests.push({actor:'Bob',request:unpinned.request().postDataJSON(),response:await unpinned.json()});
  await bob.getByRole('button',{name:/^Pin /}).waitFor();
  await viewport(bob,390,'390px unpinned with live obligations');
  await capture(bob,'mobile-bob-unpinned-active-obligations');
  await viewport(bob,1440,'desktop unpinned with live obligations');
  await capture(bob,'desktop-bob-unpinned-active-obligations');
  checkpoint=await phase('complete');
  assert.equal(checkpoint.phase,'complete');
  await alice.reload({waitUntil:'networkidle'});
  await viewport(alice,1440,'desktop retained history');
  await capture(alice,'desktop-completed-retention-history');
  await viewport(alice,390,'390px retained history');
  await capture(alice,'mobile-completed-retention-history');
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
