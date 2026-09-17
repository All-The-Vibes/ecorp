import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const secret = 'DOCTOR_TEST_SECRET_MUST_NOT_ESCAPE'
const source = new URL('./verify_toolchain.mjs', import.meta.url)
const names = ['pnpm', 'rustup', 'rustc', 'cargo', 'rustfmt', 'cargo-clippy']
const rustToml = '[toolchain]\nchannel = "1.98.1"\nprofile = "minimal"\ncomponents = ["rustfmt", "clippy"]\n'
const fixtureProgram = `
import { appendFileSync, readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('./responses.json', import.meta.url), 'utf8'));
const [name, ...args] = process.argv.slice(2);
appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify({
  name, args, cwd: process.cwd(), secretInherited: process.env.ECORP_DOCTOR_SECRET_CANARY !== undefined,
  networkDisabled: process.env.COREPACK_ENABLE_NETWORK === '0'
}) + '\\n');
if (name === 'rustup' && (args[0] !== 'run' || args[1] !== '1.98.1' || args.includes('--install'))) process.exit(90);
const response = config[name === 'rustup' ? args[2] : name];
if (!response) process.exit(91);
if (response.stderr) process.stderr.write(response.stderr);
if (response.stdout) process.stdout.write(response.stdout + '\\n');
process.exitCode = response.status ?? 0;
`

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ecorp-toolchain-doctor-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  })
  const bin = path.join(directory, 'commands with spaces')
  await mkdir(bin)
  await mkdir(path.join(directory, 'tools'))
  await copyFile(source, path.join(directory, 'tools/verify_toolchain.mjs'))
  await writeFile(path.join(directory, '.node-version'), `${process.versions.node}\n`)
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.19.0' }))
  await writeFile(path.join(directory, 'rust-toolchain.toml'), rustToml)
  await writeFile(path.join(bin, 'command-fixture.mjs'), fixtureProgram)
  const responses = {
    pnpm: { stdout: '11.19.0' }, rustc: { stdout: 'rustc 1.98.1 (fixture)' },
    cargo: { stdout: 'cargo 1.98.1 (fixture)' }, rustfmt: { stdout: 'rustfmt 1.9.0-stable (fixture)' },
    'cargo-clippy': { stdout: 'clippy 0.1.98 (fixture)' },
  }
  const wrapperPath = (name) => path.join(bin, name + (process.platform === 'win32' ? '.cmd' : ''))
  for (const name of names) {
    const wrapper = process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "%~dp0command-fixture.mjs" ${name} %*\r\nexit /b %ERRORLEVEL%\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${path.join(bin, 'command-fixture.mjs').replaceAll("'", "'\\''")}' ${name} "$@"\n`
    await writeFile(wrapperPath(name), wrapper, { mode: 0o755 })
  }
  async function run(extraArgs = []) {
    await writeFile(path.join(bin, 'responses.json'), JSON.stringify(responses))
    const result = spawnSync(process.execPath, [path.join(directory, 'tools/verify_toolchain.mjs'), ...extraArgs], {
      // The CLI must resolve declarations relative to its own file, not this cwd.
      cwd: tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, PATH: bin, ECORP_DOCTOR_SECRET_CANARY: secret },
    })
    assert.ifError(result.error)
    assert.equal(result.stderr, '')
    assert.ok(!result.stdout.includes(secret))
    return { exitCode: result.status, report: JSON.parse(result.stdout) }
  }
  async function calls() {
    try { return (await readFile(path.join(bin, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  return { directory, responses, wrapperPath, run, calls }
}

test('relocated doctor checks declared tools through native version commands without leaking ambient secrets or installing', async (t) => {
  const f = await fixture(t)
  const result = await f.run()
  assert.equal(result.exitCode, 0)
  assert.equal(result.report.ok, true)
  assert.equal(result.report.checks.length, 6)
  assert.equal(result.report.rustSelection, 'pinned installed rustup toolchain')
  const calls = await f.calls()
  assert.equal(calls.length, 5)
  assert.ok(calls.every((call) => !call.secretInherited && call.networkDisabled))
  const pnpm = calls.find((call) => call.name === 'pnpm')
  assert.deepEqual(pnpm.args, ['--ignore-pnpmfile', '--pm-on-fail=error', '--version'])
  assert.notEqual(pnpm.cwd, f.directory)
  assert.deepEqual(calls.filter((call) => call.name === 'rustup').map((call) => call.args), [
    ['run', '1.98.1', 'rustc', '--version'], ['run', '1.98.1', 'cargo', '--version'],
    ['run', '1.98.1', 'rustfmt', '--version'], ['run', '1.98.1', 'cargo-clippy', '--version'],
  ])
})

for (const [tool, stdout] of [
  ['node', '0.0.0'], ['pnpm', '10.0.0'], ['rustc', 'rustc 1.97.0 (fixture)'], ['cargo', 'cargo 1.97.0 (fixture)'],
]) {
  test(`wrong ${tool} version produces a failing CLI result`, async (t) => {
    const f = await fixture(t)
    if (tool === 'node') await writeFile(path.join(f.directory, '.node-version'), stdout)
    else f.responses[tool].stdout = stdout
    const result = await f.run()
    assert.equal(result.exitCode, 1)
    assert.equal(result.report.ok, false)
    assert.equal(result.report.checks.find((check) => check.tool === tool).ok, false)
    assert.equal(result.report.checks.filter((check) => !check.ok).length, 1)
  })
}

test('missing package manager fails without falling back to another host command', async (t) => {
  const f = await fixture(t)
  await rm(f.wrapperPath('pnpm'))
  const result = await f.run()
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.checks.find((check) => check.tool === 'pnpm').error, 'command_missing')
})

test('failed component probes suppress raw stdout and stderr', async (t) => {
  const f = await fixture(t)
  f.responses.rustfmt = { status: 1, stdout: secret, stderr: secret }
  const result = await f.run()
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.checks.find((check) => check.tool === 'rustfmt').error, 'command_failed')
})

test('unrecognized version output is rejected without echoing the command response', async (t) => {
  const f = await fixture(t)
  f.responses.pnpm.stdout = secret
  const result = await f.run()
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.checks.find((check) => check.tool === 'pnpm').error, 'version_unrecognized')
})

test('an unavailable pinned rustup toolchain fails instead of installing or selecting stable', async (t) => {
  const f = await fixture(t)
  for (const tool of ['rustc', 'cargo', 'rustfmt', 'cargo-clippy']) f.responses[tool].status = 1
  const result = await f.run()
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.checks.filter((check) => !check.ok).length, 4)
  assert.ok((await f.calls()).every((call) => !call.args.includes('--install') && !call.args.includes('stable')))
})

