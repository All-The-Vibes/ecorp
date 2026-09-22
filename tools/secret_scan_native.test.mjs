import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// CI supplies the release installed and verified by security-scan.yml. Local
// unit runs remain offline; supplying a missing/wrong binary fails, never skips.
const binary = process.env.ECORP_GITLEAKS_BINARY
const workflow = readFileSync(new URL('../.github/workflows/security-scan.yml', import.meta.url), 'utf8')
const blocks = [...workflow.matchAll(/          node --input-type=module - .* <<'ECORP_SCAN_REPORT'\r?\n([\s\S]*?)          ECORP_SCAN_REPORT/g)]
assert.equal(blocks.length, 1)
const program = blocks[0][1].split(/\r?\n/).map(line => line.replace(/^          /, '')).join('\n')
const skip = binary ? false : 'Set ECORP_GITLEAKS_BINARY to the verified Gitleaks 8.30.1 executable'
const identifier = value => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ecorp-native-secret-scan-'))
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    rmSync(root, { recursive: true, force: false })
  })
  const repository = path.join(root, 'source')
  const diagnostics = path.join(root, 'private-diagnostics')
  const hooks = path.join(root, 'empty-hooks')
  for (const directory of [repository, diagnostics, hooks]) mkdirSync(directory)
  const environment = {}
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const globalConfig = path.join(root, 'empty-gitconfig')
  writeFileSync(globalConfig, '')
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: '0' })
  function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: repository, env: environment, encoding: 'utf8', windowsHide: true,
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options,
    })
    assert.equal(result.error?.code, undefined, 'native child must finish within its bound')
    assert.equal(result.signal, null, 'native child must exit normally')
    return result
  }
  const version = run(binary, ['version'])
  assert.equal(version.status, 0)
  assert.equal(version.stdout.trim(), '8.30.1', 'acceptance requires the pinned native scanner')
  function git(...args) {
    const result = run('git', args)
    assert.equal(result.status, 0, 'owned Git fixture operation must succeed')
    return result.stdout.trim()
  }
  git('init', '-b', 'main')
  for (const [key, value] of [
    ['user.name', 'Native scanner fixture'], ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', hooks],
  ]) git('config', key, value)
  writeFileSync(path.join(repository, 'README.md'), 'Owned scanner acceptance fixture.\n')
  writeFileSync(path.join(repository, '.gitleaksignore'), '')
  const commit = () => { git('add', '-A'); git('commit', '-m', 'owned fixture'); return git('rev-parse', 'HEAD') }
  commit()
  // A generated noncredential marker and isolated test-only rule exercise the
  // real scanner/report format without storing credentials or changing policy.
  const marker = ['ECORP', 'NATIVE', 'FIXTURE', randomBytes(16).toString('hex').toUpperCase()].join('_')
  const policy = path.join(root, 'fixture.toml')
  writeFileSync(policy, `title = "Native diagnostic fixture"\n[[rules]]\nid = "native-fixture"\nregex = '''ECORP_NATIVE_FIXTURE_[A-F0-9]{32}'''\n`)
  function scan(config = policy, timeout = '300') {
    const report = path.join(diagnostics, 'report.json')
    const log = path.join(diagnostics, 'scan.log')
    const before = git('status', '--porcelain')
    try {
      const native = run(binary, ['git', '.', '--log-opts=HEAD', '--redact=100', '--no-banner', '--no-color',
        '--exit-code=42',
        '--ignore-gitleaks-allow', '--gitleaks-ignore-path', '.gitleaksignore', '--timeout', timeout,
        '--config', config, '--report-format=json', `--report-path=${report}`])
      writeFileSync(log, native.stdout + native.stderr, { mode: 0o600 })
      const reportCreated = existsSync(report)
      const reporter = run(process.execPath, ['--input-type=module', '-', report, String(native.status)], { input: program })
      const output = reporter.stdout + reporter.stderr
      assert.equal(output.includes(marker), false, 'raw matches must not cross the reporter boundary')
      assert.equal(output.includes(repository), false, 'private fixture paths must not be published')
      assert.equal(output.includes('::'), false, 'workflow commands must remain inert')
      assert.equal(Buffer.byteLength(output) < 4096, true, 'fixture metadata must stay bounded')
      assert.equal(git('status', '--porcelain'), before, 'native scan must preserve source bytes')
      return { nativeStatus: native.status, reporterStatus: reporter.status, reportCreated, output: JSON.parse(output) }
    } finally {
      for (const file of [report, log]) {
        if (existsSync(file)) rmSync(file)
        assert.equal(existsSync(file), false, 'raw report/log must be removed after reporting')
      }
    }
  }
  t.diagnostic('Native Gitleaks 8.30.1, disposable Git history, actual inline workflow reporter')
  return { repository, root, marker, commit, scan, git, run, policy }
}

