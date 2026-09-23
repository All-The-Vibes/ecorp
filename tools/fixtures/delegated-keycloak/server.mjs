import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOAuth } from './oauth.mjs';
import { bearer, authorize, bindSubject, consumeTransaction, Denied } from './security.mjs';

process.chdir(import.meta.dirname);
const identity = process.platform === 'win32' ? JSON.parse(execFileSync('pwsh.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
  path.join(import.meta.dirname, 'process-identity.ps1'), '-ProcessId', String(process.pid),
], { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|PSModulePath|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/iu.test(name))),
})) : null;
if (identity && (identity.pid !== process.pid ||
    identity.executable.toLowerCase() !== process.execPath.toLowerCase())) {
  throw new Error('The fixture process identity changed before startup.');
}
const config = JSON.parse(await readFile('.private/config.json', 'utf8'));
const ports = config.ports ?? [18881, 18882, 18883];
if (!Array.isArray(ports) || ports.length !== 3 || new Set(ports).size !== 3 ||
    !ports.every(port => Number.isInteger(port) && port > 1024 && port <= 65535)) {
  throw new Error('Invalid synthetic fixture ports.');
}
const [interactivePort, connectorPort, resourcePort] = ports;
const oauth = await createOAuth(config);
const transactions = new Map();
const results = new Map();
const servers = [];
const cookieValue = (request, name) => request.headers.cookie?.split('; ')
  .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}
function serve(port, handler) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${port}`) throw new Denied(400);
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname === '/health' && request.method === 'GET') return send(response, 200, { ready: true });
      await handler(request, response, url);
    } catch (error) {
      // Never log request URLs, provider errors, credentials, tokens, or flag data.
      send(response, error instanceof Denied ? error.status : 500, { error: 'Request denied' });
    }
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

await serve(resourcePort, async (request, response, url) => {
  if (url.pathname !== '/flag') throw new Denied(404);
  const claims = await oauth.validate(bearer(request.headers.authorization), 'flag-api', 'connector');
  authorize(claims, config.reader.subject, request.method);
  send(response, 200, { flag: config.flag });
});
await serve(connectorPort, async (request, response, url) => {
  if (url.pathname !== '/read') throw new Denied(404);
  if (request.method !== 'GET') throw new Denied(403);
  const token = bearer(request.headers.authorization);
  const incoming = await oauth.validate(token, 'connector', 'interactive');
  const exchangedToken = await oauth.exchange(token);
  const outgoing = await oauth.validate(exchangedToken, 'flag-api', 'connector');
  bindSubject(incoming, outgoing);
  const resource = await fetch(`http://127.0.0.1:${resourcePort}/flag`, {
    headers: { Authorization: `Bearer ${exchangedToken}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!resource.ok) throw new Denied(resource.status === 403 ? 403 : 502);
  const data = await resource.json();
  if (typeof data.flag !== 'string' || data.flag.length > 128) throw new Denied(502);
  send(response, 200, { read: true, flagSha256: hash(data.flag), subjectPreserved: true,
    incomingAudience: 'connector', exchangedAudience: 'flag-api', readerBound: outgoing.sub === config.reader.subject });
});
await serve(interactivePort, async (request, response, url) => {
  if (request.method !== 'GET') throw new Denied(405);
  if (url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return response.end('<!doctype html><title>Local OAuth proof</title><h1>Synthetic local OAuth proof</h1><a href="/login">Sign in with local Keycloak</a><p>No Azure or Microsoft identity is used.</p>');
  }
  if (url.pathname === '/login') {
    for (const [key, value] of transactions) if (value.expires <= Date.now()) transactions.delete(key);
    if (transactions.size >= 100) throw new Denied(429);
    const transaction = await oauth.begin();
    const cookie = randomBytes(32).toString('base64url');
    transactions.set(cookie, transaction);
    response.writeHead(302, { Location: transaction.url.href, 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'Set-Cookie': `flow=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=180` });
    return response.end();
  }
  if (url.pathname === '/callback') {
    const transaction = consumeTransaction(transactions, cookieValue(request, 'flow'), url.searchParams.get('state'));
    let tokens;
    try { tokens = await oauth.finish(url, transaction); }
    catch (error) {
      if (error instanceof Denied || error.code?.startsWith('OAUTH_') || error.code?.startsWith('ERR_J')) {
        throw new Denied(400);
      }
      throw error;
    }
    const connector = await fetch(`http://127.0.0.1:${connectorPort}/read`, {
      headers: { Authorization: `Bearer ${tokens.token}` }, signal: AbortSignal.timeout(10_000),
    });
    const data = await connector.json();
    for (const [key, value] of results) if (value.expires <= Date.now()) results.delete(key);
    if (results.size >= 100) throw new Denied(429);
    const id = randomBytes(32).toString('base64url');
    results.set(id, { status: connector.status, data, expires: Date.now() + 180_000 });
    response.writeHead(303, { Location: '/result', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Set-Cookie': [`flow=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        `result=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=180`] });
    return response.end();
  }
  if (url.pathname === '/result') {
    const result = results.get(cookieValue(request, 'result'));
    if (!result || result.expires <= Date.now()) throw new Denied(401);
    return send(response, result.status, result.data);
  }
  throw new Denied(404);
});
await writeFile('.private/server-runtime.json', JSON.stringify({
  ...identity, pid: process.pid, ports, root: import.meta.dirname,
  entrypoint: fileURLToPath(import.meta.url), platform: process.platform,
}, null, 2));
console.log(`Local OAuth proof ready at http://127.0.0.1:${interactivePort} (PID ${process.pid})`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { for (const server of servers) server.close(); });
}
