import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  browserRequestGuard, loadResearchQa, qaOrigin, researchCase, researchDemo, validateResearchQa,
} from './research_handoff_browser.mjs'

// Contract/source tests only. No browser, services, database or inference is started.
const server = 'http://127.0.0.1:18973'
const web = 'http://127.0.0.1:15498'
const corpId = '00000000-0000-4000-8000-000000000001'
const actorId = '00000000-0000-4000-8000-000000000011'
const missionId = '00000000-0000-4000-8000-000000000099'
const sha = 'a'.repeat(64)
const assets = { '/': sha, '/assets/index-test.js': sha }
const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
const binary = path.join(sourceRoot, 'target', 'debug', 'crony-server.exe')
const manifest = {
  test_owned: true, workspace: sourceRoot, server_url: server, server: 42,
  server_creation: '2026-09-17T15:00:00.000Z',
}
const context = () => ({
  schema_version: 1, issue: 297, state: 'candidate_ready', test_owned: true,
  fixture: { ...researchDemo },
  head: 'b'.repeat(40), files_sha256: sha,
  source: { repository: 'all-the-vibes/ecorp', base_ref: 'test-branch', base_commit: 'b'.repeat(40) },
  server: { url: server, binary, sha256: sha, manifest },
  runner: { id: missionId, binary, sha256: sha, manifest },
  web: { url: web, assets },
})
const guard = () => browserRequestGuard({ server, web, corpId, actorId, missionId, assets })
const launch = `${server}/api/corps/${corpId}/missions/${missionId}/launch`
const launchBody = JSON.stringify({ requested_by: actorId })

test('named case is strict, opted in, and never falls back to the API/unit lane', () => {
  assert.equal(researchCase([]), null)
  assert.equal(researchCase(['--case', 'browser-consumption', '--require-owned-qa']), 'browser-consumption')
  assert.equal(researchCase(['--require-owned-qa', '--case', 'browser-consumption']), 'browser-consumption')
  for (const args of [
    ['--case', 'unknown', '--require-owned-qa'], ['--case', 'browser-consumption'],
    ['--require-owned-qa'], ['--case', 'browser-consumption', '--require-owned-qa', '--dry-run'],
    ['--case', 'browser-consumption', '--require-owned-qa', '--case', 'browser-consumption'],
    ['browser-consumption'],
  ]) assert.throws(() => researchCase(args))
  assert.throws(() => researchCase(['--case', 'adversarial', '--require-owned-qa']),
    /not implemented.*no unit-test fallback/)
})

test('only canonical credential-free owned QA high ports are admitted', () => {
  assert.equal(qaOrigin(server), server)
  for (const value of [
    undefined, 'not a url', 'http://example.com:18973', 'http://0.0.0.0:18973',
    'https://127.0.0.1:18973', 'http://127.0.0.1:8791', 'http://127.0.0.1:15191',
    'http://127.0.0.1:15491', 'http://127.0.0.1:18962', `${server}/`,
    `${server}/other`, `${server}?token=synthetic`, `${server}#fragment`,
    'http://synthetic:synthetic@127.0.0.1:18973',
  ]) assert.throws(() => qaOrigin(value))
})

test('QA schema requires candidate state, source and all process/web pins', () => {
  assert.equal(validateResearchQa(context()).issue, 297)
  for (const change of [
    { state: 'awaiting_candidate' }, { test_owned: false }, { schema_version: 2 },
    { issue: 282 }, { files_sha256: '' }, { head: 'main' },
    { fixture: { ...researchDemo, corp_id: missionId } },
    { source: { ...context().source, base_commit: 'c'.repeat(40) } },
    { source: { ...context().source, repository: 'not a repository' } },
    { server: { ...context().server, sha256: '' } },
    { runner: { ...context().runner, id: 'runner' } },
    { runner: { ...context().runner, binary: 'relative.exe' } },
    { runner: { ...context().runner, manifest: { test_owned: false } } },
    { web: { url: server, assets } }, { web: { url: web, assets: {} } },
    { web: { url: web, assets: { '/': sha } } },
    { web: { url: web, assets: { ...assets, '/@vite/client': sha } } },
    { web: { url: web, assets: { ...assets, '/assets/../escape.js': sha } } },
    { DATABASE_URL: 'synthetic-not-a-connection' },
  ]) assert.throws(() => validateResearchQa({ ...context(), ...change }))
})

test('browser guard permits native reads and only the armed exact launch once', () => {
  const gate = guard()
  assert.equal(gate.allow(`${web}/`, 'GET', null, 'document'), true)
  assert.equal(gate.allow(`${web}/assets/index-test.js`, 'GET', null, 'script'), true)
  assert.equal(gate.allow(`${server}/health`, 'GET'), true)
  assert.equal(gate.allow(`${server}/api/corps/${corpId}/snapshot?actor_id=${actorId}`, 'GET'), true)
  assert.equal(gate.allow(launch, 'POST', launchBody), false)
  gate.arm()
  assert.equal(gate.allow(launch, 'POST', launchBody), true)
  assert.equal(gate.launches, 1)
  assert.equal(gate.allow(launch, 'POST', launchBody), false)
  assert.throws(() => gate.arm())
})

