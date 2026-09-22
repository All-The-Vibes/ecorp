// Real Git/filesystem containment checks; no browser or product stack is started.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const driver = fileURLToPath(new URL('./e2e_verifier_browser.mjs', import.meta.url))
const osEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|TMPDIR)$/iu.test(key)))

for (const scenario of ['missing-inside', 'existing-inside', 'aliased-inside', 'valid-sibling']) {
  test('browser evidence output scope: ' + scenario, async (t) => {
    const root = await realpath(await mkdtemp(path.join(process.env.F03_RECEIPTS ?? tmpdir(), 'F03-' + scenario + '-')))
    t.diagnostic('Retained independent Git fixture and receipts: ' + root)
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'worktree')
    const hooks = path.join(root, 'empty-hooks')
    const globalConfig = path.join(root, 'empty-gitconfig')
    await mkdir(hooks)
    await writeFile(globalConfig, '')
    const env = { ...osEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig }
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + hooks,
      '-c', 'commit.gpgSign=false', '-c', 'user.name=ECorp fixture',
      '-c', 'user.email=fixture@invalid', ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true })
    git('init', '--initial-branch=main', source)
    await writeFile(path.join(source, 'README.md'), 'Owned output-scope fixture; preserve these bytes.\n')
    git('-C', source, 'add', 'README.md')
    git('-C', source, 'commit', '-m', 'Create independent containment fixture')
    git('-C', source, 'worktree', 'add', '--detach', workspace, 'HEAD')
    let output = path.join(workspace, 'missing', 'nested', 'evidence')
    if (scenario === 'existing-inside') {
      output = path.join(workspace, 'existing')
      await mkdir(output)
    } else if (scenario === 'aliased-inside') {
      const alias = path.join(root, 'external-alias')
      await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
      output = path.join(alias, 'missing', 'evidence')
    } else if (scenario === 'valid-sibling') {
      output = path.join(root, 'sibling', 'evidence')
    }
    const beforeNames = (await readdir(workspace, { recursive: true })).sort()
    const beforeReadme = await readFile(path.join(workspace, 'README.md'))
    const beforeGit = await readFile(path.join(workspace, '.git'))
    const startedAt = new Date().toISOString()
    const run = spawnSync(process.execPath, [driver], {
      cwd: workspace, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...env, CRONY_BROWSER_TEST_WORKTREE: workspace, CRONY_BROWSER_TEST_OUTPUT: output },
    })
    await writeFile(path.join(root, 'driver.stdout.log'), run.stdout ?? '')
    await writeFile(path.join(root, 'driver.stderr.log'), run.stderr ?? '')
    const afterNames = (await readdir(workspace, { recursive: true })).sort()
    await writeFile(path.join(root, 'execution.json'), JSON.stringify({
      scenario, command: [process.execPath, driver], workspace, output, startedAt,
      finishedAt: new Date().toISOString(), exitCode: run.status, signal: run.signal,
      error: run.error?.message, beforeNames, afterNames,
      driverSha256: createHash('sha256').update(await readFile(driver)).digest('hex'),
      scope: 'Actual driver and independent Git worktree. No Playwright, browser or product stack.',
    }, null, 2))
    assert.ifError(run.error)
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, scenario === 'valid-sibling'
      ? /Installed Playwright module required/u : /Evidence must be outside the worktree/u)
    assert.deepEqual(afterNames, beforeNames, 'Rejected evidence scope must not create worktree directories')
    assert.deepEqual(await readFile(path.join(workspace, 'README.md')), beforeReadme)
    assert.deepEqual(await readFile(path.join(workspace, '.git')), beforeGit)
    if (scenario === 'valid-sibling') {
      assert.equal((await lstat(output)).isDirectory(), true, 'External output reaches the next prerequisite')
    } else if (scenario !== 'existing-inside') {
      await assert.rejects(lstat(output), { code: 'ENOENT' })
    }
  })
}
