import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveVerifierBrowser, validateBrowserPolicy } from './verifier_browser.mjs'

const helper = fileURLToPath(new URL('./verifier_browser.mjs', import.meta.url))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const executableName = { win32: 'msedge.exe', linux: 'microsoft-edge', darwin: 'Microsoft Edge' }[process.platform]
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'issue136 spaces-'))
  t.after(() => rm(root, { recursive: true }))
  const workspace = path.join(root, 'task')
  await mkdir(workspace)
  const executable = path.join(root, executableName)
  await writeFile(executable, 'operator-authorized fixture, never executed')
  await chmod(executable, 0o700)
  const policyPath = path.join(root, 'browser-policy.json')
  const policy = { version: 1, host: hostname(), platform: process.platform,
    browser: 'edge', executable, sha256: hash(await readFile(executable)) }
  const save = () => writeFile(policyPath, JSON.stringify(policy))
  await save()
  return { root, workspace, executable, policyPath, policy, save }
}

test('explicit path with spaces is literal, pinned, host-bound and evidenced', async (t) => {
  const f = await fixture(t)
  const result = await resolveVerifierBrowser(f)
  assert.equal(result.launchOptions.executablePath, await realpath(f.executable))
  assert.deepEqual(Object.keys(result.launchOptions).sort(), ['executablePath', 'headless', 'timeout'])
  assert.equal(result.evidence.host, hostname())
  assert.equal(result.evidence.sha256, f.policy.sha256)
  assert.equal(result.evidence.policySha256, hash(await readFile(f.policyPath)))
  assert.equal(result.evidence.selection, 'declared-executable')
})

test('managed Chromium uses only the supplied native path and authorized hash', async (t) => {
  const f = await fixture(t)
  f.policy.browser = 'chromium'
  delete f.policy.executable
  await f.save()
  const managed = path.join(f.root, process.platform === 'win32' ? 'chrome.exe' : process.platform === 'darwin' ? 'Chromium' : 'chrome')
  await writeFile(managed, await readFile(f.executable))
  await chmod(managed, 0o700)
  const selection = await resolveVerifierBrowser({ ...f, chromiumExecutable: managed })
  assert.equal(selection.launchOptions.executablePath, await realpath(managed))
  assert.equal(selection.evidence.selection, 'playwright-managed')
  await assert.rejects(resolveVerifierBrowser(f), /Chromium is unavailable/u)
})

for (const [name, change, error] of [
  ['wrong host', (p) => { p.host += '-other' }, /host\/platform/u],
  ['wrong platform', (p) => { p.platform = 'not-this-platform' }, /host\/platform/u],
  ['unknown version', (p) => { p.version = 2 }, /version/u],
  ['unsupported browser', (p) => { p.browser = 'firefox' }, /only chromium/u],
  ['non-string browser', (p) => { p.browser = { toString: 'edge' } }, /only chromium/u],
  ['prototype browser', (p) => { p.browser = '__proto__' }, /only chromium/u],
  ['shell arguments', (p) => { p.args = ['--no-sandbox'] }, /unknown policy field/u],
  ['missing digest', (p) => { delete p.sha256 }, /SHA-256/u],
  ['bad digest', (p) => { p.sha256 = '0'.repeat(64) }, /differs/u],
  ['relative path', (p) => { p.executable = executableName }, /absolute/u],
  ['unsupported executable', (p) => { p.executable = path.join(path.dirname(p.executable), 'node.exe') }, /supported browser/u],
  ['command instead of path', (p) => { p.executable += ' --headless' }, /not a command/u],
  ['missing installed path', (p) => { delete p.executable }, /requires an explicit/u],
]) {
  test(`reject ${name} without fallback or launch`, async (t) => {
    const f = await fixture(t)
    change(f.policy)
    await f.save()
    await assert.rejects(resolveVerifierBrowser(f), error)
  })
}

test('missing executable and missing policy fail before any launch', async (t) => {
  const f = await fixture(t)
  await rm(f.executable)
  await assert.rejects(resolveVerifierBrowser(f), /ENOENT/u)
  await rm(f.policyPath)
  await assert.rejects(resolveVerifierBrowser(f), /ENOENT/u)
})