test('native scanner clean history yields a clean bounded report', { skip }, t => {
  const f = fixture(t)
  const result = f.scan()
  assert.equal(result.nativeStatus, 0)
  assert.equal(result.reporterStatus, 0)
  assert.equal(result.output.status, 'clean')
  assert.deepEqual(result.output.findings, [])
})

for (const historical of [false, true]) {
  test(`native scanner attributes a ${historical ? 'historical' : 'current'} finding and preserves failure`, { skip }, t => {
    const f = fixture(t)
    const filename = 'example with spaces.txt'
    writeFileSync(path.join(f.repository, filename), `Fixture only\n${f.marker} # gitleaks:allow\n`)
    const findingCommit = f.commit()
    if (historical) {
      writeFileSync(path.join(f.repository, filename), 'Marker removed from HEAD.\n')
      assert.notEqual(f.commit(), findingCommit)
    }
    const result = f.scan()
    assert.equal(result.nativeStatus, 42)
    assert.equal(result.reporterStatus, 42)
    assert.equal(result.output.status, 'findings')
    assert.equal(result.output.scan_complete, true)
    assert.equal(result.output.finding_count, 1)
    assert.deepEqual(result.output.findings, [{
      commit: findingCommit, file_id: identifier(filename), start_line: 2, end_line: 2,
      rule_id: identifier('native-fixture'), finding_id: identifier(JSON.stringify([findingCommit, filename, 'native-fixture', 2, 2])),
    }])
  })
}

test('native scanner configuration failure cannot become a clean result', { skip }, t => {
  const f = fixture(t)
  const invalid = path.join(f.root, 'invalid.toml')
  writeFileSync(invalid, '[[rules]\n')
  const result = f.scan(invalid)
  assert.notEqual(result.nativeStatus, 0)
  assert.equal(result.reporterStatus, result.nativeStatus)
  assert.notEqual(result.output.status, 'clean')
  assert.equal(result.output.scan_exit_code, result.nativeStatus)
})

test('native scanner redaction does not permit a sensitive filename in diagnostics', { skip }, t => {
  const f = fixture(t)
  const filename = `${f.marker}.txt`
  writeFileSync(path.join(f.repository, filename), `${f.marker}\n`)
  const findingCommit = f.commit()
  const result = f.scan()
  assert.equal(result.nativeStatus, 42)
  assert.equal(result.reporterStatus, 42)
  assert.equal(result.output.findings[0].file_id, identifier(filename))
  assert.equal(result.output.findings[0].commit, findingCommit)
})

test('native scan works on an older selected head without workflow support files', { skip }, t => {
  const f = fixture(t)
  assert.equal(existsSync(path.join(f.repository, 'tools/secret_scan_native.test.mjs')), false)
  writeFileSync(path.join(f.repository, 'old-head.txt'), `${f.marker}\n`)
  const selectedHead = f.commit()
  const binaryBefore = identifier(readFileSync(binary))
  const ignoresBefore = readFileSync(path.join(f.repository, '.gitleaksignore'))
  const result = f.scan()
  assert.equal(result.reporterStatus, 42)
  assert.equal(result.output.scan_complete, true)
  assert.equal(result.output.findings[0].commit, selectedHead)
  assert.equal(f.git('rev-parse', 'HEAD'), selectedHead)
  assert.equal(identifier(readFileSync(binary)), binaryBefore)
  assert.deepEqual(readFileSync(path.join(f.repository, '.gitleaksignore')), ignoresBefore)
})

