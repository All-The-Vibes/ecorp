import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';

import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { createServer } from 'node:http';

import path from 'node:path';

import { promisify } from 'node:util';

import { execFile as execFileCallback, spawnSync } from 'node:child_process';



const execFile = promisify(execFileCallback);

const root = process.env.ECORP_COMPLETION_QA_ROOT;

const product = process.env.ECORP_COMPLETION_PRODUCT;

assert.match(root ?? '', /[\\/]qa[\\/]pr265-run-activity-pr354-20260922-r\d+$/);

assert.equal(process.env.ECORP_COMPLETION_PR, '354');

const forbidden = () => Object.keys(process.env).filter(name => /^(PG|DATABASE_URL$|GH_|GITHUB_|AZURE_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|COPILOT_GITHUB_TOKEN$)/i.test(name));

assert.deepEqual(forbidden(), [], 'The readiness process must not inherit credential variables or database file locators');

const ownership = JSON.parse(await readFile(path.join(root, 'ownership.json'), 'utf8'));

assert.equal(ownership.test_owned, true);

assert.equal(ownership.purpose, 'pr265-run-activity');

assert.equal(path.resolve(ownership.workspace), path.resolve(root));

assert.match(ownership.plan.server, /^http:\/\/127\.0\.0\.1:29354$/);

assert.equal(ownership.plan.database.port, 25354);

assert.match(ownership.demo.corp_id, /^[0-9a-f-]{36}$/);

const { demo, source } = ownership;

const [owner, name] = source.repository.split('/');

assert.ok(owner && name);

const contract = {

  objective: 'Observe dispatch readiness without claiming or dispatching work',

  expected_output: 'result.md', allowed_tools: ['filesystem'],

  prohibited_actions: ['No external effects'], write_scope: ['result.md'],

};

const request = {

  actor_id: demo.alice_actor_id,

  source_repository_owner: owner, source_repository_name: name,

  title: 'PR354 owned native dispatch readiness',

  description: 'Deterministic local acceptance; no provider execution',

  preferred_adapter: 'fake-process', strategy: 'single',

  budget_tokens: 1000, budget_cost_microusd: 1000000, contract,

  policy: {

    schema_version: 1, source_of_truth: 'github_project', auto_merge: false,

    repository_allowlist: [source.repository], source_base_ref: source.base_ref,

    source_base_commit: source.base_commit, adapter_allowlist: ['fake-process'],

    strategy_allowlist: ['single'], model: null, reasoning_effort: null,

    write_scope: contract.write_scope, allowed_tools: contract.allowed_tools,

    prohibited_actions: contract.prohibited_actions, secret_ids: [],

    verification_required: true, budget_tokens: 1000, budget_cost_microusd: 1000000,

  },

};

const report = {

  pr: 354, started_at: new Date().toISOString(), status: 'running',

  scope: 'Real native CLI, HTTP server, reconciled runner and new owned SCRAM PostgreSQL. Fake GitHub transport only; no external GitHub or provider execution. Fixture claim setup precedes immutable ledger measurements.',

  source, credential_preflight: { forbidden_variable_names: forbidden() }, assertions: [], cli_cases: [],

};

const destination = path.join(root, 'evidence', 'pr354-dispatch-readiness.json');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sql(statement) {

  const result = spawnSync(process.env.ECORP_COMPLETION_PSQL, [

    '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '25354',

    '-U', 'pr265_qa', '-d', 'pr265_activity', '-c', statement,

  ], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,

    env: { ...process.env, PGPASSFILE: path.join(root, 'credentials', 'pgpass.conf') } });

  assert.equal(result.status, 0, `Owned SQL operation failed: ${result.error?.code ?? result.status}: ${result.stderr}`);

  return result.stdout.trim();

}

function ledger() {

  const tables = ['factory_work_items', 'factory_operations', 'missions', 'tasks',

    'runs', 'events', 'factory_controllers', 'factory_controller_operations'];

  const fields = tables.map(table => `'${table}', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM ${table} t WHERE corp_id='${demo.corp_id}'::uuid)`);

  return JSON.parse(sql(`SELECT jsonb_build_object(${fields.join(', ')});`));

}

async function post(route, body) {

  const response = await fetch(`${ownership.plan.server}${route}`, {

    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),

  });

  const text = await response.text();

  let payload;

  try { payload = JSON.parse(text); } catch { payload = text; }

  return { status: response.status, payload };

}

const preflightPath = `/api/corps/${demo.corp_id}/factory/preflight`;

const preflight = body => post(preflightPath, body);

let proxy;

const routes = [];

