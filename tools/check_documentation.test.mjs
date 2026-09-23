import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { RUNTIME_DOCUMENTS, VALIDATION_DOCUMENTS, validateDocumentation } from './check_documentation.mjs'

const execute = promisify(execFile)
const runtimeSource = 'crates/crony-runner/src/adapter/copilot.rs'
const commands = ['node tools/check_migrations.mjs', 'cargo test --workspace', 'pnpm build:web']
const validationBlock = (lines = commands) => `<!-- ecorp:validation-commands -->\n\x60\x60\x60powershell\n${lines.join('\n')}\n\x60\x60\x60\n<!-- /ecorp:validation-commands -->\n`
const runtimeBlock = (sdk = '1.0.11', cli = '1.0.79') => `<!-- ecorp:copilot-runtime -->\nCurrent Rust SDK \x60${sdk}\x60 with CLI \x60${cli}\x60.\n<!-- /ecorp:copilot-runtime -->\n`

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ecorp-doc-contract-'))
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('ecorp-doc-contract-'))
    await rm(root, { recursive: true, force: true })
  })
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), text)
  }
  const replace = async (file, from, to) => put(file, (await readFile(path.join(root, file), 'utf8')).replace(from, to))
  const scripts = {
    'check:migrations': 'node tools/check_migrations.mjs',
    'build:web': 'pnpm --dir apps/web build',
    check: 'pnpm check:migrations && cargo test --workspace && pnpm build:web',
  }
  const saveScripts = () => put('package.json', JSON.stringify({ scripts }))
  await saveScripts()
  await put('Cargo.toml', '[workspace.dependencies]\ngithub-copilot-sdk = "=1.0.11"\n')
  await put(runtimeSource, 'const SUPPORTED_COPILOT_RUNTIME: &str = "1.0.79";\n')
  for (const file of VALIDATION_DOCUMENTS) await put(file, validationBlock())
  for (const file of RUNTIME_DOCUMENTS) await put(file, runtimeBlock())
  return { root, put, replace, scripts, saveScripts, validate: () => validateDocumentation(root) }
}

test('accepts matching current contracts, aliases, CRLF and historical prose outside markers', async (t) => {
  const f = await fixture(t)
  await f.put('AGENTS.md', validationBlock(['pnpm run check:migrations', ...commands.slice(1)]).replaceAll('\n', '\r\n'))
  await f.put('docs/SECURITY.md', `${runtimeBlock()}\nHistorical SDK \x601.0.0\x60 with CLI \x601.0.1\x60.\n`)
  const result = await f.validate()
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
  assert.equal(result.validationDocuments, 5)
  assert.equal(result.runtimeDocuments, 2)
  assert.equal(result.validationCommands, 3)
  assert.match(result.scope, /only$/)
})

for (const [name, change] of [
  ['added', (s) => `${s} && node tools/new_check.mjs`],
  ['removed', (s) => s.replace('cargo test --workspace && ', '')],
  ['reordered', () => 'cargo test --workspace && pnpm check:migrations && pnpm build:web'],
]) {
  test(`rejects ${name} source validation command and reports expected and actual`, async (t) => {
    const f = await fixture(t)
    f.scripts.check = change(f.scripts.check)
    await f.saveScripts()
    const result = await f.validate()
    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 5)
    assert.match(result.errors[0], /AGENTS.md:1:.*package.json scripts.check/)
    assert.match(result.errors[0], /Expected:[\s\S]+Actual:/)
  })
}

test('rejects changed documented commands; correcting the documented sequence restores passing', async (t) => {
  const f = await fixture(t)
  await f.replace('docs/EVALS.md', 'cargo test --workspace', 'cargo fmt --check')
  assert.match((await f.validate()).errors.join('\n'), /docs\/EVALS.md:1: validation commands differ/)
  await f.put('docs/EVALS.md', validationBlock())
  assert.equal((await f.validate()).ok, true)
  f.scripts.check += ' && node tools/new_check.mjs'
  await f.saveScripts()
  for (const file of VALIDATION_DOCUMENTS) await f.put(file, validationBlock([...commands, 'node tools/new_check.mjs']))
  assert.equal((await f.validate()).ok, true)
})

