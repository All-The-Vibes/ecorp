import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { verifyReplaySource } from './check_replay_source.mjs'

test('published replay reconstructs an unreferenced source tree in a fresh clone and rejects drift', () => {
  const owned = mkdtempSync(path.join(os.tmpdir(), 'ecorp-replay-source-test-'))
  let passed = false
  const repository = path.join(owned, 'author')
  const clone = path.join(owned, 'arbitrary-checkout-name')
  const packet = 'docs/evidence/pr-queue-completion-fixture'
  const globalConfig = path.join(owned, 'empty.gitconfig')
  writeFileSync(globalConfig, '')
  const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig },
  }).trim()
  try {
    mkdirSync(repository)
    git(repository, 'init', '-b', 'main')
    git(repository, 'config', 'user.name', 'ECorp replay fixture')
    git(repository, 'config', 'user.email', 'fixture@ecorp.invalid')
    git(repository, 'config', 'core.autocrlf', 'false')
    writeFileSync(path.join(repository, '.gitattributes'), '* -text\n')
    writeFileSync(path.join(repository, 'package.json'), '{"scripts":{}}\n')
    writeFileSync(path.join(repository, 'source.txt'), 'baseline\n')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'Owned fixture baseline')
    writeFileSync(path.join(repository, 'source.txt'), 'reviewed source\n')
    git(repository, 'add', 'source.txt')
    const tree = git(repository, 'write-tree')
    const checks = ['migrations', 'documentation', 'rust-format', 'rust-clippy', 'rust-workspace', 'node-unit', 'steward', 'web-build', 'web-lint']
    const receipt = { status: 'passed', prs: [354, 355], tested_staged_tree: tree,
      checks: checks.map(name => ({ name, exit_code: 0 })) }
    mkdirSync(path.join(repository, packet), { recursive: true })
    writeFileSync(path.join(repository, packet, 'validation.json'), JSON.stringify(receipt))
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'Reviewed source with its later evidence addition')
    git(repository, 'clone', '--no-local', repository, clone)
    const absent = spawnSync('git', ['-C', clone, 'cat-file', '-e', tree], { windowsHide: true })
    assert.notEqual(absent.status, 0, 'the validation tree was never a reachable commit tree')
    const directory = path.join(clone, packet)
    const index = path.join(clone, '.git', 'index')
    const verify = (expectedError) => {
      const bytes = readFileSync(index)
      try {
        if (expectedError) assert.throws(() => verifyReplaySource(clone, directory, 354), expectedError)
        else {
          const result = verifyReplaySource(clone, directory, 354)
          assert.equal(result.validation_source_tree, tree)
          assert.equal(result.tested_staged_tree, git(clone, 'rev-parse', 'HEAD^{tree}'))
          assert.match(result.validation_receipt_sha256, /^[a-f0-9]{64}$/u)
        }
      } finally { assert.deepEqual(readFileSync(index), bytes, 'verification never changes the real index') }
    }
    verify()
    writeFileSync(path.join(clone, 'source.txt'), 'unstaged change\n')
    verify(/unstaged or untracked/u)
    git(clone, 'add', 'source.txt')
    verify(/Product source changed/u)
    git(clone, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'source.txt')
    writeFileSync(path.join(clone, 'untracked.txt'), 'unreviewed\n')
    verify(/unstaged or untracked/u)
    rmSync(path.join(clone, 'untracked.txt'))
    const receiptPath = path.join(directory, 'validation.json')
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, checks: receipt.checks.slice(1) }))
    verify(/all current contributor gates/u)
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, prs: [355] }))
    verify(/all current contributor gates/u)
    git(clone, 'restore', '--source=HEAD', '--worktree', '--', packet)
    // Current source with the audit package must not borrow a historical nine-gate receipt.
    writeFileSync(path.join(clone, 'package.json'), '{"scripts":{"check:state-audit-compatibility":"fixture"}}\n')
    git(clone, 'add', 'package.json')
    verify(/all current contributor gates/u)
    git(clone, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'package.json')
    const noRepository = path.join(owned, 'not-a-repository')
    mkdirSync(noRepository)
    writeFileSync(path.join(noRepository, 'package.json'), '{"scripts":{}}\n')
    assert.throws(() => verifyReplaySource(noRepository, directory, 354), /Git source verification failed/u)
    verify()
    passed = true
  } finally {
    if (passed) rmSync(owned, { recursive: true })
    else console.error(`Failed owned replay fixture retained: ${owned}`)
  }
})
