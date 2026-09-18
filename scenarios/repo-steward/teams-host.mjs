import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, integer, loadPolicy, readJson, requireThat, safeText, StewardError, validateSnapshot } from './lib/common.mjs';
import { prepareTestChatReply, validateTestBinding } from './lib/teams.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const envKeys = Object.freeze({ mode: 'ECORP_STEWARD_TEAMS_MODE', tenantId: 'ECORP_STEWARD_TEAMS_TENANT_ID', chatId: 'ECORP_STEWARD_TEAMS_TEST_CHAT_ID', botId: 'ECORP_STEWARD_TEAMS_BOT_ID', clientId: 'ECORP_STEWARD_TEAMS_CLIENT_ID', clientSecret: 'ECORP_STEWARD_TEAMS_CLIENT_SECRET', snapshotPath: 'ECORP_STEWARD_SNAPSHOT' });

export function teamsPreflight(env = process.env) {
  const missing = Object.entries(envKeys).filter(([, key]) => !env[key]).map(([, key]) => key);
  return { mode: 'test-only', sdk: '@microsoft/teams.apps@2.0.16', configured: missing.length === 0, missing,
    authentication_required: true, bind: '127.0.0.1', repository_writes: false, production_chat: false,
    listener_started: false, login_performed: false, app_registered: false, teams_messages_sent: 0,
    credential_delivery: 'trusted host process environment; reduced assurance; never shared with model tools' };
}

export function settingsFromEnv(env = process.env) {
  requireThat(teamsPreflight(env).configured, 'TEAMS_CONFIGURATION', 'Test tenant, group chat, bot/app identity, private host credential, and snapshot path are required. Run --dry-run for missing setting names.');
  const settings = Object.fromEntries(Object.entries(envKeys).map(([key, name]) => [key, env[name]]));
  validateTestBinding(settings);
  requireThat(UUID.test(settings.clientId), 'TEAMS_BOT', 'Teams app client ID must be an exact UUID.');
  requireThat(typeof settings.clientSecret === 'string' && settings.clientSecret.length >= 8 && settings.clientSecret.length <= 4096, 'TEAMS_CREDENTIAL', 'A bounded private host credential is required.');
  requireThat((env.ECORP_STEWARD_ALLOW_WRITES === undefined || env.ECORP_STEWARD_ALLOW_WRITES === 'false') && env.ECORP_STEWARD_TEAMS_PRODUCTION_CHAT_ID === undefined, 'READ_ONLY', 'Write-enabled and production-chat configurations are not supported.');
  settings.port = env.ECORP_STEWARD_TEAMS_PORT === undefined ? 3978 : Number(env.ECORP_STEWARD_TEAMS_PORT);
  requireThat(integer(settings.port, 1024, 65535) && ![8791, 5187, 54329].includes(settings.port), 'TEAMS_PORT', 'Use a dedicated non-factory local test port.');
  return settings;
}

export function quietLogger() {
  // SDK diagnostics may contain request bodies or credentials. This host emits
  // fixed outcome codes separately; raw SDK objects never enter logs.
  const logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, log() {}, child() { return logger; } };
  return logger;
}

export function makeMessageHandler({ binding, snapshotProvider, now = () => new Date(), maxRepliesPerMinute = 10 }) {
  validateTestBinding(binding);
  binding = Object.freeze({ ...binding });
  requireThat(typeof snapshotProvider === 'function' && integer(maxRepliesPerMinute, 1, 30), 'TEAMS_CONFIGURATION', 'Invalid bounded message-handler configuration.');
  const seen = new Map(), window = [];
  const metrics = { prepared: 0, sent: 0, ignored: 0, rejected: 0, uncertain_sends: 0 };
  const handler = async context => {
    const activity = context.activity;
    if (binding.clientId && context.appId !== binding.clientId) { metrics.rejected++; return; }
    // Scope and mention checks precede snapshot access and any response.
    if (activity?.type !== 'message' || activity.channelId !== 'msteams' || activity.channelData?.tenant?.id !== binding.tenantId || activity.conversation?.id !== binding.chatId || activity.conversation?.conversationType !== 'groupChat' || activity.recipient?.id !== binding.botId || activity.from?.id === binding.botId) { metrics.ignored++; return; }
    if (!Array.isArray(activity.entities) || !activity.entities.some(e => e.type === 'mention' && e.mentioned?.id === binding.botId)) { metrics.ignored++; return; }
    if (typeof activity.id !== 'string' || activity.id.length > 256 || typeof activity.from?.id !== 'string') { metrics.rejected++; return; }
    const timestamp = now().getTime(), key = hash([binding.tenantId, binding.chatId, activity.id]);
    for (const [id, expires] of seen) if (expires < timestamp) seen.delete(id);
    while (window[0] <= timestamp - 60000) window.shift();
    if (seen.has(key) || seen.size >= 2048 || window.length >= maxRepliesPerMinute) { metrics.ignored++; return; }
    // Reserve before awaiting I/O, including failed/uncertain delivery. No retry
    // loop can duplicate a reply in this process's bounded deduplication window.
    seen.set(key, timestamp + 3600000); window.push(timestamp);
    let text;
    try {
      const snapshot = await snapshotProvider(); validateSnapshot(snapshot);
      const age = (timestamp - Date.parse(snapshot.captured_at)) / 60000;
      requireThat(age >= -5 && age <= loadPolicy().max_snapshot_age_minutes, 'STALE_SNAPSHOT', 'Snapshot refresh is required.');
      const reply = prepareTestChatReply(activity, binding, snapshot, { now: new Date(timestamp) });
      if (reply.ignored) { metrics.ignored++; return; }
      text = reply.text; metrics.prepared++;
    } catch {
      metrics.rejected++;
      text = 'The repository snapshot or question could not be verified. Ask the operator to refresh the read-only snapshot or clarify the question. No repository changes were made.';
    }
    try { await context.send(text); metrics.sent++; }
    catch { metrics.uncertain_sends++; /* No raw error/credential logging or automatic resend. */ }
  };
  return { handler, metrics: () => ({ ...metrics, dedup_entries: seen.size, github_mutations: 0 }) };
}

