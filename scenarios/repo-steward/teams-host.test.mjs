import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixtureSnapshot } from './fixtures/demo.mjs';
import { createTeamsHost, main, makeMessageHandler, settingsFromEnv, teamsPreflight } from './teams-host.mjs';
import { createStewardTools } from './lib/tools.mjs';
import { textDependencies } from './lib/steward.mjs';
import { validateSnapshot } from './lib/common.mjs';

const now = new Date('2026-09-12T22:00:00Z');
const settings = { mode: 'test-only', tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222', chatId: '19:fixture-test-group@thread.v2', botId: '28:22222222-2222-4222-8222-222222222222', clientSecret: 'synthetic-non-working-test-secret', snapshotPath: 'fixture-only.json', port: 0 };
const activity = (id = 'event-1') => ({ id, type: 'message', channelId: 'msteams', channelData: { tenant: { id: settings.tenantId } }, conversation: { id: settings.chatId, conversationType: 'groupChat' }, from: { id: 'fixture-user' }, recipient: { id: settings.botId }, text: '<at>Steward</at> explain PR #237', entities: [{ type: 'mention', text: '<at>Steward</at>', mentioned: { id: settings.botId } }] });
const context = (a, send) => ({ appId: settings.clientId, activity: a, send });
function environment() { return { ECORP_STEWARD_TEAMS_MODE: settings.mode, ECORP_STEWARD_TEAMS_TENANT_ID: settings.tenantId, ECORP_STEWARD_TEAMS_CLIENT_ID: settings.clientId, ECORP_STEWARD_TEAMS_TEST_CHAT_ID: settings.chatId, ECORP_STEWARD_TEAMS_BOT_ID: settings.botId, ECORP_STEWARD_TEAMS_CLIENT_SECRET: settings.clientSecret, ECORP_STEWARD_SNAPSHOT: settings.snapshotPath }; }

test('Teams preview is disabled without exact configuration and reveals no secret', async () => {
  assert.equal(teamsPreflight({}).configured, false);
  const result = await main(['--dry-run'], environment());
  assert.equal(result.preview.listener_started, false); assert.equal(result.preview.teams_messages_sent, 0);
  assert.ok(!JSON.stringify(result).includes(settings.clientSecret));
});
test('Teams environment cannot activate production or repo writes', () => {
  assert.throws(() => settingsFromEnv({ ...environment(), ECORP_STEWARD_TEAMS_MODE: 'production' }));
  assert.throws(() => settingsFromEnv({ ...environment(), ECORP_STEWARD_ALLOW_WRITES: 'true' }));
  assert.throws(() => settingsFromEnv({ ...environment(), ECORP_STEWARD_TEAMS_PRODUCTION_CHAT_ID: '19:production@thread.v2' }));
});
test('Teams rejects missing identities, missing secret, and factory ports', () => {
  assert.throws(() => settingsFromEnv({}));
  for (const value of ['', 'invalid']) assert.throws(() => settingsFromEnv({ ...environment(), ECORP_STEWARD_TEAMS_TENANT_ID: value }));
  assert.throws(() => settingsFromEnv({ ...environment(), ECORP_STEWARD_TEAMS_CLIENT_SECRET: '' }));
  assert.throws(() => settingsFromEnv({ ...environment(), ECORP_STEWARD_TEAMS_PORT: '8791' }));
});
test('Teams CLI has no secret argument or skip-auth switch', async () => {
  await assert.rejects(main(['--skip-auth'], environment()));
  await assert.rejects(main(['--serve-test', '--client-secret', settings.clientSecret], environment()));
});
// Include the SDK's cold module load on Windows; each HTTP probe remains bounded
// by its own five-second deadline and must still prove native auth rejection.
test('native Teams SDK rejects unauthenticated requests on an owned loopback endpoint', { timeout: 60000 }, async t => {
  let snapshotReads = 0;
  const started = Date.now();
  const host = await createTeamsHost(settings, { now: () => now, snapshotProvider: async () => { snapshotReads++; return fixtureSnapshot(now); } });
  t.diagnostic(`SDK host initialized after ${Date.now() - started}ms; no listener yet`);
  t.after(async () => { await host.stop(); assert.equal(host.address(), null); });
  assert.equal(host.app.options.dangerouslyAllowUnauthenticatedRequests, false);
  assert.equal(host.app.options.skipAuth, false);
  assert.equal(host.app.options.oauth.fetchUserToken, false);
  await host.start(); assert.equal(host.address().address, '127.0.0.1');
  t.diagnostic(`Owned loopback listener started after ${Date.now() - started}ms`);
  const url = `http://127.0.0.1:${host.address().port}/api/messages`;
  for (const headers of [{}, { authorization: 'Bearer not-a-real-jwt' }]) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(activity()), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(settings.clientSecret));
  }
  const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"secret":"${settings.clientSecret}"`, signal: AbortSignal.timeout(5000) });
  assert.equal(bad.status, 400); assert.equal(await bad.text(), '{"error":"INVALID_REQUEST"}');
  assert.equal(snapshotReads, 0); assert.equal(host.metrics().sent, 0);
});
test('test binding replies to a mention using recorded findings', async () => {
  const sent = []; const route = makeMessageHandler({ binding: settings, now: () => now, snapshotProvider: async () => fixtureSnapshot(now) });
  await route.handler(context(activity(), async message => { sent.push(message); }));
  assert.equal(sent.length, 1); assert.match(sent[0], /conflicting closure intent|closing relationships/i); assert.equal(route.metrics().github_mutations, 0);
});
test('duplicate/concurrent activity produces one attempted reply', async () => {
  let sent = 0; const route = makeMessageHandler({ binding: settings, now: () => now, snapshotProvider: async () => fixtureSnapshot(now) });
  const ctx = context(activity(), async () => { sent++; });
  await Promise.all([route.handler(ctx), route.handler(ctx), route.handler(ctx)]); assert.equal(sent, 1);
});
test('uncertain Teams send is not blindly retried', async () => {
  let sends = 0; const route = makeMessageHandler({ binding: settings, now: () => now, snapshotProvider: async () => fixtureSnapshot(now) });
  const ctx = context(activity(), async () => { sends++; throw new Error(settings.clientSecret); });
  await route.handler(ctx); await route.handler(ctx); assert.equal(sends, 1); assert.equal(route.metrics().uncertain_sends, 1);
});
test('unapproved tenant/group/app/recipient are ignored before snapshot access', async () => {
  let reads = 0, sends = 0; const route = makeMessageHandler({ binding: settings, now: () => now, snapshotProvider: () => { reads++; return fixtureSnapshot(now); } });
  for (const mutate of [a => { a.channelData.tenant.id = 'wrong'; }, a => { a.conversation.id = '19:production@thread.v2'; }, a => { a.recipient.id = 'different-bot'; }]) {
    const a = activity(); mutate(a); await route.handler(context(a, async () => { sends++; }));
  }
  await route.handler({ ...context(activity(), async () => { sends++; }), appId: 'different-app' });
  assert.equal(reads, 0); assert.equal(sends, 0);
});
test('mention-only routing and rate cap limit noise', async () => {
  let sent = 0; const route = makeMessageHandler({ binding: settings, now: () => now, snapshotProvider: () => fixtureSnapshot(now), maxRepliesPerMinute: 2 });
  const a = activity(); a.entities = []; await route.handler(context(a, async () => { sent++; }));
  for (let i = 0; i < 3; i++) await route.handler(context(activity(`event-${i}`), async () => { sent++; }));
  assert.equal(sent, 2);
});
test('stale or invalid snapshots do not leak unverified answers', async () => {
  let text; const snapshot = fixtureSnapshot(new Date('2026-01-01T00:00:00Z'));
  const route = makeMessageHandler({ binding: settings, now: () => now, snapshotProvider: () => snapshot });
  await route.handler(context(activity(), async value => { text = value; }));
  assert.match(text, /refresh/); assert.ok(!text.includes('PR #237'));
});
test('Teams write requests get a refusal, not an operation', async () => {
  let text; const a = activity(); a.text = '<at>Steward</at> assign #50 to someone';
  const route = makeMessageHandler({ binding: settings, now: () => now, snapshotProvider: () => fixtureSnapshot(now) });
  await route.handler(context(a, async value => { text = value; })); assert.match(text, /cannot make that change/); assert.equal(route.metrics().github_mutations, 0);
});
test('model tool catalogue has only snapshot reads', () => {
  const tools = createStewardTools(fixtureSnapshot(now), { now });
  assert.equal(tools.catalog.length, 5); assert.ok(tools.catalog.every(t => t.annotations.readOnlyHint));
  assert.equal(tools.call('steward_audit').github_mutations, 0);
  assert.equal(tools.call('steward_workstreams').workstreams.length, 10);
  assert.match(tools.call('steward_issue', { number: 236 }).text, /#50/);
  assert.match(tools.call('steward_pull_request', { number: 237 }).text, /237/);
  assert.equal(tools.call('steward_question', { question: 'close #50' }).refused, true);
  assert.throws(() => tools.call('github_write', {})); assert.throws(() => tools.call('steward_issue', { number: 50, assign: 'someone' }));
  assert.throws(() => tools.call('steward_issue', { number: 237 }));
});
test('fences of another kind cannot create a dependency instruction', () => {
  assert.deepEqual(textDependencies('```md\n~~~\n## Dependencies\nBlocked by #999\n```\n## Dependencies\nBlocked by #50'), [50]);
});
test('oversized issue numbers never become canonical reference URLs', () => assert.deepEqual(textDependencies('## Dependencies\nBlocked by #99999999999999999999999999999.'), []));
test('snapshot cannot substitute a same-named repository identity or execution grant', () => {
  const snapshot = fixtureSnapshot(now); snapshot.scope.repository_id = 'different-node'; assert.throws(() => validateSnapshot(snapshot));
  const second = fixtureSnapshot(now); second.scope.ecorp_execution_authority = 'admin'; assert.throws(() => validateSnapshot(second));
});

test('a configured binding cannot silently move to another chat', async () => {
  const mutable = { ...settings }; let sends = 0;
  const route = makeMessageHandler({ binding: mutable, now: () => now, snapshotProvider: () => fixtureSnapshot(now) });
  mutable.chatId = '19:production@thread.v2';
  const a = activity(); a.conversation.id = mutable.chatId;
  await route.handler(context(a, async () => { sends++; })); assert.equal(sends, 0);
});
test('SDK startup collision is detected and leaves the existing listener untouched', { timeout: 60000 }, async t => {
  const existing = createServer((_req, res) => res.end('owned-control'));
  await new Promise(resolve => existing.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { existing.close(resolve); existing.closeAllConnections(); }));
  const host = await createTeamsHost({ ...settings, port: existing.address().port }, { now: () => now, snapshotProvider: () => fixtureSnapshot(now) });
  t.after(() => host.stop());
  await assert.rejects(host.start(), { code: 'TEAMS_START' });
  assert.equal(await (await fetch(`http://127.0.0.1:${existing.address().port}`, { signal: AbortSignal.timeout(3000) })).text(), 'owned-control');
  assert.equal(host.address(), null);
});