test('policy and executable cannot be selected from the task workspace', async (t) => {
  const f = await fixture(t)
  const localPolicy = path.join(f.workspace, 'policy.json')
  await writeFile(localPolicy, JSON.stringify(f.policy))
  await assert.rejects(resolveVerifierBrowser({ ...f, policyPath: localPolicy }), /outside the task workspace/u)
  f.policy.executable = path.join(f.workspace, executableName)
  await writeFile(f.policy.executable, 'bad')
  await f.save()
  await assert.rejects(resolveVerifierBrowser(f), /outside the task workspace/u)
})

test('invalid and oversized policies fail without reflecting their contents', async (t) => {
  const f = await fixture(t)
  await writeFile(f.policyPath, '{"credential-like-value": PRIVATE')
  await assert.rejects(resolveVerifierBrowser(f), (e) => /invalid policy JSON/u.test(e.message) && !e.message.includes('PRIVATE'))
  const valid = JSON.stringify(f.policy)
  await writeFile(f.policyPath, valid + ' '.repeat(8192 - Buffer.byteLength(valid)))
  assert.equal((await resolveVerifierBrowser(f)).evidence.sha256, f.policy.sha256)
  await writeFile(f.policyPath, 'x'.repeat(8193))
  await assert.rejects(resolveVerifierBrowser(f), /8192 bytes/u)
})

test('hard-linked policies and empty browser files are rejected', async (t) => {
  const f = await fixture(t)
  const alias = path.join(f.root, 'policy-link.json')
  await link(f.policyPath, alias)
  await assert.rejects(resolveVerifierBrowser(f), /regular, unlinked file/u)
  await rm(alias)
  await writeFile(f.executable, '')
  await assert.rejects(resolveVerifierBrowser(f), /invalid file size\/type/u)
})

test('declared Windows, Linux and macOS browser paths validate independently', () => {
  for (const [platform, browser, executable] of [
    ['win32', 'chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['win32', 'edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['win32', 'edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\MSEDGE.EXE'],
    ['linux', 'chrome', '/usr/bin/google-chrome'],
    ['linux', 'edge', '/usr/bin/microsoft-edge-stable'],
    ['darwin', 'chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['darwin', 'edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ]) {
    const policy = { version: 1, host: 'owned-test-host', platform, browser, executable, sha256: 'a'.repeat(64) }
    assert.equal(validateBrowserPolicy(policy, platform, 'owned-test-host'), policy)
  }
  assert.throws(() => validateBrowserPolicy({
    version: 1, host: 'h', platform: 'win32', browser: 'edge',
    executable: '\\\\server\\share\\msedge.exe', sha256: 'a'.repeat(64),
  }, 'win32', 'h'), /absolute supported browser/u)
})

test('CLI is quiet on import, outputs exact selection, and fails for invalid input', async (t) => {
  const f = await fixture(t)
  const success = spawnSync(process.execPath, [helper, '--policy', f.policyPath], { cwd: f.workspace, encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).evidence.sha256, f.policy.sha256)
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./verifier_browser.mjs', import.meta.url).href)})`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')
  for (const args of [[], ['--policy'], ['--policy', f.policyPath, '--unknown', 'value']]) {
    const failed = spawnSync(process.execPath, [helper, ...args], { cwd: f.workspace, encoding: 'utf8', timeout: 5000, windowsHide: true })
    assert.equal(failed.status, 1)
    assert.equal(failed.stdout, '')
    assert.match(failed.stderr, /usage:/u)
  }
})

test('CLI preserves an unexpected stdout failure rather than treating it as bad policy', async (t) => {
  const f = await fixture(t)
  const script = `process.argv = ['node', ${JSON.stringify(helper)}, '--policy', ${JSON.stringify(f.policyPath)}];
process.stdout.write = () => { throw new Error('ISSUE136_STDOUT_EIO') };
await import(${JSON.stringify(new URL('./verifier_browser.mjs', import.meta.url).href)});`
  const failed = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: f.workspace, encoding: 'utf8', timeout: 5000, windowsHide: true,
  })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /ISSUE136_STDOUT_EIO/u)
  assert.doesNotMatch(failed.stderr, /Verifier browser:|ERR_UNSUPPORTED_ESM_URL_SCHEME/u)
})
