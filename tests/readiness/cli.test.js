// Black-box tests of the actual validation CLI; fixture counts are not product-test counts.
const assert = require('node:assert/strict')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const source = path.resolve(__dirname, '../..')

function fixture(t, testBody = "import test from 'node:test'; test('owned fixture', () => {})") {
  const root = mkdtempSync(path.join(tmpdir(), 'ecorp-readiness-cli-'))
  t.after(() => {
    const relative = path.relative(tmpdir(), root)
    assert.ok(relative.startsWith('ecorp-readiness-cli-') && !relative.includes(path.sep))
    rmSync(root, { recursive: true })
  })
  for (const directory of ['tools', 'docs']) mkdirSync(path.join(root, directory))
  for (const file of ['tools/run_checks.mjs', 'tools/check_docs.mjs', 'test.config.json', 'package.json', '.node-version', 'rust-toolchain.toml', 'docs/VALIDATION.md']) {
    copyFileSync(path.join(source, file), path.join(root, file))
  }
  writeFileSync(path.join(root, '.gitignore'), 'output/\n')
  writeFileSync(path.join(root, 'tools/fixture.test.mjs'), testBody)
  writeFileSync(path.join(root, 'tools/check_migrations.mjs'), "console.error('synthetic gate rejection'); process.exit(1)")
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['-c', 'user.name=Readiness CLI fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'isolated test fixture'])
  const childEnvironment = { ...process.env }
  // Each black-box invocation is a new CLI, not a nested Node test worker.
  delete childEnvironment.NODE_TEST_CONTEXT
  return { root, git, invoke: (args, maxBuffer = 1024 * 1024) => spawnSync(process.execPath, ['tools/run_checks.mjs', ...args], { cwd: root, env: childEnvironment, encoding: 'utf8', timeout: 20000, maxBuffer }) }
}

function receipt(root) {
  const directory = path.join(root, 'output/readiness')
  const files = readdirSync(directory).filter(file => file.endsWith('.json'))
  assert.equal(files.length, 1)
  return JSON.parse(readFileSync(path.join(directory, files[0]), 'utf8'))
}

test('dry run executes no checks, creates no receipt and leaves source unchanged', t => {
  const f = fixture(t), before = f.git(['status', '--porcelain'])
  const result = f.invoke(['--group', 'full', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.dry_run, true)
  assert.deepEqual(preview.writes, [])
  assert.equal(preview.checks.length, 9)
  assert.equal(f.git(['status', '--porcelain']), before)
  assert.ok(!readdirSync(f.root).includes('output'))
})
test('unknown arguments cannot become commands', t => {
  const f = fixture(t)
  const result = f.invoke(['--group', 'node', '--anything'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage:/)
  assert.ok(!readdirSync(f.root).includes('output'))
})
test('successful native tests produce observed counts and stable-source evidence', t => {
  const f = fixture(t, "import test from 'node:test'; test('owned fixture', t => t.diagnostic('successful noise ' + 'x'.repeat(6000)))")
  const result = f.invoke(['--group', 'node'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /# pass 1/)
  assert.doesNotMatch(result.stdout, /successful noise|owned fixture/)
  assert.ok(result.stdout.length < 1000)
  const report = receipt(f.root)
  assert.equal(report.status, 'passed')
  assert.equal(report.sourceChangedDuringValidation, false)
  assert.equal(report.checks[0].counts.node.passed, 1)
  assert.equal(report.checks[0].counts.node.cancelled, 0)
  assert.deepEqual(report.notRun, [])
})
test('failing Node tests retain TAP diagnostics and complete long assertions', t => {
  const markers = ['F01_CONSOLE_CONTEXT', 'F01_TAP_DIAGNOSTIC', 'F01_ASSERTION_TAIL']
  const f = fixture(t, `
    import test from 'node:test'
    import assert from 'node:assert/strict'
    test('diagnostic failure', t => {
      console.log('${markers[0]}')
      t.diagnostic('${markers[1]}')
      assert.fail('x'.repeat(6000) + '${markers[2]}')
    })
  `)
  const result = f.invoke(['--group', 'node'])
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.deepEqual(markers.filter(marker => !result.stdout.includes(marker)), [])
  assert.ok(result.stdout.includes('x'.repeat(6000) + markers[2]))
  const report = receipt(f.root)
  assert.equal(report.status, 'failed')
  assert.equal(report.sourceChangedDuringValidation, false)
  assert.equal(report.checks[0].exitCode, 1)
  assert.equal(report.checks[0].passed, false)
  assert.equal(report.checks[0].counts.node.failed, 1)
  assert.equal(report.checks[0].errorCode, null)
})
test('failing gates retain complete stdout and stderr beyond the compact limit', t => {
  const f = fixture(t)
  const stdout = 'F01_STDOUT_START' + 'o'.repeat(20000) + 'F01_STDOUT_TAIL\n'
  const stderr = 'F01_STDERR_START' + 'e'.repeat(20000) + 'F01_STDERR_TAIL\n'
  writeFileSync(path.join(f.root, 'tools/check_migrations.mjs'), `
    import { writeSync } from 'node:fs'
    writeSync(1, ${JSON.stringify(stdout)})
    writeSync(2, ${JSON.stringify(stderr)})
    process.exitCode = 7
  `)
  const result = f.invoke(['--group', 'fast'])
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes(stdout))
  assert.ok(result.stderr.endsWith('F01_STDERR_TAIL\n'))
  assert.equal(result.stderr, stderr)
  const report = receipt(f.root)
  assert.equal(report.status, 'failed')
  assert.equal(report.checks[0].exitCode, 7)
  assert.equal(report.checks[0].passed, false)
  assert.deepEqual(report.notRun, ['docs', 'repository-docs', 'format'])
})
test('native capture overflow is disclosed and remains failed evidence', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, 'tools/check_migrations.mjs'), `
    import { writeSync } from 'node:fs'
    writeSync(1, 'F01_CAPTURE_START\\n')
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 600; i++) writeSync(1, chunk)
  `)
  // The outer observer must hold the CLI's existing 32 MiB capture plus its report.
  const result = f.invoke(['--group', 'fast'], 40 * 1024 * 1024)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /F01_CAPTURE_START/)
  assert.match(result.stderr, /ENOBUFS/)
  assert.match(result.stderr, /maxBuffer=33554432 bytes.*output may be incomplete/)
  const report = receipt(f.root)
  assert.equal(report.status, 'failed')
  assert.equal(report.checks[0].passed, false)
  assert.equal(report.checks[0].errorCode, 'ENOBUFS')
  assert.deepEqual(report.notRun, ['docs', 'repository-docs', 'format'])
})
test('failing first gate stops execution and marks later gates not run', t => {
  const f = fixture(t), result = f.invoke(['--group', 'fast'])
  assert.equal(result.status, 1)
  const report = receipt(f.root)
  assert.equal(report.status, 'failed')
  assert.equal(report.checks.length, 1)
  assert.equal(report.checks[0].name, 'migrations')
  assert.deepEqual(report.notRun, ['docs', 'repository-docs', 'format'])
})
test('a passing test cannot certify source it modified during validation', t => {
  const f = fixture(t, "import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('mutation fixture', () => writeFileSync('new-source.txt', 'changed'))")
  const result = f.invoke(['--group', 'node'])
  assert.equal(result.status, 1)
  const report = receipt(f.root)
  assert.equal(report.checks[0].counts.node.passed, 1)
  assert.equal(report.sourceChangedDuringValidation, true)
  assert.equal(report.status, 'source_changed')
})