try {

  const bootstrap = await post('/api/demo/bootstrap?seed_crew=true', {});

  assert.equal(bootstrap.status, 200);

  assert.deepEqual(bootstrap.payload, demo);

  const deadline = Date.now() + 45000;

  let ready;

  do {

    ready = await preflight(request);

    assert.equal(ready.status, 200, JSON.stringify(ready));

    if (ready.payload.dispatch_readiness?.status === 'ready') break;

    await new Promise(resolve => setTimeout(resolve, 200));

  } while (Date.now() < deadline);

  assert.equal(ready.payload.dispatch_readiness?.status, 'ready');

  const before = ledger();

  const mismatched = structuredClone(request);

  mismatched.policy.source_base_commit = source.base_commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);

  const offline = await preflight(mismatched);

  assert.equal(offline.status, 200);

  assert.equal(offline.payload.valid, true);

  assert.equal(offline.payload.dispatch_readiness.status, 'not_ready');

  assert.ok(offline.payload.dispatch_readiness.reason);

  assert.deepEqual(ledger(), before);

  report.assertions.push({ name: 'Valid plan remains available with a source mismatch', response: offline });

  const strict = await preflight({ ...mismatched, require_dispatch_ready: true });

  assert.equal(strict.status, 409);

  assert.deepEqual(ledger(), before);

  report.assertions.push({ name: 'Execution intent fails before claim or dispatch', response: strict });

  const matching = await preflight({ ...request, require_dispatch_ready: true });

  assert.equal(matching.status, 200);

  assert.deepEqual(matching.payload.dispatch_readiness, { status: 'ready' });

  assert.deepEqual(ledger(), before);

  report.assertions.push({ name: 'Matching immutable source and native runner are ready', response: matching });

  const denied = await preflight({ ...request, actor_id: demo.eve_actor_id, require_dispatch_ready: true });

  assert.equal(denied.status, 403);

  assert.deepEqual(ledger(), before);

  report.assertions.push({ name: 'Observer cannot acquire execution authority through preflight', response: denied });



  const cliRoot = path.join(root, 'native-intake');

  await mkdir(cliRoot);

  const cliSource = path.join(cliRoot, 'source');

  const git = async args => (await execFile('git', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 })).stdout.trim();

  const sourceBefore = await git(['-C', path.join(root, 'source'), 'rev-parse', 'HEAD']);

  assert.equal(sourceBefore, source.base_commit);

  await git(['clone', '--no-hardlinks', '--', path.join(root, 'source'), cliSource]);

  await git(['-C', cliSource, 'remote', 'set-url', 'origin', `https://github.com/${source.repository}.git`]);

  await writeFile(path.join(cliSource, 'unready-intake.txt'), 'Native CLI source intentionally differs from enrolled runner.\n', { flag: 'wx' });

  await git(['-C', cliSource, 'add', '--', 'unready-intake.txt']);

  await git(['-C', cliSource, '-c', 'user.name=ECorp QA', '-c', 'user.email=qa@ecorp.invalid', 'commit', '-m', 'Prepare distinct owned immutable intake source']);

  const cliCommit = await git(['-C', cliSource, 'rev-parse', 'HEAD']);

  assert.notEqual(cliCommit, source.base_commit);

  assert.equal(await git(['-C', path.join(root, 'source'), 'rev-parse', 'HEAD']), sourceBefore);

  const issues = [7101, 7102].map(number => ({

    id: `I_PR354_${number}`, number, title: `PR354 bounded readiness issue ${number}`,

    body: '## Outcome\n\nVerify dispatch readiness before acquiring work.\n\n## Acceptance criteria\n\n- [ ] Keep ledger rows unchanged while the source is unavailable.\n\n## Dependencies\n\nNo blockers.\n',

    url: `https://github.com/${source.repository}/issues/${number}`, state: 'OPEN',

    createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', labels: [{name:'factory:ready'}],

  }));

  const fakeStatePath = path.join(cliRoot, 'github-state.json');

  const fakeState = {

    repository: source.repository,

    project: {id:'PVT_PR354',number:7,owner:'acme',title:'Owned readiness fixture',status_field_id:'PVTSSF_PR354',status_options:[{id:'todo',name:'Todo'},{id:'in-progress',name:'In Progress'},{id:'done',name:'Done'}]},

    items: issues.map(issue => ({id:`PVTI_PR354_${issue.number}`,status:'Todo',content:{body:issue.body,number:issue.number,repository:source.repository,title:issue.title,type:'Issue',url:issue.url}})),

    issues: Object.fromEntries(issues.map(issue => [String(issue.number),issue])), item_edits: 0,

  };

  await writeFile(fakeStatePath, `${JSON.stringify(fakeState, null, 2)}\n`, {flag:'wx'});

  proxy = createServer(async (incoming, outgoing) => {

    const chunks = [];

    try {

      assert.match(incoming.url ?? '', /^\/api\//);

      for await (const chunk of incoming) chunks.push(chunk);

      const body = Buffer.concat(chunks).toString('utf8');

      const record = {method:incoming.method,path:incoming.url,body:body ? JSON.parse(body) : null};

      routes.push(record);

      const response = await fetch(`${ownership.plan.server}${incoming.url}`, {method:incoming.method,headers:{'content-type':'application/json'},...(body ? {body} : {}),signal:AbortSignal.timeout(15000)});

      const result = await response.text();

      record.status = response.status;

      try { record.response = JSON.parse(result); } catch { record.response = result; }

      outgoing.writeHead(response.status, {'content-type':response.headers.get('content-type') ?? 'application/json'});

      outgoing.end(result);

    } catch {
      outgoing.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      outgoing.end('{"error":"Upstream request failed"}');
    }

  });

  await new Promise((resolve, reject) => {proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});

  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  // Exercise the actual listener; neither malformed request reaches the server.
  const hostileMarker = 'pr354-private-proxy-sentinel';
  const hostileText = '<script>' + hostileMarker + '</script>';
  const routesBeforeFaults = routes.length;
  report.proxy_failure_probes = [];
  for (const input of [
    {name: 'non-api-path', url: '/rejected?probe=' + encodeURIComponent(hostileText)},
    {name: 'malformed-api-json', url: '/api/proxy-failure-probe',
      options: {method: 'POST', headers: {'content-type': 'application/json'},
        body: '{invalid:' + hostileText}},
  ]) {
    const response = await fetch(proxyUrl + input.url, {
      ...input.options, signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(text, '{"error":"Upstream request failed"}');
    assert.equal(text.includes(hostileMarker), false);
    assert.equal(routes.length, routesBeforeFaults);
    report.proxy_failure_probes.push({
      name: input.name, status: response.status,
      content_type: response.headers.get('content-type'),
      nosniff: response.headers.get('x-content-type-options'),
      body: text, exception_details_returned: false, forwarded: false,
    });
  }
  assert.deepEqual(ledger(), before);


  const binary = path.join(product, 'target', 'debug', 'crony-cli.exe');

  report.native_cli = {binary_sha256:createHash('sha256').update(await readFile(binary)).digest('hex'),source_commit:cliCommit,runner_source_commit:source.base_commit,transport:'owned loopback recording proxy forwards every API request to the real server'};

  async function runCli(number, dryRun) {

    assert.deepEqual(forbidden(), []);

    const args = ['factory',demo.corp_id,demo.alice_actor_id,'--owner','acme','--project-number','7','--repository',source.repository,'--source-repository-path',cliSource,'--source-base-ref','HEAD','--adapter','fake-process','--strategy','single','--budget-tokens','1000','--budget-cost-microusd','1000000','--lease-seconds','300','--github-cli',process.execPath,'--write-scope','result.md','--issue',String(number),...(dryRun ? ['--dry-run'] : [])];

    const start = routes.length;

    let stdout = '', stderr = '', exit = 0;

    try {

      ({stdout,stderr} = await execFile(binary,args,{cwd:product,env:{...process.env,CRONY_SERVER_HTTP:proxyUrl,ECORP_GITHUB_CLI_PREFIX_ARGS_JSON:JSON.stringify([path.join(product,'tools','fake_github_cli.mjs')]),ECORP_FAKE_GITHUB_STATE:fakeStatePath},encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:4*1024*1024}));

    } catch(error) { stdout=error.stdout ?? '';stderr=error.stderr ?? '';exit=error.code; }

    const item={issue:number,dry_run:dryRun,program:binary,arguments:args,exit_code:exit,stdout,stderr,routes:routes.slice(start)};

    report.cli_cases.push(item);

    return item;

  }

  const dry = await runCli(7101,true);

  assert.equal(dry.exit_code,0,dry.stderr);

  const preview = JSON.parse(dry.stdout);

  assert.equal(preview.mode,'dry_run');

  assert.equal(preview.selected?.issue?.number ?? preview.selected?.issue_number,7101);

  assert.equal(preview.preflight.valid,true);

  assert.equal(preview.preflight.dispatch_readiness.status,'not_ready');

  assert.deepEqual(preview.mutations,[]);

  assert.deepEqual(ledger(),before);

  const dryPreflight = dry.routes.find(route => route.path === preflightPath);

  assert.ok(dryPreflight);

  assert.equal(Object.hasOwn(dryPreflight.body, 'require_dispatch_ready'), false, 'Native dry-run omits the opt-in field; non-dry runs must send true');

  assert.equal(dryPreflight.status,200);

  const legacyIssue = issues[1];

  const claim = await post(`/api/corps/${demo.corp_id}/factory/work-items/claim`,{

    actor_id:demo.alice_actor_id,source_project_owner:'acme',source_project_number:7,source_project_item_id:'PVTI_PR354_7102',

    source_repository_owner:owner,source_repository_name:name,source_issue_number:legacyIssue.number,source_issue_node_id:legacyIssue.id,source_issue_url:legacyIssue.url,source_title:legacyIssue.title,source_revision:legacyIssue.updatedAt,idempotency_key:'pr354-owned-legacy-claim',lease_seconds:300,policy:dryPreflight.body.policy,

  });

  assert.ok([200,201].includes(claim.status),JSON.stringify(claim));

  const workItem = claim.payload.work_item;

  assert.match(workItem?.id ?? '',/^[0-9a-f-]{36}$/);

  assert.equal(workItem.corp_id,demo.corp_id);

  assert.equal(workItem.mission_id,null);

  const expired = JSON.parse(sql(`UPDATE factory_work_items SET lease_expires_at=now()-interval '1 second', policy=jsonb_set(policy-'source_base_commit','{source_commit_upgrade_required}','true'::jsonb) WHERE corp_id='${demo.corp_id}'::uuid AND id='${workItem.id}'::uuid AND source_project_item_id='PVTI_PR354_7102' AND mission_id IS NULL RETURNING to_jsonb(factory_work_items);`).split('\n')[0]);

  assert.equal(expired.id,workItem.id);

  assert.equal(expired.policy.source_commit_upgrade_required,true);

  assert.equal(expired.policy.source_base_commit,undefined);

  assert.ok(Date.parse(expired.lease_expires_at)<Date.now());

  const withLegacy = ledger();

  report.fixture_setup = {legacy_work_item_id:workItem.id,legacy_lease_expired:true,legacy_source_upgrade_required:true,setup_completed_before_final_ledger_measurement:true};

  for (const number of [7101,7102]) {

    const result = await runCli(number,false);

    assert.equal(result.exit_code,1,result.stderr);

    const preflights=result.routes.filter(route => route.path === preflightPath);

    assert.equal(preflights.length,1,JSON.stringify(result));

    assert.equal(preflights[0].body.require_dispatch_ready,true);

    assert.equal(preflights[0].body.policy.source_base_commit,cliCommit);

    assert.equal(preflights[0].status,409);

    assert.match(result.stderr,/dispatch is not ready|409/);

    assert.equal(result.routes.some(route => /\/(claim|materialize|upgrade-source-commit|renew|transition)$/.test(route.path)),false);

    assert.deepEqual(ledger(),withLegacy);

    result.exact_ledger_rows_unchanged=true;

    result.claim_or_reclaim_requests=0;

  }

  const observedGithub = JSON.parse(await readFile(fakeStatePath, 'utf8'));
  // Read telemetry is persisted by fake_github_cli.mjs. Retain and validate it
  // separately; every business field and any unexpected field must be unchanged.
  const readTelemetryKeys = ['graphql_calls', 'graphql_event_count', 'graphql_events',
    'graphql_query_counts', 'graphql_quota', 'project_item_lookup_calls',
    'project_item_read_calls'];
  const githubBusinessState = structuredClone(observedGithub);
  for (const key of readTelemetryKeys) delete githubBusinessState[key];
  assert.deepEqual(githubBusinessState, fakeState);
  assert.equal(observedGithub.item_edits, 0);
  assert.ok(observedGithub.graphql_calls > 0);
  assert.equal(observedGithub.graphql_events.length, observedGithub.graphql_event_count);
  assert.equal(observedGithub.graphql_calls, observedGithub.graphql_event_count);
  for (const event of observedGithub.graphql_events) {
    assert.ok(['quota', 'issue_memberships', 'item_exact'].includes(event.kind));
    assert.equal(event.status, 200);
  }
  report.github_read_only = {business_state_unchanged: true, item_edits: 0,
    before_sha256: digest(fakeState), after_business_sha256: digest(githubBusinessState),
    read_telemetry: Object.fromEntries(readTelemetryKeys.map(key => [key, observedGithub[key]]))};

  assert.equal(await git(['-C',path.join(root,'source'),'rev-parse','HEAD']),sourceBefore);

  assert.equal(await git(['-C',cliSource,'rev-parse','HEAD']),cliCommit);

  report.ledger={tables:Object.keys(withLegacy),before_sha256:digest(withLegacy),after_sha256:digest(ledger()),exact_rows_unchanged:true};

  await writeFile(path.join(root,'evidence','pr354-ledger-before.json'),`${JSON.stringify(withLegacy,null,2)}\n`,{flag:'wx'});

  await writeFile(path.join(root,'evidence','pr354-ledger-after.json'),`${JSON.stringify(ledger(),null,2)}\n`,{flag:'wx'});

  report.status='passed';

} catch(error) {

  report.status='failed';report.failure=error.message;throw error;

} finally {

  if(proxy) await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});

  report.finished_at=new Date().toISOString();

  await writeFile(destination,`${JSON.stringify(report,null,2)}\n`,{flag:'wx'});

  console.log(JSON.stringify(report,null,2));

}