test('accepts quoted literal Node globs through aliases while preserving quoted versus shell-expanded arguments', async (t) => {
  const f = await fixture(t)
  f.scripts['test:unit'] = 'node --test --test-concurrency=2 "tools/*.test.mjs"'
  f.scripts.check += ' && pnpm test:unit'
  await f.saveScripts()
  for (const file of VALIDATION_DOCUMENTS) await f.put(file, validationBlock([...commands, 'pnpm test:unit']))
  assert.equal((await f.validate()).ok, true)
  await f.put('AGENTS.md', validationBlock([...commands, 'node --test --test-concurrency=2 tools/*.test.mjs']))
  assert.match((await f.validate()).errors.join('\n'), /AGENTS.md:1: validation commands differ/)
})

for (const [name, file, from, to, sdk, cli] of [
  ['SDK', 'Cargo.toml', '=1.0.11', '=1.0.12', '1.0.12', '1.0.79'],
  ['CLI', runtimeSource, '1.0.79', '1.0.80', '1.0.11', '1.0.80'],
]) {
  test(`rejects a source ${name} bump until both current compatibility docs are updated`, async (t) => {
    const f = await fixture(t)
    await f.replace(file, from, to)
    const result = await f.validate()
    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 2)
    assert.match(result.errors[0], /Expected: SDK .*CLI .*\n  Actual: SDK/)
    for (const doc of RUNTIME_DOCUMENTS) await f.put(doc, runtimeBlock(sdk, cli))
    assert.equal((await f.validate()).ok, true)
  })
}

for (const [name, transform] of [
  ['missing opening marker', (text) => text.replace('<!-- ecorp:validation-commands -->', '')],
  ['missing closing marker', (text) => text.replace('<!-- /ecorp:validation-commands -->', '')],
  ['duplicate block', (text) => text + text],
  ['reversed markers', (text) => text.replace('<!-- ecorp:', '<!-- TEMP:').replace('<!-- /ecorp:', '<!-- ecorp:').replace('<!-- TEMP:', '<!-- /ecorp:')],
  ['inline marker', (text) => text.replace('<!-- ecorp:', 'example <!-- ecorp:')],
]) {
  test(`rejects ${name} instead of silently dropping a required documentation contract`, async (t) => {
    const f = await fixture(t)
    await f.put('AGENTS.md', transform(validationBlock()))
    assert.match((await f.validate()).errors.join('\n'), /AGENTS.md: require exactly one ordered pair/)
  })
}

test('requires every current runtime contract and a single SDK and CLI claim inside each', async (t) => {
  const f = await fixture(t)
  await f.put('docs/ARCHITECTURE.md', 'Historical compatibility prose only.\n')
  await f.put('docs/SECURITY.md', runtimeBlock().replace('Current Rust SDK', 'SDK \x601.0.11\x60 and SDK'))
  const result = await f.validate()
  assert.equal(result.errors.length, 2)
  assert.match(result.errors[0], /docs\/ARCHITECTURE.md: require exactly one ordered pair/)
  assert.match(result.errors[1], /require exactly one SDK version/)
})

for (const [name, configure, message] of [
  ['missing root alias', (s) => { s.check = 'pnpm absent' }, /unknown root pnpm script "absent"/],
  ['cyclic root aliases', (s) => { s['check:migrations'] = 'pnpm check' }, /cyclic root pnpm script expansion/],
  ['shell pipeline', (s) => { s.check += ' | node other.mjs' }, /unsupported command syntax/],
  ['quoted shell expansion', (s) => { s.check = 'node "$SECRET"' }, /unsupported command syntax/],
  ['empty command', (s) => { s.check += ' &&' }, /unsupported command syntax/],
  ['unsupported alias arguments', (s) => { s.check = 'pnpm build:web --flag' }, /unsupported pnpm form/],
]) {
  test(`rejects ${name} in the authoritative command sequence`, async (t) => {
    const f = await fixture(t)
    configure(f.scripts)
    await f.saveScripts()
    assert.match((await f.validate()).errors.join('\n'), message)
  })
}

