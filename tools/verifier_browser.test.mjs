import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { chmod, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveVerifierBrowser, validateBrowserPolicy } from './verifier_browser.mjs'

const helper = fileURLToPath(new URL('./verifier_browser.mjs', import.meta.url))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const executableName = { win32: 'msedge.exe', linux: 'microsoft-edge', darwin: 'Microsoft Edge' }[process.platform]
async function fixture(t, retain = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'issue136 spaces-'))
  if (retain) t.diagnostic(`Retained F03 fixture: ${root}`)
  else t.after(() => rm(root, { recursive: true }))
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
  assert.equal(result.launchOptions.executablePath, f.executable)
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
  assert.equal(selection.launchOptions.executablePath, managed)
  assert.equal(selection.evidence.selection, 'playwright-managed')
  await assert.rejects(resolveVerifierBrowser(f), /Chromium is unavailable/u)
})

// No network/device path reaches the OS, even when testing the unfixed resolver.
// Only unreachable path resolution and reads are mocked; policy and pinned bytes are local.
for (const [kind, excluded] of [
  ['UNC', '\\\\f03.invalid\\share\\chrome.exe'],
  ['slash UNC', '//f03.invalid/share/chrome.exe'],
  ['extended UNC', '\\\\?\\UNC\\f03.invalid\\share\\chrome.exe'],
  ['device UNC', '\\\\.\\UNC\\f03.invalid\\share\\chrome.exe'],
  ['extended drive', '\\\\?\\C:\\browser\\chrome.exe'],
  ['device drive', '\\\\.\\C:\\browser\\chrome.exe'],
  ['NT device', '\\??\\UNC\\f03.invalid\\share\\chrome.exe'],
  ['root relative', '\\browser\\chrome.exe'],
  ['drive relative', 'C:browser\\chrome.exe'],
  ['NUL', 'C:\\browser\0\\chrome.exe'],
  ['newline', 'C:\\browser\n\\chrome.exe'],
  ['carriage return', 'C:\\browser\r\\chrome.exe'],
]) {
  for (const route of ['declared', 'managed', 'canonical']) {
    test(`F03 rejects ${route} ${kind} before excluded filesystem access`,
      { skip: process.platform !== 'win32' }, async (t) => {
        const f = await fixture(t, true)
        f.executable = path.join(f.root, 'chrome.exe')
        await writeFile(f.executable, 'operator-authorized fixture, never executed')
        f.policy.browser = 'chromium'
        if (route === 'managed') delete f.policy.executable
        else f.policy.executable = route === 'declared' ? excluded : f.executable
        await f.save()
        const excludedCalls = []
        const native = { realpath: fs.realpath, access: fs.access, open: fs.open, lstat: fs.lstat }
        for (const operation of Object.keys(native)) {
          t.mock.method(fs, operation, async (file, ...args) => {
            if (file === excluded) {
              excludedCalls.push(operation)
              // Model matching authorized bytes without contacting any share/device.
              return operation === 'realpath' ? excluded : native[operation](f.executable, ...args)
            }
            assert.ok([f.workspace, f.policyPath, f.executable].includes(file),
              `Unexpected ${operation} path in F03 mock: ${file}`)
            if (operation === 'realpath' && route === 'canonical' && file === f.executable) return excluded
            return native[operation](file, ...args)
          })
        }
        syncBuiltinESMExports()
        t.after(() => {
          t.mock.restoreAll()
          syncBuiltinESMExports()
          t.diagnostic(`Intercepted excluded operations: ${JSON.stringify(excludedCalls)}`)
        })
        await assert.rejects(resolveVerifierBrowser({ ...f, chromiumExecutable: excluded }),
          /absolute supported browser|Chromium is unavailable|resolved target is not a supported browser/u)
        assert.deepEqual(excludedCalls, [], 'Reject before resolving or reading excluded paths')
      })
  }
}

for (const route of ['declared', 'managed']) {
  test(`F03 preserves ${route} local paths, hard links and canonical directory links`, async (t) => {
    const f = await fixture(t, true)
    const installation = path.join(f.root, 'local browser')
    await mkdir(installation)
    const name = process.platform === 'win32' ? 'chrome.exe' : process.platform === 'darwin' ? 'Chromium' : 'chrome'
    const executable = path.join(installation, name)
    await writeFile(executable, await readFile(f.executable))
    await chmod(executable, 0o700)
    const alias = path.join(f.root, 'local link')
    await symlink(installation, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const hardlink = path.join(f.root, name)
    await link(executable, hardlink)
    f.policy.browser = 'chromium'
    for (const [selected, canonical] of [
      [executable, executable], [hardlink, hardlink], [path.join(alias, name), executable],
    ]) {
      if (route === 'declared') f.policy.executable = selected
      else delete f.policy.executable
      await f.save()
      const result = await resolveVerifierBrowser({ ...f, chromiumExecutable: selected })
      assert.equal(result.launchOptions.executablePath, canonical)
      assert.equal(result.evidence.sha256, f.policy.sha256)
      assert.equal(result.evidence.selection, route === 'declared' ? 'declared-executable' : 'playwright-managed')
    }
    // A legitimate local link must not bypass canonical workspace containment.
    const workspaceExecutable = path.join(f.workspace, name)
    await writeFile(workspaceExecutable, await readFile(executable))
    const workspaceAlias = path.join(f.root, 'workspace link')
    await symlink(f.workspace, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir')
    const selected = path.join(workspaceAlias, name)
    if (route === 'declared') f.policy.executable = selected
    await f.save()
    await assert.rejects(resolveVerifierBrowser({ ...f, chromiumExecutable: selected }), /outside the task workspace/u)
  })
}

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
  const success = spawnSync(process.execPath, [helper, '--policy', f.policyPath], { cwd: f.workspace, encoding: 'utf8', timeout: 5000 })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).evidence.sha256, f.policy.sha256)
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./verifier_browser.mjs', import.meta.url).href)})`], { encoding: 'utf8', timeout: 5000 })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')
  for (const args of [[], ['--policy'], ['--policy', f.policyPath, '--unknown', 'value']]) {
    const failed = spawnSync(process.execPath, [helper, ...args], { cwd: f.workspace, encoding: 'utf8', timeout: 5000 })
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
    cwd: f.workspace, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /ISSUE136_STDOUT_EIO/u)
  assert.doesNotMatch(failed.stderr, /Verifier browser:|ERR_UNSUPPORTED_ESM_URL_SCHEME/u)
})