test('a test added between discovery and source capture cannot be certified without execution', t => {
  const f = fixture(t)
  const lateTest = 'tools/late.test.mjs'
  const lateBody = "import test from 'node:test'; test('undiscovered failure', () => { throw new Error('F02_MUST_RUN') })"
  mkdirSync(path.join(f.root, 'output'))
  const preload = path.join(f.root, 'output/discovery-race.cjs')
  writeFileSync(preload, `
    const childProcess = require('node:child_process')
    const { writeFileSync } = require('node:fs')
    const { syncBuiltinESMExports } = require('node:module')
    const nativeSpawn = childProcess.spawnSync
    let injected = false
    childProcess.spawnSync = function (command, args, options) {
      const result = nativeSpawn(command, args, options)
      if (!injected && command === 'git' && args[0] === 'ls-files' && args.includes('--cached') && result.status === 0) {
        injected = true
        writeFileSync(${JSON.stringify(path.join(f.root, lateTest))}, ${JSON.stringify(lateBody)})
      }
      return result
    }
    syncBuiltinESMExports()
  `)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--require', preload, 'tools/run_checks.mjs', '--group', 'node'],
    { cwd: f.root, env, encoding: 'utf8', timeout: 20000 })
  assert.equal(result.error, undefined)
  assert.equal(readFileSync(path.join(f.root, lateTest), 'utf8'), lateBody)
  const report = receipt(f.root)
  assert.equal(report.checks[0].counts.node.passed, 1)
  assert.ok(!report.checks[0].argv.includes(lateTest))
  assert.ok(report.source.untrackedDigests.some(([file]) => file === lateTest))
  assert.equal(result.status, 1, 'must reject the old false pass for an undiscovered test')
  assert.equal(report.status, 'source_changed')
  assert.equal(report.sourceChangedDuringValidation, true)
  assert.ok(report.source.files.includes('tools/fixture.test.mjs'))
  assert.ok(!report.source.files.includes(lateTest))
})

