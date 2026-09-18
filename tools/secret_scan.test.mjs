import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const workflow = await readFile(new URL('../.github/workflows/security-scan.yml', import.meta.url), 'utf8')
const blocks = [...workflow.matchAll(/          node --input-type=module - .* <<'ECORP_SCAN_REPORT'\r?\n([\s\S]*?)          ECORP_SCAN_REPORT/g)]
assert.equal(blocks.length, 1)
const program = blocks[0][1].split(/\r?\n/).map(line => line.replace(/^          /, '')).join('\n')
const canary = 'NON_CREDENTIAL_DIAGNOSTIC_TEST_CANARY'
const commit = 'a'.repeat(40)
const finding = () => ({ Commit: commit, File: 'folder with spaces/example.txt', RuleID: 'example-rule',
  StartLine: 3, EndLine: 4, Secret: canary, Match: canary, Description: canary,
  Author: canary, Email: canary, Message: canary, Tags: [canary], Fingerprint: canary,
  Fragment: { Raw: canary }, arbitrary: { data: canary } })

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ecorp-scan-report-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  })
  const report = path.join(directory, 'report.json')
  async function run(contents, status = '1', extra = []) {
    if (contents !== undefined) await writeFile(report, contents)
    const result = spawnSync(process.execPath, ['--input-type=module', '-', report, status, ...extra], {
      input: program, encoding: 'utf8', cwd: directory, timeout: 10000, windowsHide: true,
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert(!result.stdout.includes(canary))
    assert(!result.stderr.includes(canary))
    return { ...result, output: JSON.parse(result.stdout || result.stderr) }
  }
  return { run, report }
}

test('native failure emits only bounded attribution metadata, never report content', async t => {
  const f = await fixture(t)
  const result = await f.run(JSON.stringify([finding(), { ...finding(), File: 'second.txt', StartLine: 9, EndLine: 9 }]))
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  assert.equal(result.output.status, 'failed')
  assert.equal(result.output.finding_count, 2)
  assert.equal(result.output.displayed, 2)
  assert.equal(result.output.omitted, 0)
  assert.deepEqual(result.output.findings[0], {
    commit, file: 'folder with spaces/example.txt', start_line: 3, end_line: 4,
    rule_id: 'example-rule', fingerprint: `${commit}:folder with spaces/example.txt:example-rule:3`,
  })
})

test('clean requires native success and a valid empty report', async t => {
  const f = await fixture(t)
  const result = await f.run('[]', '0')
  assert.equal(result.status, 0)
  assert.equal(result.output.status, 'clean')
  assert.deepEqual(result.output.findings, [])
})

test('workflow-command delimiters are inert while decoded metadata preserves identity', async t => {
  const f = await fixture(t)
  const file = '::error::##[error]example.txt'
  const result = await f.run(JSON.stringify([{ ...finding(), File: file }]))
  assert.equal(result.status, 1)
  assert.equal(result.output.findings[0].file, file)
  assert.equal(result.output.findings[0].fingerprint, `${commit}:${file}:example-rule:3`)
  assert(!result.stdout.includes('::'))
  assert(!result.stdout.includes('##['))
})

for (const status of ['1', '2', '124', '137', '255']) {
  test(`empty findings do not hide scanner/tool exit ${status}`, async t => {
    const f = await fixture(t)
    const result = await f.run('[]', status)
    assert.equal(result.status, Number(status))
    assert.equal(result.output.status, 'failed')
    assert.equal(result.output.scan_exit_code, Number(status))
  })
}

test('native success with findings cannot become a passing result', async t => {
  const f = await fixture(t)
  const result = await f.run(JSON.stringify([finding()]), '0')
  assert.equal(result.status, 2)
  assert.equal(result.output.error_code, 'inconsistent_scan_result')
})

for (const [label, contents, error] of [
  ['missing', undefined, 'report_unreadable'],
  ['empty', '', 'report_size'],
  ['invalid JSON', `{"Secret":"${canary}"`, 'invalid_report_json'],
  ['invalid UTF8', Buffer.from([0xff, 0xfe]), 'invalid_report_json'],
  ['null', 'null', 'invalid_report_shape'],
  ['object', '{"findings":[]}', 'invalid_report_shape'],
  ['too many findings', JSON.stringify(Array(1001).fill(finding())), 'invalid_report_shape'],
  ['oversized', ' '.repeat(4 * 1024 * 1024 + 1), 'report_size'],
]) {
  test(`${label} report fails without echoing input or inventing clean results`, async t => {
    const f = await fixture(t)
    const result = await f.run(contents, '0')
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.output.error_code, error)
  })
}

test('non-regular report is rejected before reading', async t => {
  const f = await fixture(t)
  await mkdir(f.report)
  const result = await f.run(undefined)
  assert.equal(result.status, 1)
  assert.equal(result.output.error_code, 'report_not_regular')
})

