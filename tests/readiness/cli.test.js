// Black-box tests of the actual validation CLI; fixture counts are not product-test counts.
const assert = require('node:assert/strict')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const source = path.resolve(__dirname, '../..')

function fixture(t, testBody = "import test from 'node:test'; test('owned fixture', () => {})", extraFiles = {}) {
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
  for (const [file, body] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), body)
  }
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

function assertGitDiagnostic(detail, native, operation = 'ls-files') {
  assert.equal(detail.code, native.error?.code ?? null, 'retain the actual native error code')
  assert.equal(detail.exitCode, native.status, 'retain the actual native Git exit status')
  assert.equal(detail.signal, native.signal)
  assert.equal(detail.operation, operation)
  assert.equal(detail.diagnostic.stderrBytes, Buffer.byteLength(native.stderr ?? ''))
  assert.equal(detail.diagnostic.stderrSha256, createHash('sha256').update(native.stderr ?? '').digest('hex'))
  assert.match(detail.diagnostic.text, /withheld/)
}

test('dry run executes no checks, creates no receipt and leaves source unchanged', t => {
  const f = fixture(t), before = f.git(['status', '--porcelain'])
  const result = f.invoke(['--group', 'full', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.dry_run, true)
  assert.deepEqual(preview.writes, [])
  assert.equal(preview.checks.length, 11)
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

test('a config-only save after module load cannot certify tests selected by the old config', t => {
  const extraTest = 'additional-tests/config-only.test.mjs'
  const f = fixture(t, undefined, {
    [extraTest]: "import test from 'node:test'; test('new root failure', () => { throw new Error('F02_CONFIG_MUST_RUN') })",
  })
  const configPath = path.join(f.root, 'test.config.json')
  const before = readFileSync(configPath, 'utf8'), changed = JSON.parse(before)
  changed.nodeTestRoots.push('additional-tests/')
  const after = JSON.stringify(changed, null, 2) + '\n'
  const inventory = f.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  const head = f.git(['rev-parse', 'HEAD']).trim()
  assert.equal(f.git(['status', '--porcelain']), '')
  assert.ok(inventory.split('\0').includes(extraTest))
  mkdirSync(path.join(f.root, 'output'))
  const preload = path.join(f.root, 'output/config-race.cjs')
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
        writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(after)})
      }
      return result
    }
    syncBuiltinESMExports()
  `)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const argv = ['--require', preload, 'tools/run_checks.mjs', '--group', 'node']
  const result = spawnSync(process.execPath, argv, { cwd: f.root, env, encoding: 'utf8', timeout: 20000 })
  assert.equal(result.error, undefined)
  const report = receipt(f.root)
  writeFileSync(path.join(f.root, 'output/config-race-observation.json'), JSON.stringify({
    argv, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, before, after, report,
  }, null, 2))
  assert.equal(readFileSync(configPath, 'utf8'), after)
  assert.equal(f.git(['status', '--porcelain']).trim(), 'M test.config.json')
  assert.equal(f.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']), inventory)
  assert.equal(f.git(['rev-parse', 'HEAD']).trim(), head)
  assert.equal(report.source.commit, head)
  assert.deepEqual(report.source.files, inventory.split('\0').filter(Boolean))
  assert.equal(report.source.trackedDiffSha256, createHash('sha256').update(f.git(['diff', '--binary', 'HEAD'])).digest('hex'))
  assert.deepEqual(report.source.untrackedDigests, [])
  assert.equal(report.checks[0].counts.node.passed, 1)
  assert.ok(!report.checks[0].argv.includes(extraTest))
  assert.equal(result.status, 1, 'must reject the old false pass for config-only test selection changes')
  assert.equal(report.status, 'source_changed')
  assert.equal(report.sourceChangedDuringValidation, true)
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
    const native = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: f.root, encoding: 'utf8' })
    assert.equal(native.status, 128)
    assertGitDiagnostic(report.sourceEvidenceError, native)
    assert.ok(!result.stderr.includes(native.stderr.trim()), 'raw native diagnostic is withheld, not truncated')
  })
}

for (const phase of ['initial', 'postflight']) {
  for (const fault of ['missing-git', 'invalid-git-dir']) {
    test(`native Git diagnostics survive ${phase} ${fault} without disclosing raw text`, t => {
      const f = fixture(t)
      const head = f.git(['rev-parse', 'HEAD']), index = readFileSync(path.join(f.root, '.git/index'))
      const marker = 'F03_SYNTHETIC_PRIVATE_PATH_AND_SECRET'
      const faultEnv = fault === 'missing-git'
        ? { PATH: path.join(f.root, 'output/empty-path') }
        : { GIT_DIR: path.join(f.root, 'output', marker) }
      const env = { ...process.env }
      delete env.NODE_TEST_CONTEXT
      const applyFault = target => {
        for (const key of Object.keys(target)) if (key.toUpperCase() === 'PATH' && fault === 'missing-git') delete target[key]
        Object.assign(target, faultEnv)
      }
      const probeEnv = { ...env }
      applyFault(probeEnv)
      // Real native failures; neither the process result nor its diagnostics are fabricated.
      const native = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd: f.root, env: probeEnv, encoding: 'utf8' })
      if (fault === 'missing-git') assert.equal(native.error?.code, 'ENOENT')
      else {
        assert.equal(native.status, 128)
        assert.ok(native.stderr.includes(marker), 'native Git really emitted the synthetic sensitive path')
      }
      mkdirSync(path.join(f.root, 'output'))
      const argv = ['tools/run_checks.mjs', '--group', 'node']
      if (phase === 'initial') applyFault(env)
      else {
        const preload = path.join(f.root, 'output/git-fault.cjs')
        writeFileSync(preload, `
          const cp = require('node:child_process'), fs = require('node:fs')
          const nativeSpawn = cp.spawnSync
          cp.spawnSync = function (command, args, options) {
            const result = nativeSpawn(command, args, options)
            if (command === process.execPath && args.includes('--test')) {
              const file = fs.readdirSync('output/readiness').find(file => file.endsWith('.json'))
              fs.copyFileSync('output/readiness/' + file, 'output/f03-checkpoint.json')
              if (${JSON.stringify(fault)} === 'missing-git') {
                for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') delete process.env[key]
              }
              Object.assign(process.env, ${JSON.stringify(faultEnv)})
            }
            return result
          }
          require('node:module').syncBuiltinESMExports()
        `)
        argv.unshift('--require', preload)
      }
      const result = spawnSync(process.execPath, argv, { cwd: f.root, env, encoding: 'utf8', timeout: 20000 })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 1)
      const report = phase === 'postflight' ? receipt(f.root) : null
      writeFileSync(path.join(f.root, 'output/f03-observation.json'), JSON.stringify({
        phase, fault, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, report,
        native: { code: native.error?.code ?? null, exitCode: native.status, signal: native.signal,
          stderrBytes: Buffer.byteLength(native.stderr ?? ''),
          stderrSha256: createHash('sha256').update(native.stderr ?? '').digest('hex') },
      }, null, 2))
      const diagnosticOutput = result.stderr + JSON.stringify(report?.sourceEvidenceError)
      for (const withheld of [marker, f.root, f.root.replaceAll('\\', '/'), JSON.stringify(f.root).slice(1, -1)]) {
        assert.ok(!diagnosticOutput.includes(withheld), 'Git error output must not reveal sensitive text')
      }
      assert.equal(f.git(['rev-parse', 'HEAD']), head)
      assert.deepEqual(readFileSync(path.join(f.root, '.git/index')), index)
      assert.equal(f.git(['status', '--porcelain']), '')
      if (report) {
        assert.equal(report.status, 'source_unknown')
        assert.equal(report.sourceChangedDuringValidation, null)
        assert.equal(report.checks.length, 1)
        assert.equal(report.checks[0].counts.node.passed, 1)
        assert.equal(report.runningCheck, null)
        assert.deepEqual(report.notRun, [])
        const checkpoint = JSON.parse(readFileSync(path.join(f.root, 'output/f03-checkpoint.json')))
        assert.equal(checkpoint.status, 'running')
        assert.equal(checkpoint.runningCheck, 'node-tests')
        assert.deepEqual(checkpoint.checks, [])
        assertGitDiagnostic(report.sourceEvidenceError, native)
      } else {
        assert.equal(result.stdout, '')
        assert.ok(!readdirSync(path.join(f.root, 'output')).includes('readiness'))
      }
      assert.match(result.stderr, /Git evidence unavailable: ls-files; \{/)
      const detail = JSON.parse(result.stderr.trim().slice(result.stderr.indexOf('; ') + 2))
      assertGitDiagnostic(detail, native)
    })
  }
}

for (const phase of ['initial', 'postflight']) {
  test(`streamed Git diff failure retains ${phase} native diagnostics without raw text`, t => {
    const f = fixture(t)
    const head = f.git(['rev-parse', 'HEAD']), index = readFileSync(path.join(f.root, '.git/index'))
    const marker = 'F03_STREAMED_SYNTHETIC_PRIVATE_VALUE'
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const configCount = Number(env.GIT_CONFIG_COUNT ?? 0)
    const faultEnv = {
      GIT_CONFIG_COUNT: String(configCount + 1),
      [`GIT_CONFIG_KEY_${configCount}`]: 'core.quotePath',
      [`GIT_CONFIG_VALUE_${configCount}`]: marker,
    }
    const native = spawnSync('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'],
      { cwd: f.root, env: { ...env, ...faultEnv }, encoding: 'utf8' })
    assert.equal(native.status, 128)
    assert.ok(native.stderr.includes(marker), 'native Git emits the synthetic private configuration value')
    mkdirSync(path.join(f.root, 'output'))
    const preload = path.join(f.root, 'output/streamed-git-fault.cjs')
    writeFileSync(preload, `
      const cp = require('node:child_process')
      const nativeSpawn = cp.spawn
      let diffs = 0
      cp.spawn = function (command, args, options) {
        if (command === 'git' && args[0] === 'diff' && ++diffs === ${phase === 'initial' ? 1 : 2}) {
          return nativeSpawn(command, args, { ...options,
            env: { ...process.env, ...options.env, ...${JSON.stringify(faultEnv)} } })
        }
        return nativeSpawn(command, args, options)
      }
      require('node:module').syncBuiltinESMExports()
    `)
    const result = spawnSync(process.execPath, ['--require', preload, 'tools/run_checks.mjs', '--group', 'node'],
      { cwd: f.root, env, encoding: 'utf8', timeout: 20000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    const report = phase === 'postflight' ? receipt(f.root) : null
    const diagnosticOutput = result.stderr + JSON.stringify(report?.sourceEvidenceError)
    for (const withheld of [marker, f.root, f.root.replaceAll('\\', '/'), JSON.stringify(f.root).slice(1, -1)]) {
      assert.ok(!diagnosticOutput.includes(withheld), 'streamed Git errors do not publish raw diagnostic text')
    }
    assert.equal(f.git(['rev-parse', 'HEAD']), head)
    assert.deepEqual(readFileSync(path.join(f.root, '.git/index')), index)
    assert.equal(f.git(['status', '--porcelain']), '')
    if (report) {
      assert.equal(report.status, 'source_unknown')
      assert.equal(report.sourceChangedDuringValidation, null)
      assert.equal(report.checks[0].counts.node.passed, 1)
      assert.equal(report.runningCheck, null)
      assert.deepEqual(report.notRun, [])
      assertGitDiagnostic(report.sourceEvidenceError, native, 'diff')
    } else {
      assert.equal(result.stdout, '')
      assert.ok(!readdirSync(path.join(f.root, 'output')).includes('readiness'))
    }
    assert.match(result.stderr, /Git evidence unavailable: diff; \{/)
    const detail = JSON.parse(result.stderr.trim().slice(result.stderr.indexOf('; ') + 2))
    assertGitDiagnostic(detail, native, 'diff')
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

for (const mutate of [false, true]) {
  test('large tracked diff is fully bound across validation (tail mutation: ' + mutate + ')', t => {
    const body = mutate ? `
      import test from 'node:test'
      import { openSync, writeSync, closeSync } from 'node:fs'
      test('change beyond the former capture limit', () => {
        const fd = openSync('large-source.txt', 'r+')
        try { writeSync(fd, Buffer.from('changed-tail'), 0, 12, 17 * 1024 * 1024 - 32) }
        finally { closeSync(fd) }
      })
    ` : undefined
    const f = fixture(t, body)
    writeFileSync(path.join(f.root, 'large-source.txt'), Buffer.alloc(17 * 1024 * 1024, 'validated source line\n'))
    f.git(['add', '--', 'large-source.txt'])
    // The observer intentionally captures more than the former 16 MiB limit;
    // the production CLI must stream every byte and retain a constant-size hash.
    const before = spawnSync('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], {
      cwd: f.root, maxBuffer: 24 * 1024 * 1024, windowsHide: true,
    })
    assert.equal(before.error, undefined)
    assert.equal(before.status, 0)
    assert.ok(before.stdout.length > 16 * 1024 * 1024)
    const result = f.invoke(['--group', 'node'])
    assert.equal(result.error, undefined)
    assert.equal(result.status, mutate ? 1 : 0, result.stderr)
    const report = receipt(f.root)
    assert.equal(report.source.trackedDiffSha256, createHash('sha256').update(before.stdout).digest('hex'))
    assert.equal(report.checks[0].counts.node.passed, 1)
    assert.equal(report.sourceChangedDuringValidation, mutate)
    assert.equal(report.status, mutate ? 'source_changed' : 'passed')
  })
}