test('negative browser routes cannot widen authority or consume the authorized launch', () => {
  const gate = guard()
  gate.arm()
  for (const [url, method, body, resource] of [
    [launch, 'POST', JSON.stringify({ requested_by: missionId })],
    [launch, 'POST', JSON.stringify({ requested_by: actorId, approved: true })],
    [launch.replace(missionId, actorId), 'POST', launchBody],
    [`${launch}?retry=true`, 'POST', launchBody],
    [launch.replace(server, web), 'POST', launchBody],
    [`${server}/api/corps/${corpId}/missions`, 'POST', '{}'],
    [`${server}/api/corps/${corpId}/factory/reconcile`, 'POST', '{}'],
    [`${server}/api/corps/${corpId}/runs/${missionId}/verification-decision`, 'POST', '{}'],
    [`${server}/api/corps/${missionId}/snapshot?actor_id=${actorId}`, 'GET'],
    [`${server}/api/corps/${corpId}/snapshot?actor_id=${missionId}`, 'GET'],
    [`${web}/assets/unpinned.js`, 'GET', null, 'script'],
    [`${web}/@vite/client`, 'GET', null, 'script'],
    ['https://example.com/collect', 'GET'],
    [launch, 'DELETE'],
  ]) assert.equal(gate.allow(url, method, body, resource), false)
  assert.equal(gate.launches, 0)
  assert.equal(gate.allow(launch, 'POST', launchBody), true)
})

test('only two existing demo handshakes are allowed, never reset or seeded crew', () => {
  const gate = guard()
  const url = `${server}/api/demo/bootstrap?seed_crew=false`
  assert.equal(gate.allow(url, 'OPTIONS'), true)
  assert.equal(gate.allow(`${server}/api/demo/bootstrap`, 'POST', '{}'), false)
  assert.equal(gate.allow(url.replace('false', 'true'), 'POST', '{}'), false)
  assert.equal(gate.allow(url, 'POST', '{"reset":true}'), false)
  assert.equal(gate.allow(url, 'POST', '{}'), true)
  assert.equal(gate.allow(url, 'POST', '{}'), true)
  assert.equal(gate.allow(url, 'POST', '{}'), false)
})

test('context admission rejects setup and real source mismatches before live-process inspection', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'issue297-context-contract-'))
  let passed = false
  t.after(async () => {
    if (passed) await rm(directory, { recursive: true })
    else console.error(`Preserved failed QA contract fixture: ${directory}`)
  })
  await assert.rejects(loadResearchQa({}), /ECORP_ISSUE297_QA_CONTEXT/)
  const file = path.join(directory, 'context.json')
  await writeFile(file, '{"secret":"synthetic"')
  const environment = { ECORP_ISSUE297_QA_CONTEXT: file, CRONY_SERVER_HTTP: server }
  await assert.rejects(loadResearchQa(environment), /^Error: Invalid QA JSON$/)
  await writeFile(file, JSON.stringify({ ...context(), state: 'awaiting_candidate' }))
  await assert.rejects(loadResearchQa(environment), /candidate_ready/)
  await writeFile(file, JSON.stringify(context()))
  await assert.rejects(loadResearchQa({ ...environment, CRONY_SERVER_HTTP: web }), /API environment differs/)
  await assert.rejects(loadResearchQa(environment), /Candidate source changed/,
    'A candidate-ready label with the wrong actual checkout pins must fail before live-process inspection')
  passed = true
})

test('real CLI fails without owned context and does not create output or start browser', async () => {
  const script = fileURLToPath(new URL('./e2e_research_handoff.mjs', import.meta.url))
  const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]))
  for (const [name, reason] of [
    ['browser-consumption', /ECORP_ISSUE297_QA_CONTEXT/],
    ['adversarial', /not implemented/], ['unknown', /Unknown research handoff case/],
  ]) {
    const child = spawnSync(process.execPath, [script, '--case', name, '--require-owned-qa'], {
      env: { ...environment, CRONY_RESEARCH_HANDOFF_TEST: '1' },
      timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(child.error, undefined)
    assert.equal(child.status, 1)
    assert.equal(child.stdout, '')
    const failure = JSON.parse(child.stderr.trim())
    assert.equal(failure.phase, 'failed')
    assert.equal(failure.checkpoint, null)
    assert.match(failure.error, reason)
  }
})

test('browser controls and download selectors remain grounded in the checked-in App', async () => {
  const source = await readFile(path.join(sourceRoot, 'apps', 'web', 'src', 'App.tsx'), 'utf8')
  for (const required of [
    'data-mission-id={mission.id}', 'data-testid="provider-evidence"',
    'data-artifact-id={evidenceRun.artifact_id}', 'Download verified artifact',
    'JSON.stringify({ requested_by: selectedActor.id })', "document.createElement('a')",
  ]) assert.ok(source.includes(required), `App contract changed: ${required}`)
  const implementation = await readFile(new URL('./research_handoff_browser.mjs', import.meta.url), 'utf8')
  for (const prohibited of ['route.fulfill(', 'addInitScript(', 'page.evaluate(', 'restartOwnedTestServer(']) {
    assert.equal(implementation.includes(prohibited), false, 'Browser case must not synthesize responses/state or restart services')
  }
})