test('exact report byte limit accepts valid JSON without truncation', async t => {
  const f = await fixture(t)
  const result = await f.run('[]' + ' '.repeat(4 * 1024 * 1024 - 2), '0')
  assert.equal(result.status, 0)
  assert.equal(result.output.status, 'clean')
})

test('exact finding limit is accepted with explicit bounded display', async t => {
  const f = await fixture(t)
  const result = await f.run(JSON.stringify(Array.from({ length: 1000 }, () => finding())))
  assert.equal(result.status, 1)
  assert.equal(result.output.finding_count, 1000)
  assert.equal(result.output.displayed, 50)
  assert.equal(result.output.omitted, 950)
})

test('exact metadata limits preserve all validated values', async t => {
  const f = await fixture(t)
  const record = { ...finding(), File: 'x'.repeat(1024), RuleID: 'R'.repeat(128),
    StartLine: Number.MAX_SAFE_INTEGER, EndLine: Number.MAX_SAFE_INTEGER }
  const result = await f.run(JSON.stringify([record]))
  assert.equal(result.status, 1)
  assert.equal(result.output.findings[0].file, record.File)
  assert.equal(result.output.findings[0].rule_id, record.RuleID)
  assert.equal(result.output.findings[0].end_line, record.EndLine)
})

for (const record of [null, [], 1, 'not a record']) {
  test(`malformed finding is rejected (${JSON.stringify(record)})`, async t => {
    const f = await fixture(t)
    const result = await f.run(JSON.stringify([record]))
    assert.equal(result.status, 1)
    assert.equal(result.output.error_code, 'invalid_finding')
  })
}

for (const [field, value] of [
  ['Commit', 'main'], ['Commit', 123], ['Commit', 'a'.repeat(39)],
  ['Commit', 'a'.repeat(41)], ['Commit', 'g'.repeat(40)], ['File', '/absolute'],
  ['File', 'C:\\absolute'], ['File', '../outside'], ['File', 'dir/../outside'],
  ['File', 'dir//file'], ['File', `name\n::error::${canary}`],
  ['File', '\u001b[31mfile'], ['File', '\u202efile'], ['File', 'x'.repeat(1025)],
  ['RuleID', `bad ${canary}`], ['RuleID', 'r'.repeat(129)], ['StartLine', 0], ['StartLine', '1'],
  ['StartLine', Number.MAX_SAFE_INTEGER + 1], ['EndLine', 2],
]) {
  test(`reject invalid ${field} metadata (${JSON.stringify(value).slice(0, 45)})`, async t => {
    const f = await fixture(t)
    const result = await f.run(JSON.stringify([{ ...finding(), [field]: value }]))
    assert.equal(result.status, 1)
    assert.equal(result.output.status, 'diagnostics_failed')
    assert.equal(result.stdout, '')
  })
}

test('all findings are validated before bounded display', async t => {
  const f = await fixture(t)
  const records = Array.from({ length: 51 }, () => finding())
  const result = await f.run(JSON.stringify(records))
  assert.equal(result.output.finding_count, 51)
  assert.equal(result.output.displayed, 50)
  assert.equal(result.output.omitted, 1)
  records[50].File = `bad\n${canary}`
  const invalid = await f.run(JSON.stringify(records))
  assert.equal(invalid.output.status, 'diagnostics_failed')
  assert.equal(invalid.stdout, '')
})

for (const status of ['-1', '256', '1.5', '', '01', canary]) {
  test(`invalid scanner status is rejected (${status})`, async t => {
    const f = await fixture(t)
    const result = await f.run('[]', status)
    assert.equal(result.status, 2)
    assert.equal(result.output.error_code, 'invalid_arguments')
  })
}

test('unexpected arguments are not echoed', async t => {
  const f = await fixture(t)
  const result = await f.run('[]', '0', [canary])
  assert.equal(result.status, 2)
  assert.equal(result.output.error_code, 'invalid_arguments')
})

test('workflow retains scan scope, redaction, pinning, failure propagation and ephemeral reports', () => {
  assert(workflow.includes('--log-opts=HEAD --redact=100 --no-banner --no-color'))
  assert(workflow.includes('--ignore-gitleaks-allow --gitleaks-ignore-path .gitleaksignore --timeout 300'))
  assert(workflow.includes('gitleaks_8.30.1_linux_x64.tar.gz'))
  assert(workflow.includes('551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'))
  assert(workflow.includes('>"$diagnostic_dir/scan.log" 2>&1 || scan_status=$?'))
  assert(workflow.includes('trap \'rm -f -- "$diagnostic_dir/report.json" "$diagnostic_dir/scan.log"; rmdir -- "$diagnostic_dir"\' EXIT'))
  assert(!workflow.includes('upload-artifact'))
  assert(!workflow.includes('continue-on-error'))
  assert(!workflow.includes('--exit-code=0'))
  assert(!workflow.includes('node-version-file:'))
  assert(workflow.includes('node-version: 24.19.0'))
})
