import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const job = name => {
  const body = workflow.split(new RegExp(`^  ${name}:\\r?\\n`, 'm'))[1]?.split(/^  [\w-]+:/m)[0]
  assert.ok(body, `missing ${name} job`)
  return body
}

test('quality selects existing contracts and PR255 pure frontend/QA regressions', () => {
  const quality = job('quality')
  const commands = [...quality.matchAll(/^        run: node --test (.+)$/gm)]
    .flatMap(match => match[1].trim().split(/\s+/))
  for (const file of [
    'tools/e2e_external_adapters.test.mjs',
    'tools/fixture_source_identity.test.mjs',
    'tools/owned_test_stack.test.mjs',
    'apps/web/src/factoryAuthority.test.mjs',
    'apps/web/src/factoryAuthorityConnection.test.mjs',
    'apps/web/src/snapshotRefresh.test.mjs',
    'tools/issue161/qa-api-provenance.test.mjs',
    'tools/ci_runner_tests.test.mjs',
  ]) assert.ok(commands.includes(file), `${file} must run in quality`)
})

test('quality provisions the exact QA source before the provenance test, outside test code', () => {
  const quality = job('quality')
  const fetch = quality.indexOf('run: git fetch --no-tags origin b31a38a62330aacba80c3953142e1da957a63ecd')
  assert.ok(fetch >= 0, 'shallow checkout needs an explicit native fetch of the pinned QA commit')
  assert.ok(fetch < quality.indexOf('tools/issue161/qa-api-provenance.test.mjs'))
  const source = readFileSync(new URL('./issue161/qa-api-provenance.test.mjs', import.meta.url), 'utf8')
  assert.match(source, /const baseCommit = 'b31a38a62330aacba80c3953142e1da957a63ecd'/)
  assert.match(source, /\['show', `\$\{baseCommit\}:\$\{helper\}`\]/)
  assert.doesNotMatch(source, /['"]fetch['"]/)
})

test('identity regression runs only in the existing Windows matrix lane before lifecycle checks', () => {
  const lane = job('runner-platforms')
  assert.match(lane, /os: \[ubuntu-latest, windows-latest, macos-latest\]/)
  assert.match(lane, /if: runner\.os == 'Windows'\r?\n        shell: pwsh\r?\n        run: \.\/tools\/local_stack_identity\.test\.ps1/)
  assert.ok(lane.indexOf('./tools/local_stack_identity.test.ps1') < lane.indexOf('run: cargo test -p crony-runner'))
  assert.equal(workflow.match(/run: \.\/tools\/local_stack_identity\.test\.ps1/g)?.length, 1)
})

test('remote actions use immutable SHAs under the repository Actions policy', () => {
  const actions = [...workflow.matchAll(/^\s+(?:- )?uses: (\S+)/gm)]
  assert.ok(actions.length > 0)
  for (const [, action] of actions) assert.match(action, /^[\w./-]+@[a-f0-9]{40}$/)
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m)
})
