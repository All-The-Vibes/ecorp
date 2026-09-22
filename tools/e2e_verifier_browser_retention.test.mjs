// Driver-only fault injection: synthetic artifact bytes, NOT browser captures.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const source = path.dirname(fileURLToPath(import.meta.url))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const osEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|TMPDIR)$/iu.test(key)))

// Only Git's worktree read is simulated. There are no Git writes or live worktrees.
// Verifier children are real Node processes with synthetic reports/images.
const preload = `
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const nativeSpawn = childProcess.spawnSync
childProcess.execFileSync = (command, args, options) => {
  if (command !== 'git' || args.join(' ') !== 'rev-parse --show-toplevel') throw new Error('Unexpected Git call')
  return options.cwd
}
childProcess.spawnSync = (command, args, options) => {
  const startedAt = new Date().toISOString()
  const run = nativeSpawn(command, [process.env.F02_CHILD, ...args], options)
  const name = path.basename(options.env?.CRONY_VERIFIER_BROWSER_POLICY ?? '').replace('.json', '') ||
    'cli'
  writeFileSync(path.join(process.env.F02_ROOT, 'child-' + name + '-' + Date.now() + '.json'),
    JSON.stringify({ command, args, cwd: options.cwd, startedAt, finishedAt: new Date().toISOString(),
      exitCode: run.status, signal: run.signal, error: run.error?.message, stdout: run.stdout, stderr: run.stderr }))
  return run
}
syncBuiltinESMExports()
`

const child = `
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const root = process.env.F02_ROOT
const scenario = process.env.F02_SCENARIO
const policyPath = process.env.CRONY_VERIFIER_BROWSER_POLICY
const negative = path.basename(policyPath).replace('.json', '')
if (process.argv[2].endsWith('verifier_browser.mjs') && !process.argv[2].endsWith('verify_arcade_browser.mjs')) {
  if (scenario === 'cli-failure') {
    console.log('F02 cli stdout'); console.error('F02 cli stderr'); process.exitCode = 9
  } else {
    console.log(await readFile(path.join(root, 'selection.json'), 'utf8'))
  }
} else if (negative !== 'policy') {
  if (scenario === 'negative-failure') {
    console.log('F02 negative stdout'); console.error('F02 negative stderr'); process.exitCode = 7
  } else {
    console.error(negative === 'wrong-hash' ? 'SHA-256 differs' :
      negative === 'wrong-host' ? 'host/platform' : 'ENOENT')
    process.exitCode = 1
  }
} else {
  const fixture = path.join(process.cwd(), process.argv[3])
  const evidence = path.join(fixture, 'evidence')
  const sequence = (await readdir(root)).filter(name => name.startsWith('expected-')).length
  const expected = path.join(root, 'expected-' + sequence)
  await mkdir(evidence, { recursive: true }); await mkdir(expected)
  const failed = scenario === 'late-failure'
  const selection = JSON.parse(await readFile(path.join(root, 'selection.json'), 'utf8'))
  const report = { passed: !failed, browser: { ...selection.evidence, browserVersion: 'synthetic-no-browser' },
    cases: [], screenshots: [], errors: failed ? ['F02 late mobile failure'] : [] }
  for (const [name, width] of failed ? [['desktop', 1280]] : [['desktop', 1280], ['mobile', 390]]) {
    const bytes = Buffer.from('F02 synthetic NOT PNG capture: ' + name + ' run ' + sequence)
    for (const directory of [evidence, expected]) await writeFile(path.join(directory, name + '.png'), bytes)
    report.cases.push({ name, width, remoteRequestCount: 0, errors: [] })
    report.screenshots.push({ path: process.argv[3] + '/evidence/' + name + '.png', sha256: hash(bytes), bytes: bytes.length })
  }
  for (const directory of [evidence, expected]) {
    await writeFile(path.join(directory, 'browser-verification.json'), JSON.stringify(report))
  }
  // Native filesystem collisions, not a mocked cp/writeFile rejection.
  const [outputName] = await readdir(process.env.CRONY_BROWSER_TEST_OUTPUT)
  const output = path.join(process.env.CRONY_BROWSER_TEST_OUTPUT, outputName)
  if (scenario === 'copy-failure') await writeFile(path.join(output, 'module'), 'F02 occupied target')
  if (scenario === 'stream-retention-failure') await mkdir(path.join(output, 'module.stdout.log'))
  if (scenario === 'summary-retention-failure') await mkdir(path.join(output, 'result.json'), { recursive: true })
  console.log('F02 verifier stdout ' + sequence)
  console.error(failed ? 'F02 late mobile failure' : 'F02 verifier stderr ' + sequence)
  process.exitCode = failed ? 23 : 0
}
`

