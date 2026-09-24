import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { reportFiles, root, sourceIdentity, validateReports } from './native_qualification_attempt.mjs'

const hash = (value) => createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex')
const surfaces = Object.keys(reportFiles)
const signIdentity = (value) => {
  const { sha256, ...identity } = value
  return { ...identity, sha256: hash(identity) }
}

function fixture() {
  const identity = signIdentity({
    base_commit: 'a'.repeat(40),
    branch: 'synthetic-qualification',
    source_files: [{ path: 'tools\\synthetic.mjs', sha256: hash('source'), bytes: 6 }],
    binaries: [{ name: 'synthetic-server', sha256: hash('binary'), bytes: 6 }],
    processes: [{ name: 'synthetic-server', pid: 12345 }],
    proxy: null,
  })
  const current = {
    schema_version: 1,
    attempt_id: 'synthetic-current-attempt',
    started_at: '2026-09-17T12:00:00.000Z',
    identity,
    preserved: [],
    surfaces: {},
  }
  const reports = Object.fromEntries(surfaces.map((name) => [name, {
    ...(name === 'archive' ? { complete: true } : { phase: 'readback_complete' }),
    current_attempt: {
      attempt_id: current.attempt_id,
      identity_sha256: identity.sha256,
      status: 'succeeded',
      finished_at: '2026-09-17T12:01:00.000Z',
    },
  }]))
  for (const name of surfaces) {
    current.surfaces[name] = { status: 'succeeded', report_sha256: hash(reports[name]) }
  }
  return { current, observedIdentity: structuredClone(identity), reports }
}

const validate = ({ current, observedIdentity, reports }) => validateReports(current, observedIdentity, reports)
const refreshMarker = ({ current, reports }, name) => {
  current.surfaces[name].report_sha256 = hash(reports[name])
}
const rejects = (value, message) => assert.throws(() => validate(value), {
  name: 'AssertionError',
  ...(message ? { message } : {}),
})

// Models the old success-field-only acceptance, which ignored current failure evidence.
const oldAcceptance = (reports) => reports.runtime?.phase === 'readback_complete'
  && reports.browser?.phase === 'readback_complete' && reports.archive?.complete === true

test('all three matching successful reports pass without changing inputs', () => {
  assert.deepEqual(surfaces, ['runtime', 'browser', 'archive'])
  const value = fixture()
  const before = structuredClone(value)
  assert.equal(oldAcceptance(value.reports), true)
  assert.doesNotThrow(() => validate(value))
  assert.deepEqual(value, before)
})

for (const name of ['runtime', 'browser']) {
  test(`${name} old success phase plus current failure passes old predicate but is rejected`, () => {
    const value = fixture()
    value.reports[name].failure = { message: 'Synthetic current readback failed' }
    refreshMarker(value, name)
    assert.equal(value.reports[name].phase, 'readback_complete')
    assert.equal(oldAcceptance(value.reports), true)
    rejects(value, new RegExp(`Current ${name} report contains failure`))
  })
}

test('old archive success cannot override the latest failed attempt marker', () => {
  const value = fixture()
  value.current.surfaces.archive.status = 'failed'
  assert.equal(oldAcceptance(value.reports), true)
  rejects(value, /Current archive attempt did not succeed/)
})

test('missing archive fails even when its success marker remains', () => {
  const value = fixture()
  delete value.reports.archive
  rejects(value, /Current archive report contains failure/)
})

test('archive complete false fails even with matching successful stamp and hash', () => {
  const value = fixture()
  value.reports.archive.complete = false
  refreshMarker(value, 'archive')
  rejects(value)
})

for (const name of surfaces) {
  for (const status of ['pending', 'running', 'failed']) {
    test(`${name} ${status} marker rejects a successful report`, () => {
      const value = fixture()
      value.current.surfaces[name].status = status
      rejects(value, new RegExp(`Current ${name} attempt did not succeed`))
    })
  }

  test(`${name} missing marker rejects a successful report`, () => {
    const value = fixture()
    delete value.current.surfaces[name]
    rejects(value, new RegExp(`Current ${name} attempt did not succeed`))
  })

  test(`${name} mismatched attempt ID rejects despite a matching marker hash`, () => {
    const value = fixture()
    value.reports[name].current_attempt.attempt_id = 'synthetic-previous-attempt'
    refreshMarker(value, name)
    rejects(value, new RegExp(`${name} attempt mismatch`))
  })

  test(`${name} mismatched identity SHA256 rejects despite a matching marker hash`, () => {
    const value = fixture()
    value.reports[name].current_attempt.identity_sha256 = hash('other-identity')
    refreshMarker(value, name)
    rejects(value, new RegExp(`${name} identity mismatch`))
  })

  test(`${name} missing current attempt stamp rejects`, () => {
    const value = fixture()
    delete value.reports[name].current_attempt
    refreshMarker(value, name)
    rejects(value, new RegExp(`${name} attempt mismatch`))
  })

  for (const status of ['pending', 'running', 'failed']) {
    test(`${name} ${status} report state rejects despite succeeded marker`, () => {
      const value = fixture()
      value.reports[name].current_attempt.status = status
      refreshMarker(value, name)
      rejects(value, new RegExp(`${name} report incomplete`))
    })
  }

  for (const field of ['failure', 'error']) {
    for (const payload of [{ message: 'Synthetic failure' }, null, false, '']) {
      test(`${name} own ${field} field ${JSON.stringify(payload)} cannot be hidden by success`, () => {
        const value = fixture()
        value.reports[name][field] = payload
        refreshMarker(value, name)
        rejects(value, new RegExp(`Current ${name} report contains failure`))
      })
    }
  }

  test(`${name} marker hash tampering rejects unchanged successful report`, () => {
    const value = fixture()
    value.current.surfaces[name].report_sha256 = hash('tampered-marker')
    rejects(value, new RegExp(`${name} report changed after success`))
  })

  test(`${name} report changed after success rejects even if semantic success remains`, () => {
    const value = fixture()
    value.reports[name].extra = 'changed after marker was written'
    rejects(value, new RegExp(`${name} report changed after success`))
  })
}