export async function createTeamsHost(settings, { snapshotProvider = () => readJson(path.resolve(settings.snapshotPath)), now, sdkLoader = () => import('@microsoft/teams.apps') } = {}) {
  validateTestBinding(settings);
  settings = Object.freeze({ ...settings });
  requireThat(UUID.test(settings.clientId || '') && typeof settings.clientSecret === 'string' && settings.clientSecret.length >= 8, 'TEAMS_CONFIGURATION', 'Verified test app configuration is required before constructing a host.');
  requireThat(integer(settings.port, 0, 65535) && ![8791, 5187, 54329].includes(settings.port), 'TEAMS_PORT', 'Dedicated test port required.');
  const { App, ExpressAdapter } = await sdkLoader();
  const logger = quietLogger(), server = createServer();
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 2000;
  const nativeAdapter = new ExpressAdapter(server, { logger });
  // Use the SDK's supported HTTP adapter interface only to constrain the listen
  // address. JSON handling, routing and service JWT validation remain native SDK.
  const adapter = {
    registerRoute: (method, route, handler) => nativeAdapter.registerRoute(method, route, handler),
    start: port => new Promise((resolve, reject) => {
      const onError = error => { server.off('error', onError); reject(error); };
      server.once('error', onError);
      server.listen(Number(port), '127.0.0.1', () => { server.off('error', onError); resolve(); });
    }),
    stop: () => new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    }),
  };
  const app = new App({ clientId: settings.clientId, clientSecret: settings.clientSecret, tenantId: settings.tenantId,
    dangerouslyAllowUnauthenticatedRequests: false, skipAuth: false, oauth: { fetchUserToken: false },
    activity: { mentions: { stripText: false } }, serviceUrl: 'https://smba.trafficmanager.net/teams',
    httpServerAdapter: adapter, logger, plugins: [] });
  const route = makeMessageHandler({ binding: settings, snapshotProvider, now });
  // Gate every authenticated activity before SDK default invoke/OAuth handlers,
  // not only the message route. This pilot has no signin or invoke capability.
  app.use(async context => {
    const a = context.activity;
    if (context.appId !== settings.clientId || a?.type !== 'message' || a.channelId !== 'msteams' || a.channelData?.tenant?.id !== settings.tenantId || a.conversation?.id !== settings.chatId || a.conversation?.conversationType !== 'groupChat' || a.recipient?.id !== settings.botId) return { status: 200 };
    return context.next();
  });
  app.on('message', route.handler);
  await app.initialize();
  // Redact parser/framework failures too, not just SDK logger calls. Never emit
  // Express's default development stack or a fragment of an invalid JSON body.
  nativeAdapter.use((_error, _req, res, _next) => { res.status(400).send({ error: 'INVALID_REQUEST' }); });
  return { app, start: async () => {
    // App.start uses `port || 3978`; preserve an explicitly ephemeral test port
    // with its supported string form, then convert at the native listen boundary.
    await app.start(settings.port === 0 ? '0' : settings.port);
    requireThat(server.listening && server.address()?.address === '127.0.0.1', 'TEAMS_START', 'Native SDK did not establish the requested loopback listener.');
  }, stop: () => app.stop(), address: () => server.address(), metrics: route.metrics };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  requireThat(argv.length <= 1 && (!argv.length || ['--dry-run', '--serve-test'].includes(argv[0])), 'ARGUMENT', 'Use --dry-run or --serve-test. Secrets and chat IDs are not command arguments.');
  if (!argv.length || argv[0] === '--dry-run') return { preview: teamsPreflight(env) };
  const settings = settingsFromEnv(env);
  const snapshot = readJson(path.resolve(settings.snapshotPath)); validateSnapshot(snapshot);
  const age = (Date.now() - Date.parse(snapshot.captured_at)) / 60000;
  requireThat(age >= -5 && age <= loadPolicy().max_snapshot_age_minutes, 'STALE_SNAPSHOT', 'Refresh the snapshot before starting the test host.');
  const host = await createTeamsHost(settings);
  try { await host.start(); }
  catch { await host.stop(); throw new StewardError('TEAMS_START', 'The dedicated loopback test endpoint could not start. Existing processes were not stopped.'); }
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await host.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { host, preview: { mode: 'test-only', listener: `http://127.0.0.1:${host.address().port}/api/messages`, service_jwt_required: true, exact_test_tenant_and_chat_only: true, github_writes: false, production_chat: false, tunnel_created: false } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(JSON.stringify(result.preview, null, 2) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ error: error instanceof StewardError ? error.code : 'TEAMS_FAILURE', message: error instanceof StewardError ? safeText(error.message) : 'Teams host preparation failed; raw SDK details are withheld.' }) + '\n');
    process.exitCode = 1;
  });
}