test('already selected direct Rust binaries can be verified without rustup', async (t) => {
  const f = await fixture(t)
  await rm(f.wrapperPath('rustup'))
  const result = await f.run()
  assert.equal(result.exitCode, 0)
  assert.equal(result.report.rustSelection, 'direct commands on PATH')
  assert.ok((await f.calls()).filter((call) => call.name !== 'pnpm')
    .every((call) => call.args.length === 1 && call.args[0] === '--version'))
})

for (const [file, content] of [
  ['.node-version', 'latest'], ['package.json', '{"packageManager":"pnpm@latest"}'],
  ['rust-toolchain.toml', rustToml.replace('"1.98.1"', '"stable"')],
  ['rust-toolchain.toml', rustToml.replace('["rustfmt", "clippy"]', '["rustfmt"]')],
]) {
  test(`invalid ${file} declaration fails before any command runs (${content.includes('stable') ? 'floating Rust' : content.includes('rustfmt') ? 'component' : 'version'})`, async (t) => {
    const f = await fixture(t)
    await writeFile(path.join(f.directory, file), content)
    const result = await f.run()
    assert.equal(result.exitCode, 1)
    assert.ok(result.report.error)
    assert.deepEqual(await f.calls(), [])
  })
}

test('unsupported CLI arguments fail before probing tools', async (t) => {
  const f = await fixture(t)
  const result = await f.run(['--install'])
  assert.equal(result.exitCode, 1)
  assert.match(result.report.error, /^Usage:/)
  assert.deepEqual(await f.calls(), [])
})