test('rejects unknown documented aliases and malformed command fences', async (t) => {
  const f = await fixture(t)
  await f.put('AGENTS.md', validationBlock(['pnpm absent']))
  await f.put('CONTRIBUTING.md', validationBlock().replace('```powershell', '```json'))
  const result = await f.validate()
  assert.match(result.errors[0], /AGENTS.md:1: unknown root pnpm script/)
  assert.match(result.errors[1], /CONTRIBUTING.md:1: validation contract must contain one shell fenced block/)
})

test('reports missing required documents and an invalid source manifest without silently skipping them', async (t) => {
  const f = await fixture(t)
  await rm(path.join(f.root, 'AGENTS.md'))
  await f.put('package.json', '{ invalid json }')
  const result = await f.validate()
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /package.json: invalid JSON/)
  assert.match(result.errors.join('\n'), /AGENTS.md: cannot read required contract input \(ENOENT\)/)
})

for (const [name, file, text, message] of [
  ['unconstrained SDK dependency', 'Cargo.toml', '[workspace.dependencies]\ngithub-copilot-sdk = "1.0.11"', /Cargo.toml: require one literal/],
  ['SDK pin in wrong table', 'Cargo.toml', '[dependencies]\ngithub-copilot-sdk = "=1.0.11"', /Cargo.toml: require one literal/],
  ['duplicate SDK declaration', 'Cargo.toml', '[workspace.dependencies]\ngithub-copilot-sdk = "=1.0.11"\ngithub-copilot-sdk = "=1.0.11"', /Cargo.toml: require one literal/],
  ['missing named runtime constant', runtimeSource, 'const OTHER_RUNTIME: &str = "1.0.79";', /copilot.rs: require one literal const SUPPORTED_COPILOT_RUNTIME/],
  ['duplicate runtime constant', runtimeSource, 'const SUPPORTED_COPILOT_RUNTIME: &str = "1.0.79";\nconst SUPPORTED_COPILOT_RUNTIME: &str = "1.0.79";', /copilot.rs: require one literal const SUPPORTED_COPILOT_RUNTIME/],
]) {
  test(`fails closed for ${name}`, async (t) => {
    const f = await fixture(t)
    await f.put(file, text)
    assert.match((await f.validate()).errors.join('\n'), message)
  })
}

test('relocated CLI resolves its own repository, executes no documented command, and exits nonzero for drift', async (t) => {
  const f = await fixture(t)
  f.scripts.check = 'node create-sentinel.mjs'
  await f.saveScripts()
  await f.put('create-sentinel.mjs', 'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./sentinel", import.meta.url), "executed");')
  for (const file of VALIDATION_DOCUMENTS) await f.put(file, validationBlock(['node create-sentinel.mjs']))
  await mkdir(path.join(f.root, 'tools'))
  const checker = path.join(f.root, 'tools/check_documentation.mjs')
  await copyFile(new URL('./check_documentation.mjs', import.meta.url), checker)
  const result = await execute(process.execPath, [checker], { cwd: os.tmpdir() })
  assert.equal(JSON.parse(result.stdout).ok, true)
  await assert.rejects(access(path.join(f.root, 'sentinel')), { code: 'ENOENT' })
  await f.replace(runtimeSource, '1.0.79', '1.0.80')
  await assert.rejects(execute(process.execPath, [checker], { cwd: os.tmpdir() }), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Documentation contract check failed/)
    assert.match(error.stderr, /Expected: SDK 1.0.11, CLI 1.0.80/)
    return true
  })
})
