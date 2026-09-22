import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(directory, 'local_source_commit.test.ps1')
const environment = {}
for (const name of [
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
  'PSModulePath', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
]) {
  if (process.env[name] !== undefined) environment[name] = process.env[name]
}
Object.assign(environment, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_GLOBAL: 'NUL',
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 'ECorp source fixture', GIT_COMMITTER_NAME: 'ECorp source fixture',
  GIT_AUTHOR_EMAIL: 'source-fixture@example.invalid', GIT_COMMITTER_EMAIL: 'source-fixture@example.invalid',
})

function git(repository, ...args) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    env: environment, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, 'Disposable Git fixture command failed')
  return result.stdout.trim()
}

async function snapshot(root, relative = '') {
  const entries = []
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name)
    if (entry.isDirectory()) entries.push(...await snapshot(root, name))
    else {
      assert.ok(entry.isFile(), 'Disposable source fixture contains only regular files')
      entries.push([name, createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')])
    }
  }
  return entries.sort(([a], [b]) => a.localeCompare(b))
}

test('native source preflight ignores inherited Git redirects and trace writers', {
  skip: process.platform !== 'win32' ? 'Windows startup helper requires native PowerShell' : false,
}, async (t) => {
  const temporary = await realpath(os.tmpdir())
  const root = await realpath(await mkdtemp(path.join(temporary, 'ecorp-source-preflight-')))
  const source = path.join(root, 'source [literal]')
  const other = path.join(root, 'other repository')
  let passed = true
  try {
    for (const [repository, content] of [[source, 'source\n'], [other, 'other\n']]) {
      await mkdir(repository)
      git(repository, 'init', '--quiet')
      await writeFile(path.join(repository, 'tracked.txt'), content)
      git(repository, 'add', 'tracked.txt')
      git(repository, 'commit', '--quiet', '-m', 'Disposable source fixture')
    }
    const expected = git(source, 'rev-parse', 'HEAD')
    assert.notEqual(git(other, 'rev-parse', 'HEAD'), expected)
    const cases = [
      ['baseline', {}],
      ['repository redirect', { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: source }],
      ...['GIT_TRACE', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_SETUP',
        'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF'].map((name) => [
        name, { [name]: path.join(source, `${name.toLowerCase()}.log`) },
      ]),
    ]
    for (const [name, overrides] of cases) {
      await t.test(name, async () => {
        try {
          const before = await snapshot(root)
          const result = spawnSync('pwsh.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
            '-Repository', source, '-Ref', 'HEAD',
          ], {
            cwd: root, env: { ...environment, ...overrides }, encoding: 'utf8',
            windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
          })
          assert.ifError(result.error)
          assert.equal(result.status, 0, `Source inspection failed: ${name}`)
          const prefix = 'ECORP_SOURCE_COMMIT_RESULT='
          const lines = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith(prefix))
          assert.equal(lines.length, 1)
          const report = JSON.parse(lines[0].slice(prefix.length))
          assert.equal(report.commit, expected, 'Commit must come from the configured source')
          assert.equal(report.environment_unchanged, true)
          const after = await snapshot(root)
          assert.equal(JSON.stringify(after) === JSON.stringify(before), true,
            'Preflight must not change source, refs, index, or other repository')
        } catch (error) {
          passed = false
          throw error
        }
      })
    }
  } catch (error) {
    passed = false
    throw error
  } finally {
    if (passed) {
      const relative = path.relative(temporary, root)
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      assert.equal(await realpath(root), root)
      await rm(root, { recursive: true })
    } else t.diagnostic(`Failed disposable source fixture preserved at ${root}`)
  }
})