for (const failingGate of [false, true]) {
  test(`postflight Git failure retains completed counts and pending gates (gate failed: ${failingGate})`, t => {
    const body = `
      import test from 'node:test'
      import { renameSync } from 'node:fs'
      test('owned postflight failure', () => {
        renameSync('.git', 'output/retained-git')
        ${failingGate ? "throw new Error('F03_GATE_FAILURE')" : ''}
      })
    `
    const f = fixture(t, body)
    // The failing fast gate uses real Node TAP counts and stops before Cargo.
    if (failingGate) writeFileSync(path.join(f.root, 'tools/check_migrations.mjs'), `
      import { spawnSync } from 'node:child_process'
      process.exitCode = spawnSync(process.execPath,
        ['--test', '--test-reporter=tap', 'tools/fixture.test.mjs'], { stdio: 'inherit' }).status
    `)
    const result = f.invoke(['--group', failingGate ? 'fast' : 'node'])
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Git evidence unavailable/)
    assert.match(result.stdout, failingGate ? /# fail 1/ : /# pass 1/)
    const report = receipt(f.root)
    assert.equal(report.status, 'source_unknown')
    assert.equal(report.sourceChangedDuringValidation, null)
    assert.match(report.sourceEvidenceError.message, /Git evidence unavailable/)
    assert.equal(report.checks.length, 1)
    assert.equal(report.checks[0].passed, !failingGate)
    assert.equal(report.checks[0].exitCode, failingGate ? 1 : 0)
    assert.equal(report.checks[0].counts.node.tests, 1)
    assert.equal(report.checks[0].counts.node.failed, failingGate ? 1 : 0)
    assert.equal(report.runningCheck, null)
    assert.deepEqual(report.notRun, failingGate ? ['docs', 'repository-docs', 'format'] : [])
    assert.ok(report.finishedAt)
  })
}

test('executing gates see incomplete receipts and completed checkpoints without overwriting prior attempts', t => {
  const f = fixture(t)
  const gate = (name, completed, pending) => `
    import assert from 'node:assert/strict'
    import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
    const reports = readdirSync('output/readiness').filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync('output/readiness/' + file, 'utf8')))
    const running = reports.filter(report => report.status === 'running')
    assert.equal(running.length, 1, 'one durable incomplete attempt must exist')
    const report = running[0]
    assert.equal(report.runningCheck, '${name}')
    assert.equal(report.sourceChangedDuringValidation, null)
    assert.equal(report.finishedAt, undefined)
    assert.deepEqual(report.checks.map(check => check.name), ${JSON.stringify(completed)})
    assert.ok(report.checks.every(check => check.passed && check.exitCode === 0))
    assert.deepEqual(report.notRun, ${JSON.stringify(pending)})
    writeFileSync('output/${name}-checkpoint.json', JSON.stringify(report))
    process.exitCode = ${name === 'docs' ? 7 : 0}
  `
  writeFileSync(path.join(f.root, 'tools/check_migrations.mjs'), gate('migrations', [], ['docs', 'repository-docs', 'format']))
  writeFileSync(path.join(f.root, 'tools/check_docs.mjs'), gate('docs', ['migrations'], ['repository-docs', 'format']))
  const result = f.invoke(['--group', 'fast'])
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  const report = receipt(f.root)
  assert.equal(report.status, 'failed')
  assert.equal(report.sourceChangedDuringValidation, false)
  assert.equal(report.runningCheck, null)
  assert.equal(report.checks.length, 2)
  assert.equal(report.checks[1].exitCode, 7)
  assert.deepEqual(report.notRun, ['repository-docs', 'format'])
  for (const name of ['migrations', 'docs']) {
    assert.equal(JSON.parse(readFileSync(path.join(f.root, `output/${name}-checkpoint.json`))).runningCheck, name)
  }
  const directory = path.join(f.root, 'output/readiness')
  const [first] = readdirSync(directory)
  const before = readFileSync(path.join(directory, first))
  const again = f.invoke(['--group', 'fast'])
  assert.equal(again.status, 1)
  assert.equal(again.stderr, '')
  assert.equal(readdirSync(directory).length, 2, 'one final receipt per attempt, no temporary files')
  assert.deepEqual(readFileSync(path.join(directory, first)), before)
})
