import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE);
const { expect } = require(path.join(process.env.CRONY_PLAYWRIGHT_MODULE, 'test.js'));
const repo = String.raw`<reviewed-worktree>`;
const qa = String.raw`<local-user>\code\qa\pr265-run-activity-pr339-20260922T123548Z-r3`;
const ownership = JSON.parse((await readFile(path.join(qa, 'ownership.json'), 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(ownership.test_owned, true);
assert.equal(ownership.plan.product, repo);
assert.equal(ownership.purpose, 'pr265-run-activity');
const { demo, source } = ownership;
const { server, web } = ownership.plan;
for (const value of [server, web]) assert.match(value, /^http:\/\/127\.0\.0\.1:(28870|25870)$/);
const out = path.join(qa, 'evidence', 'pr339-reviewer');
await mkdir(out, { recursive: false });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
const originalSource = { head: git('-C', path.join(qa, 'source'), 'rev-parse', 'HEAD'), status: git('-C', path.join(qa, 'source'), 'status', '--porcelain') };
assert.equal(originalSource.head, source.base_commit);
assert.equal(originalSource.status, '');
const report = {schema_version:1,status:'running',started_at_utc:new Date().toISOString(),
  tested_staged_tree:git('-C',repo,'write-tree'), source_commit:source.base_commit,
  scope:'Real browser/server/PostgreSQL/native deterministic runner, development Alice/Bob/Eve identities. No provider inference, production identity, mocked responses or real human attestations.',
  operations:[],checks:[],screenshots:[],errors:[],blocked_requests:[]};
const save=()=>writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
await save();
const browser=await chromium.launch({executablePath:String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,headless:true});
report.browser_version=browser.version();
const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
await context.route('**/*',route=> {
  if (route.request().url().startsWith(web+'/') || route.request().url().startsWith(server+'/') || /^(data:|blob:)/.test(route.request().url())) return route.continue();
  report.blocked_requests.push(route.request().url()); return route.abort();
});
const page=await context.newPage();
page.on('pageerror',e=>report.errors.push(e.message));
const snapshot=async(actor=demo.alice_actor_id)=> {
  const response=await fetch(`${server}/api/corps/${demo.corp_id}/snapshot?actor_id=${actor}`,{redirect:'error',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200); return response.json();
};
async function until(read,predicate) { const end=Date.now()+90000; while(Date.now()<end) {const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,200));}throw new Error('Native persisted state timed out');}
async function capture(name) { const filename=name+'.png';await page.screenshot({path:path.join(out,filename),fullPage:true});report.screenshots.push({file:filename,sha256:digest(await readFile(path.join(out,filename)))});await save(); }
async function advanced(selector) {const el=page.locator('details.mission-advanced-options').filter({has:page.locator(selector)});if(!await el.evaluate(e=>e.open))await el.locator('summary').click();}
async function actor(id) {await page.locator('#operator-actor').selectOption(id);await expect(page.locator('#operator-actor')).toHaveValue(id);await expect(page.locator('.live-live')).toBeVisible({timeout:20000});}
try {
  const initial=await snapshot();
  assert.equal(initial.snapshot.missions.length,0);assert.equal(initial.snapshot.runs.length,0);
  await page.goto(web+'/#missions',{waitUntil:'networkidle'});
  await expect(page.locator('.live-live')).toBeVisible({timeout:20000});
  const start=page.getByRole('button',{name:'New mission',exact:true});if(await start.isVisible())await start.click();
  await page.locator('#mission-title').fill('PR339 independent reviewer acceptance');
  await advanced('#mission-description');
  await page.locator('#mission-description').fill('Owned deterministic reviewer eligibility acceptance. Preserve source and create a review report. No external effects.');
  const options=await page.locator('#mission-repository option').evaluateAll(items=>items.filter(i=>i.value).map(i=>({value:i.value,source:JSON.parse(i.value)})));
  const matches=options.filter(i=>i.source[0]===source.repository&&i.source[2]===source.base_commit);assert.equal(matches.length,1);
  await page.locator('#mission-repository').selectOption(matches[0].value);
  await page.getByRole('checkbox',{name:/Confirm this target/}).check();
  await advanced('#mission-deliverable');
  await page.getByRole('checkbox',{name:/Developer fixtures/}).check();
  await page.locator('#mission-adapter').selectOption('fake-process');await page.locator('#mission-strategy').selectOption('single');
  await page.locator('#mission-deliverable').selectOption('review_only_report');
  await page.getByRole('checkbox',{name:/Commit verified work/}).uncheck();
  await page.getByRole('checkbox',{name:/Save without starting/}).check();
  await page.getByRole('button',{name:'Review and build',exact:true}).click();
  await page.getByRole('checkbox',{name:/Custom verification/}).check();
  const editor=page.getByTestId('mission-verification-editor');
  await editor.getByLabel('Final reviewer gate').selectOption('independent_review');
  await editor.getByLabel('Eligible roles').fill('owner, admin, manager, member');
  await editor.getByRole('checkbox',{name:/Exclude the mission requester/}).check();
  report.operations.push({name:'browser-save',intent_at:new Date().toISOString(),completed:false});await save();
  const savedWait=page.waitForResponse(r=>r.url()===`${server}/api/corps/${demo.corp_id}/missions`&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Save plan',exact:true}).click();
  const saved=await savedWait;assert.equal(saved.status(),200);const created=await saved.json();
  report.operations.at(-1).completed=true;report.mission_id=created.mission_id;report.authored_policy=saved.request().postDataJSON().verification_policy;await save();
  const mid=created.mission_id;const card=page.locator(`[data-mission-id="${mid}"]`);
  report.operations.push({name:'browser-launch',intent_at:new Date().toISOString(),completed:false});await save();
  const launchedWait=page.waitForResponse(r=>r.url()===`${server}/api/corps/${demo.corp_id}/missions/${mid}/launch`&&r.request().method()==='POST');
  await card.getByTestId('work-result-card').getByRole('button',{name:'Start mission',exact:true}).click();
  assert.equal((await launchedWait).status(),200);report.operations.at(-1).completed=true;await save();
  const pending=await until(snapshot,s=>s.snapshot.verification_requests.some(request=> {
    const candidate=s.snapshot.runs.find(r=>r.id===request.run_id);
    return request.status==='pending' && candidate && ['preserved','removed'].includes(candidate.workspace_disposition);
  }));
  const task=pending.snapshot.tasks.find(t=>t.mission_id===mid);const run=pending.snapshot.runs.find(r=>r.task_id===task.id);
  assert.ok(run);assert.equal(run.status,'waiting_for_approval');assert.equal(run.runner_id,ownership.plan.runner_id);
  assert.equal(run.workspace_base_commit,source.base_commit);assert.ok(['preserved','removed'].includes(run.workspace_disposition));report.pending_workspace_disposition=run.workspace_disposition;
  const relative=path.relative(path.join(qa,'runner'),run.workspace_path);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  report.run_id=run.id;report.task_id=task.id;
  report.prior_attempts=[{attempt:'r1',failure:'driver imported expect from the wrong module',operations:0},
    {attempt:'r2',failure:'driver asserted cleanup before its event arrived',mission_id:'5175fe60-a09c-4485-b4c2-86a2561f95aa',operations:2,
    disposition:'Separate fixture stopped; its pending mission, database, worktree, logs and failed receipt remain preserved. This run does not replay it.'}];await save();
  const review=card.locator(`#mission-review-${mid}`);
  for (const viewport of [{name:'desktop',width:1440,height:1050},{name:'mobile',width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await actor(demo.alice_actor_id);
    const summary=card.getByTestId('work-result-card');
    await expect(summary).toContainText('Awaiting an eligible reviewer');
    const inspect=summary.getByRole('button',{name:'Inspect review requirements',exact:true});
    await inspect.focus();await page.keyboard.press('Enter');await expect(review).toBeFocused();
    await expect(review.getByRole('button',{name:'Accept evidence',exact:true})).toBeDisabled();
    await expect(review.getByRole('button',{name:'Reject evidence',exact:true})).toBeDisabled();
    const layout=await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));assert.equal(layout.width,viewport.width);assert.ok(layout.content<=viewport.width);
    await capture(viewport.name+'-requester');
    await actor(demo.bob_actor_id);
    await expect(summary).toContainText('Your review is needed');
    await expect(summary.getByRole('button',{name:'Review outcome',exact:true})).toBeVisible();
    await expect(review.getByRole('button',{name:'Accept evidence',exact:true})).toBeEnabled();
    await expect(review.getByRole('button',{name:'Reject evidence',exact:true})).toBeEnabled();
    await capture(viewport.name+'-eligible-reviewer');
    await actor(demo.eve_actor_id);
    await expect(card).toHaveCount(0);
    const excluded=await snapshot(demo.eve_actor_id);assert.ok(!excluded.snapshot.missions.some(m=>m.id===mid));assert.ok(!excluded.snapshot.runs.some(r=>r.id===run.id));
    await capture(viewport.name+'-excluded-viewer');
    report.checks.push({...viewport,layout,requester_blocked:true,eligible_review_enabled:true,nonmember_mission_and_run_hidden:true,keyboard_navigation:true});await save();
  }
  await actor(demo.bob_actor_id);
  report.operations.push({name:'development-bob-approve',intent_at:new Date().toISOString(),completed:false});await save();
  const decisionWait=page.waitForResponse(r=>r.url().includes('/verification-decision')&&r.request().method()==='POST');
  await review.getByRole('button',{name:'Accept evidence',exact:true}).click();
  assert.equal((await decisionWait).status(),200);report.operations.at(-1).completed=true;
  const completed=await until(snapshot,s=>s.snapshot.runs.some(r=>r.id===run.id&&r.status==='completed'));
  const finalRun=completed.snapshot.runs.find(r=>r.id===run.id);const finalRequest=completed.snapshot.verification_requests.find(r=>r.run_id===run.id);
  assert.equal(finalRequest.status,'approved');assert.equal(finalRequest.decided_by,demo.bob_actor_id);
  assert.equal(finalRun.workspace_disposition,report.pending_workspace_disposition);
  report.final={run_id:run.id,status:finalRun.status,verification_status:finalRun.verification_status,workspace_disposition:finalRun.workspace_disposition,
    verification_request_status:finalRequest.status,decided_by:finalRequest.decided_by,artifact_sha256:finalRun.artifact_sha256};
  report.source_unchanged=git('-C',path.join(qa,'source'),'rev-parse','HEAD')===originalSource.head&&git('-C',path.join(qa,'source'),'status','--porcelain')===originalSource.status;
  assert.ok(report.source_unchanged);assert.equal(report.errors.length,0);assert.equal(report.blocked_requests.length,0);
  await capture('mobile-completed');report.status='passed';
} catch(error) {report.status='failed';report.failure=error.message;process.exitCode=1;await capture('failure').catch(()=>{});}
finally {await browser.close();report.finished_at_utc=new Date().toISOString();await save();}
console.log(JSON.stringify({status:report.status,report:path.join(out,'report.json'),failure:report.failure}));