test('selected-head executable fixtures cannot run in the production scan path', { skip }, t => {
  const f = fixture(t)
  const tools = path.join(f.repository, 'tools')
  mkdirSync(tools)
  const touched = path.join(f.repository, 'fixture-was-executed')
  writeFileSync(path.join(tools, 'secret_scan_native.test.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(touched)}, 'owned fixture');\n`)
  const selectedHead = f.commit()
  const binaryBefore = identifier(readFileSync(binary))
  const result = f.scan()
  assert.equal(result.reporterStatus, 0)
  assert.equal(existsSync(touched), false)
  assert.equal(f.git('rev-parse', 'HEAD'), selectedHead)
  assert.equal(identifier(readFileSync(binary)), binaryBefore)
  const production = workflow.split(/^  native-fixtures:\s*$/m)[0]
  assert.equal(production.includes('secret_scan_native.test.mjs'), false)
})

test('native Git completeness check rejects unavailable historical objects before scanning', { skip }, t => {
  const f = fixture(t)
  writeFileSync(path.join(f.repository, 'history.txt'), 'First version of disposable history.\n')
  const historicalCommit = f.commit()
  const historicalBlob = f.git('rev-parse', `${historicalCommit}:history.txt`)
  writeFileSync(path.join(f.repository, 'history.txt'), 'Second version of disposable history.\n')
  f.commit()
  writeFileSync(path.join(f.repository, 'finding.txt'), `${f.marker}\n`)
  f.commit()
  // Preserve the fixture object outside .git so HEAD remains readable while
  // the native completeness precondition rejects the older unavailable blob.
  const object = path.join(f.repository, '.git/objects', historicalBlob.slice(0, 2), historicalBlob.slice(2))
  renameSync(object, path.join(f.root, 'retained-historical-blob'))
  const completeness = f.run('git', ['rev-list', '--objects', '--missing=error', 'HEAD'])
  assert.notEqual(completeness.status, 0)
  assert(workflow.includes('git rev-list --objects --missing=error HEAD >/dev/null 2>&1 || {'))
  assert(workflow.indexOf('git rev-list --objects --missing=error HEAD') < workflow.indexOf('gitleaks git .'))
})

test('native partial timeout keeps collected findings explicitly incomplete', { skip }, async t => {
  const f = fixture(t)
  const converter = path.join(f.root, 'bounded-textconv.mjs')
  const finished = path.join(f.root, 'textconv-finished')
  writeFileSync(converter, `import { writeFileSync } from 'node:fs';
setTimeout(() => {
  writeFileSync(${JSON.stringify(finished)}, 'finished');
  process.stdout.write('Owned bounded text conversion.\\n');
}, 1800);
`)
  // Real Git text conversion makes the native one-second deadline deterministic.
  // The fixture-only converter is bounded and its completion is verified below.
  f.git('config', 'diff.ecorpfixture.textconv',
    `"${process.execPath.replaceAll('\\', '/')}" "${converter.replaceAll('\\', '/')}"`)
  writeFileSync(path.join(f.repository, '.gitattributes'), 'slow.txt diff=ecorpfixture\n')
  writeFileSync(path.join(f.repository, 'slow.txt'), 'Older fixture content.\n')
  f.commit()
  writeFileSync(path.join(f.repository, 'finding.txt'), `${f.marker}\n${'ordinary padding\n'.repeat(2000)}`)
  writeFileSync(path.join(f.repository, 'next-file.txt'), 'Next diff ensures the first fragment is yielded.\n')
  f.commit()
  let result
  try {
    result = f.scan(f.policy, '1')
  } finally {
    const deadline = Date.now() + 5000
    while (!existsSync(finished) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert(existsSync(finished), 'the owned bounded converter completed before fixture cleanup')
  }
  assert.equal(result.nativeStatus, 1)
  assert.equal(result.reportCreated, true, 'a real timeout still creates a findings report')
  assert.equal(result.reporterStatus, 1)
  assert.equal(result.output.status, 'scan_error')
  assert.equal(result.output.scan_complete, false)
  assert(result.output.finding_count > 0, 'the native report contains findings collected before its deadline')
})
