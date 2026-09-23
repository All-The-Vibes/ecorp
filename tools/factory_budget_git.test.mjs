import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, access, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execFile = promisify(execFileCallback)
const driver = readFileSync(new URL('./e2e_factory_budget_recovery.mjs', import.meta.url), 'utf8')
const environmentStart = driver.indexOf('const env = ')
const environmentEnd = driver.indexOf('const children = []', environmentStart)
const boundary = "  assert.equal(await exists(path.join(pgData,'postmaster.pid'))"
const first = driver.indexOf('\n', driver.indexOf(boundary)) + 1
const last = driver.indexOf('  const pgChild', first)
assert.ok(environmentStart >= 0 && environmentEnd > environmentStart && first > 0 && last > first)
const source = new Function('ctx', `return (async () => {
  const {assert, path, mkdir, writeFile, readFile, realpath, exists, source, sourceReadme, qa, attempt, report, env, run} = ctx;
  ${driver.slice(first, last)}
})()`)

test('PR237 synthetic Git setup ignores caller hooks, templates and signing configuration', async t => {
  const qa = await mkdtemp(path.join(await realpath(os.tmpdir()), 'ecorp-git-isolation-'))
  const attempt = path.join(qa, 'attempt')
  const user = path.join(qa, 'caller-profile')
  const templates = path.join(user, 'templates')
  const hooks = path.join(user, 'hooks')
  const marker = path.join(qa, 'caller-hook-ran')
  await mkdir(attempt)
  await mkdir(templates, { recursive: true })
  await mkdir(hooks)
  await writeFile(path.join(templates, 'caller-template'), 'caller-owned sentinel')
  const quotedMarker = "'" + marker.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'"
  await writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\nprintf invoked > ${quotedMarker}\nexit 1\n`, { mode: 0o700 })
  const config = `[user]\nname = Caller\nemail = caller@example.invalid\n[core]\nhooksPath = ${JSON.stringify(hooks.replaceAll('\\', '/'))}\n[init]\ntemplateDir = ${JSON.stringify(templates.replaceAll('\\', '/'))}\n[commit]\ngpgSign = true\n[gpg]\nprogram = deliberately-unavailable-synthetic-signer\n`
  await writeFile(path.join(user, '.gitconfig'), config)
  const parent = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'pathext', 'temp', 'tmp'].includes(key.toLowerCase())))
  Object.assign(parent, { USERPROFILE: user, HOME: user,
    HOMEDRIVE: path.parse(user).root.slice(0, 2), HOMEPATH: user.slice(2) })
  const env = new Function('process', 'path', 'attempt',
    driver.slice(environmentStart, environmentEnd) + '; return env')({ env: parent }, path, attempt)
  const run = (program, args, extra = {}) => execFile(program, args, {
    cwd: qa, env, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, ...extra,
  })
  const exists = file => access(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const report = {}
  try {
    await source({ assert, path, mkdir, writeFile, readFile, realpath, exists, qa, attempt, env, run, report,
      source: path.join(qa, 'source'), sourceReadme: '# Synthetic source\n' })
    assert.match(report.fixture_source_commit, /^[0-9a-f]{40}$/u)
    assert.equal(await exists(marker), false, 'Caller hooks must never execute')
    assert.equal(await exists(path.join(qa, 'source', '.git', 'caller-template')), false)
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1', 'System Git configuration must also be excluded')
    assert.equal(await readFile(path.join(user, '.gitconfig'), 'utf8'), config)
  } finally { t.diagnostic(`Retained synthetic Git fixture: ${qa}`) }
})
