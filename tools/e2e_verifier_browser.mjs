// Opt-in native browser verifier fixture; never use a retained application worktree.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveVerifierBrowser } from './verifier_browser.mjs'

const workspaceInput = process.env.CRONY_BROWSER_TEST_WORKTREE
const outputInput = process.env.CRONY_BROWSER_TEST_OUTPUT
assert.ok(workspaceInput && path.isAbsolute(workspaceInput), 'Explicit owned worktree required')
assert.ok(outputInput && path.isAbsolute(outputInput), 'Explicit evidence output required')
const workspace = await realpath(workspaceInput)
assert.ok((await lstat(path.join(workspace, '.git'))).isFile(), 'A separate Git worktree is required')
const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim()
assert.equal(await realpath(gitRoot), workspace)
await mkdir(outputInput, { recursive: true })
const outputRoot = await realpath(outputInput)
const relative = path.relative(workspace, outputRoot)
assert.ok(path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`), 'Evidence must be outside the worktree')
const output = await mkdtemp(path.join(outputRoot, 'native-browser-'))
const modulePath = process.env.CRONY_PLAYWRIGHT_MODULE
assert.ok(modulePath && path.isAbsolute(modulePath), 'Installed Playwright module required')
const { chromium } = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href)
const selection = await resolveVerifierBrowser({
  policyPath: process.env.CRONY_VERIFIER_BROWSER_POLICY,
  chromiumExecutable: chromium.executablePath(), workspace,
})
const fixtureName = `issue136-fixture-${randomUUID()}`
const fixture = path.join(workspace, fixtureName)
const verifier = fileURLToPath(new URL('./verify_arcade_browser.mjs', import.meta.url))
const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Verifier fixture</title>
<style>body{font-family:Segoe UI,sans-serif;margin:16px}button{padding:8px;margin:4px}</style>
<h1>Deterministic verifier fixture</h1><p data-testid="game-state">ready</p>
<button id="start">Start</button><button id="pause">Pause</button>
<button id="resume">Resume</button><button id="restart">Restart</button>
<script>for(const [id,state] of Object.entries({start:'playing',pause:'paused',resume:'playing',restart:'ready'}))
document.getElementById(id).onclick=()=>document.querySelector('[data-testid="game-state"]').textContent=state;</script></html>`
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const result = { passed: false, scope: 'Actual browser and arcade command verifier, not ECorp full-stack acceptance',
  fixture, selection: selection.evidence, children: [], negative: [], reports: [], sourceUnchanged: false }
async function recordChild(name, child) {
  result.children.push({ name, exitCode: child.status, signal: child.signal, error: child.error?.message })
  // Keep the first copy with the artifacts if output retention itself fails.
  for (const directory of [fixture, output]) {
    await writeFile(path.join(directory, `${name}.stdout.log`), child.stdout ?? '')
    await writeFile(path.join(directory, `${name}.stderr.log`), child.stderr ?? '')
  }
}
await mkdir(fixture)
try {
  await writeFile(path.join(fixture, 'index.html'), html, { flag: 'wx' })
  const original = JSON.parse(await readFile(process.env.CRONY_VERIFIER_BROWSER_POLICY, 'utf8'))
  for (const [name, policy] of [
    ['wrong-hash', { ...original, sha256: '0'.repeat(64) }],
    ['wrong-host', { ...original, host: `${original.host}-not-this-host` }],
    ['missing-executable', { ...original, executable: path.join(output, path.basename(selection.evidence.executable)) }],
  ]) {
    const policyPath = path.join(output, `${name}.json`)
    await writeFile(policyPath, JSON.stringify(policy), { flag: 'wx' })
    const failed = spawnSync(process.execPath, [verifier, fixtureName], {
      cwd: workspace, encoding: 'utf8', timeout: 120_000, windowsHide: true,
      env: { ...process.env, CRONY_VERIFIER_BROWSER_POLICY: policyPath },
    })
    await recordChild(name, failed)
    assert.ifError(failed.error)
    assert.notEqual(failed.status, 0, name)
    assert.equal(failed.stdout, '')
    assert.match(failed.stderr, name === 'wrong-hash' ? /SHA-256 differs/u :
      name === 'wrong-host' ? /host\/platform/u : /ENOENT/u)
    await assert.rejects(lstat(path.join(fixture, 'evidence')), { code: 'ENOENT' })
    result.negative.push({ name, exitCode: failed.status, noEvidenceWrites: true })
  }
  for (const mode of ['module', 'cli-selection']) {
    // The CLI is the same language-neutral preflight consumed by Python verifiers.
    if (mode === 'cli-selection') {
      const helper = fileURLToPath(new URL('./verifier_browser.mjs', import.meta.url))
      const nativePathArgs = original.executable === undefined ? ['--chromium-executable', chromium.executablePath()] : []
      const cli = spawnSync(process.execPath, [helper, '--policy', process.env.CRONY_VERIFIER_BROWSER_POLICY, ...nativePathArgs], {
        cwd: workspace, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      })
      await recordChild('cli-selection-preflight', cli)
      assert.ifError(cli.error)
      assert.equal(cli.status, 0, cli.stderr)
      assert.deepEqual(JSON.parse(cli.stdout), selection)
    }
    const run = spawnSync(process.execPath, [verifier, fixtureName], {
      cwd: workspace, encoding: 'utf8', timeout: 120_000, windowsHide: true, env: process.env,
    })
    await recordChild(mode, run)
    assert.ifError(run.error)
    assert.equal(run.status, 0, run.stderr)
    const report = JSON.parse(await readFile(path.join(fixture, 'evidence', 'browser-verification.json'), 'utf8'))
    assert.equal(report.passed, true)
    assert.deepEqual(report.cases.map(({ name, width }) => [name, width]), [['desktop', 1280], ['mobile', 390]])
    assert.equal(report.browser.sha256, selection.evidence.sha256)
    assert.equal(report.browser.policySha256, selection.evidence.policySha256)
    assert.ok(report.browser.browserVersion)
    assert.ok(report.cases.every((item) => item.remoteRequestCount === 0 && item.errors.length === 0))
    for (const screenshot of report.screenshots) {
      const bytes = await readFile(path.join(workspace, screenshot.path))
      assert.equal(hash(bytes), screenshot.sha256)
      assert.equal(bytes.length, screenshot.bytes)
    }
    await cp(path.join(fixture, 'evidence'), path.join(output, mode), { recursive: true, force: false, errorOnExist: true })
    result.reports.push({ mode, browser: report.browser, cases: report.cases.map(({ name }) => name) })
  }
  assert.equal(await readFile(path.join(fixture, 'index.html'), 'utf8'), html)
  result.sourceUnchanged = true
  result.passed = true
} catch (error) {
  result.error = error.stack ?? String(error)
}
try {
  await writeFile(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  // Failed runs (including failed copies) retain the original artifact bytes.
  if (result.passed) {
    assert.equal(await realpath(fixture), fixture)
    assert.ok((await lstat(fixture)).isDirectory(), 'Only the newly created fixture may be removed')
    await rm(fixture, { recursive: true })
  }
} catch (error) {
  result.passed = false
  result.retentionError = error.stack ?? String(error)
}
if (!result.passed) {
  process.exitCode = 1
  console.error(`Failed fixture retained: ${fixture}\nEvidence output: ${output}\n${result.error ?? ''}\n${result.retentionError ?? ''}`)
  await writeFile(path.join(fixture, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  try {
    await writeFile(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    console.error(`Failed summary remains in ${fixture}: ${error.message}`)
  }
}
console.log(JSON.stringify({ output, ...result }))