for (const name of ['runtime', 'browser']) {
  test(`${name} incomplete phase rejects even with matching stamp and hash`, () => {
    const value = fixture()
    value.reports[name].phase = 'readback_running'
    refreshMarker(value, name)
    rejects(value)
  })
}

for (const [name, change] of [
  ['source', (identity) => { identity.source_files[0].sha256 = hash('changed-source') }],
  ['binary', (identity) => { identity.binaries[0].sha256 = hash('changed-binary') }],
  ['process', (identity) => { identity.processes[0].pid += 1 }],
]) {
  test(`changed observed ${name} identity rejects all otherwise matching reports`, () => {
    const value = fixture()
    change(value.observedIdentity)
    value.observedIdentity = signIdentity(value.observedIdentity)
    assert.notEqual(value.observedIdentity.sha256, value.current.identity.sha256)
    rejects(value, /Source\/binary\/process identity changed during readback/)
  })
}

test('absent current descriptor fails closed', () => {
  const value = fixture()
  value.current = null
  rejects(value, /Begin a current qualification attempt first/)
})

test('current descriptor without identity hash fails closed', () => {
  const value = fixture()
  delete value.current.identity.sha256
  rejects(value, /Begin a current qualification attempt first/)
})

test('native Git source identity covers schema, contracts and other source inputs', async (t) => {
  const temporaryRoot = await realpath(tmpdir())
  const directory = await mkdtemp(path.join(temporaryRoot, 'ecorp-qualification-identity-'))
  t.after(async () => {
    const resolved = await realpath(directory)
    assert.equal(path.dirname(resolved), temporaryRoot, 'Cleanup must stay inside the owned temporary parent')
    assert.ok(path.basename(resolved).startsWith('ecorp-qualification-identity-'))
    await rm(resolved, { recursive: true, force: true })
  })
  const git = (cwd, args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const write = async (file, bytes) => {
    const destination = path.join(directory, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  // Use every checked-in schema/contract input, not a hand-maintained subset.
  const inputs = git(root, ['ls-files', '-z', '--', 'db', 'contracts', 'foundry.toml']).split('\0').filter(Boolean)
  assert.ok(inputs.includes('db/migrations/manifest.json'))
  assert.ok(inputs.includes('contracts/ECorpCheckpointRegistryV1.compiled.json'))
  assert.ok(inputs.includes('foundry.toml'))
  git(directory, ['init', '--quiet', '--template='])
  await write('.gitignore', await readFile(path.join(root, '.gitignore')))
  for (const file of inputs) await write(file, await readFile(path.join(root, file)))
  for (const file of ['scripts/fake-agent.mjs', 'pnpm-workspace.yaml', 'new-source/input.txt', 'tools/control.mjs']) {
    await write(file, 'initial source\n')
    inputs.push(file)
  }
  git(directory, ['add', '.'])
  git(directory, ['-c', 'user.name=Qualification test', '-c', 'user.email=qualification@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=.git/no-hooks', 'commit', '--quiet', '-m', 'Owned fixture'])
  const head = git(directory, ['rev-parse', 'HEAD'])
  const before = await sourceIdentity(directory)
  assert.deepEqual(await sourceIdentity(directory), before)
  for (const file of inputs) {
    await t.test(`uncommitted ${file} changes actual source identity`, async () => {
      const original = await readFile(path.join(directory, file))
      try {
        // Same-size changes prove content hashing, not just a path/size check.
        const changed = Buffer.from(original)
        changed[0] ^= 1
        await write(file, changed)
        const after = await sourceIdentity(directory)
        assert.notEqual(hash(after), hash(before), `${file} must affect source identity without commit or rebuild`)
        const entry = after.find((value) => value.path === file.replaceAll('/', '\\'))
        assert.deepEqual(entry, { path: file.replaceAll('/', '\\'),
          sha256: createHash('sha256').update(changed).digest('hex'), bytes: changed.length })
      } finally {
        await write(file, original)
      }
    })
  }
  await t.test('nonignored untracked schema and contract inputs are included', async () => {
    for (const file of ['db/migrations/new.sql', 'contracts/New.sol', 'new-source/untracked.txt']) {
      const previous = await sourceIdentity(directory)
      await write(file, 'new uncommitted source\n')
      const after = await sourceIdentity(directory)
      assert.notEqual(hash(after), hash(previous), `${file} must affect source identity before git add`)
      assert.ok(after.some((entry) => entry.path === file.replaceAll('/', '\\')))
    }
  })
  await t.test('ignored credentials and generated runtime evidence remain excluded', async () => {
    const previous = await sourceIdentity(directory)
    for (const file of ['.env', '.env.local', 'contracts/.env', 'output/native-qualification/phase2/current-attempt.json',
      'target/foundry/out/registry.json', 'target-native-qualification/debug/build/generated.json',
      'apps/web/dist/index.html', 'tools/registry-toolchain/node_modules/generated.js']) {
      await write(file, 'synthetic ignored input, not a real credential\n')
      assert.deepEqual(await sourceIdentity(directory), previous, `${file} must not affect source identity`)
      await write(file, 'changed generated input\n')
      assert.deepEqual(await sourceIdentity(directory), previous, `${file} changes must remain excluded`)
    }
  })
  assert.equal(git(directory, ['rev-parse', 'HEAD']), head, 'No commits or builds during identity checks')
})