for (const scenario of ['late-failure', 'copy-failure', 'stream-retention-failure',
  'negative-failure', 'cli-failure', 'summary-retention-failure', 'success']) {
  test(`driver evidence retention: ${scenario}`, async (t) => {
    const parent = process.env.F02_RECEIPTS ?? tmpdir()
    const root = await mkdtemp(path.join(parent, `F02-${scenario}-`))
    t.diagnostic(`Retained synthetic fixture and receipts: ${root}`)
    const workspace = path.join(root, 'workspace')
    const tools = path.join(root, 'tools')
    const outputRoot = path.join(root, 'output')
    const modulePath = path.join(root, 'playwright')
    for (const directory of [workspace, tools, outputRoot, modulePath]) await mkdir(directory)
    await writeFile(path.join(workspace, '.git'), 'synthetic worktree marker; Git read stubbed')
    const sourceHashes = {}
    for (const name of ['e2e_verifier_browser.mjs', 'verifier_browser.mjs']) {
      await copyFile(path.join(source, name), path.join(tools, name))
      sourceHashes[name] = hash(await readFile(path.join(tools, name)))
    }
    const executable = path.join(root, {
      win32: 'msedge.exe', linux: 'microsoft-edge', darwin: 'Microsoft Edge',
    }[process.platform])
    await writeFile(executable, 'F02 synthetic executable pin, NEVER executed')
    await chmod(executable, 0o700)
    const policyPath = path.join(root, 'policy.json')
    const policy = { version: 1, host: hostname(), platform: process.platform,
      browser: 'edge', executable, sha256: hash(await readFile(executable)) }
    await writeFile(policyPath, JSON.stringify(policy))
    const selection = { launchOptions: { executablePath: executable, headless: true, timeout: 30_000 },
      evidence: { schemaVersion: 1, host: hostname(), platform: process.platform, browser: 'edge',
        selection: 'declared-executable', executable, sha256: policy.sha256,
        policySha256: hash(await readFile(policyPath)) } }
    await writeFile(path.join(root, 'selection.json'), JSON.stringify(selection))
    await writeFile(path.join(modulePath, 'index.mjs'),
      `export const chromium = { executablePath: () => ${JSON.stringify(executable)} }\n`)
    const preloadPath = path.join(root, 'preload.mjs')
    const childPath = path.join(root, 'child.mjs')
    await writeFile(preloadPath, preload)
    await writeFile(childPath, child)
    const args = ['--import', pathToFileURL(preloadPath).href, path.join(tools, 'e2e_verifier_browser.mjs')]
    const startedAt = new Date().toISOString()
    const run = spawnSync(process.execPath, args, {
      cwd: workspace, encoding: 'utf8', timeout: 30_000,
      env: { ...osEnvironment, F02_ROOT: root, F02_CHILD: childPath, F02_SCENARIO: scenario,
        CRONY_BROWSER_TEST_WORKTREE: workspace, CRONY_BROWSER_TEST_OUTPUT: outputRoot,
        CRONY_PLAYWRIGHT_MODULE: modulePath, CRONY_VERIFIER_BROWSER_POLICY: policyPath },
    })
    await writeFile(path.join(root, 'driver.stdout.log'), run.stdout ?? '')
    await writeFile(path.join(root, 'driver.stderr.log'), run.stderr ?? '')
    await writeFile(path.join(root, 'execution.json'), JSON.stringify({
      command: [process.execPath, ...args], cwd: workspace, startedAt, finishedAt: new Date().toISOString(),
      exitCode: run.status, signal: run.signal, error: run.error?.message, sourceHashes,
      testSha256: hash(await readFile(fileURLToPath(import.meta.url))),
      artifactScope: 'Synthetic byte fixtures, no actual browser launched. All files retained; no test cleanup.',
    }, null, 2))
    assert.ifError(run.error)
    const [outputName] = await readdir(outputRoot)
    assert.ok(outputName, `Driver did not reach the fixture: ${run.stderr}`)
    const output = path.join(outputRoot, outputName)
    const fixtures = (await readdir(workspace)).filter(name => name.startsWith('issue136-fixture-'))
    if (scenario === 'success') {
      assert.equal(run.status, 0, run.stderr)
      assert.deepEqual(fixtures, [], 'Only successful fixtures may be removed')
      assert.equal(JSON.parse(await readFile(path.join(output, 'result.json'))).passed, true)
      for (const [sequence, mode] of ['module', 'cli-selection'].entries()) {
        for (const name of await readdir(path.join(root, `expected-${sequence}`))) {
          assert.deepEqual(await readFile(path.join(output, mode, name)),
            await readFile(path.join(root, `expected-${sequence}`, name)))
        }
      }
      return
    }
    assert.equal(run.status, 1, run.stderr)
    assert.equal(fixtures.length, 1, 'Failed driver must preserve its original fixture')
    const fixture = path.join(workspace, fixtures[0])
    assert.ok(run.stderr.includes(fixture), 'Failure must locate the retained fixture')
    const result = JSON.parse(await readFile(path.join(fixture, 'result.json')))
    assert.equal(result.passed, false)
    if (scenario !== 'negative-failure') {
      const expectedNames = (await readdir(root)).filter(name => name.startsWith('expected-')).sort()
      const expected = path.join(root, expectedNames.at(-1))
      for (const name of await readdir(expected)) {
        assert.deepEqual(await readFile(path.join(fixture, 'evidence', name)), await readFile(path.join(expected, name)))
      }
    }
    const name = scenario === 'negative-failure' ? 'wrong-hash' :
      scenario === 'cli-failure' ? 'cli-selection-preflight' : 'module'
    const stdout = await readFile(path.join(fixture, `${name}.stdout.log`), 'utf8')
    const stderr = await readFile(path.join(fixture, `${name}.stderr.log`), 'utf8')
    assert.match(stdout, /F02 .* stdout/u)
    assert.match(stderr, /F02 /u)
    const expectedExit = scenario === 'late-failure' ? 23 :
      scenario === 'negative-failure' ? 7 : scenario === 'cli-failure' ? 9 : 0
    assert.equal(result.children.find(child => child.name === name).exitCode, expectedExit)
    assert.ok((await stat(path.join(fixture, 'index.html'))).isFile())
  })
}
