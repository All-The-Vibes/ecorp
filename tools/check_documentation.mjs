import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// These current contracts are intentionally required. Historical evidence and
// unmarked prose are outside this check; it does not assess semantic doc drift.
export const VALIDATION_DOCUMENTS = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'docs/EVALS.md',
  'docs/USER_AND_DEVELOPER_JOURNEY.md',
  'docs/DARK_FACTORY_CONTRIBUTOR_GUIDE.md',
]
export const RUNTIME_DOCUMENTS = ['docs/ARCHITECTURE.md', 'docs/SECURITY.md']
const runtimeSource = 'crates/crony-runner/src/adapter/copilot.rs'
const defaultRoot = fileURLToPath(new URL('../', import.meta.url))
const scope = 'Marked repository validation commands and current Copilot SDK/CLI versions only'
const word = '[A-Za-z0-9_./:@=+*-]+'
const literal = `(?:${word}|"${word}"|'${word}')`
const literalCommand = new RegExp(`^${literal}(?: ${literal})*$`)

async function read(root, file) {
  try {
    return (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n')
  } catch (error) {
    throw new Error(`${file}: cannot read required contract input (${error.code})`)
  }
}

function markedSection(text, file, name) {
  const start = `<!-- ecorp:${name} -->`
  const end = `<!-- /ecorp:${name} -->`
  const lines = text.split('\n')
  const first = lines.findIndex((line) => line.trim() === start)
  const last = lines.findIndex((line) => line.trim() === end)
  if (
    text.split(start).length !== 2 || text.split(end).length !== 2 ||
    first < 0 || last <= first
  ) {
    throw new Error(`${file}: require exactly one ordered pair of ${start} and ${end}, each on its own line`)
  }
  return { text: lines.slice(first + 1, last).join('\n').trim(), location: `${file}:${first + 1}` }
}

function documentedCommands(section) {
  const match = /^```(?:powershell|pwsh|sh|bash)\n([^`]+)\n```$/.exec(section.text)
  if (!match) {
    throw new Error(`${section.location}: validation contract must contain one shell fenced block of literal commands`)
  }
  const commands = match[1].split('\n').map((line) => line.trim()).filter(Boolean)
  if (commands.length === 0) throw new Error(`${section.location}: validation command block is empty`)
  return commands
}

// Deliberately not a shell parser: literal words (optionally quoted) and &&
// sequences only, with no interpolation or escaping. Preserve quotes so a
// shell-expanded glob cannot silently replace a quoted Node test-runner glob.
// No Markdown or package command is ever executed.
function expandCommands(commands, scripts, source) {
  let remaining = 1024
  function expand(value, trail) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${source}: ${trail.at(-1) ?? 'command'} must be a nonempty command string`)
    }
    return value.split('&&').flatMap((part) => {
      if (--remaining < 0) throw new Error(`${source}: root pnpm expansion exceeds 1024 commands`)
      const command = part.trim().replace(/[ \t]+/g, ' ')
      if (!literalCommand.test(command)) {
        throw new Error(`${source}: unsupported command syntax ${JSON.stringify(part.trim())}; use literal commands and && only`)
      }
      const alias = /^pnpm (?:run )?([A-Za-z0-9_:.-]+)$/.exec(command)
      if (alias) {
        const name = alias[1]
        if (!Object.hasOwn(scripts, name)) {
          throw new Error(`${source}: unknown root pnpm script ${JSON.stringify(name)} in package.json`)
        }
        if (trail.includes(name)) {
          throw new Error(`${source}: cyclic root pnpm script expansion: ${[...trail, name].join(' -> ')}`)
        }
        return expand(scripts[name], [...trail, name])
      }
      if (command.startsWith('pnpm ') && !/^pnpm --dir [A-Za-z0-9_./-]+ (?:run )?[A-Za-z0-9_:.-]+$/.test(command)) {
        throw new Error(`${source}: unsupported pnpm form ${JSON.stringify(command)}; use a root script alias or literal --dir command`)
      }
      return [command]
    })
  }
  return commands.flatMap((command) => expand(command, []))
}

function sourceVersions(cargo, runtime) {
  let table = ''
  const dependencies = []
  for (const line of cargo.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (header) table = header[1]
    if (table === 'workspace.dependencies' && /^\s*github-copilot-sdk\s*=/.test(line)) {
      dependencies.push(line)
    }
  }
  const sdk = dependencies.length === 1 && /^\s*github-copilot-sdk\s*=\s*"=(\d+\.\d+\.\d+)"\s*(?:#.*)?$/.exec(dependencies[0])
  if (!sdk) {
    throw new Error('Cargo.toml: require one literal github-copilot-sdk = "=x.y.z" pin in [workspace.dependencies]; update the bounded parser if the declaration format changes')
  }
  const declarations = runtime.split('\n').filter((line) => /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+SUPPORTED_COPILOT_RUNTIME\b/.test(line))
  const cli = declarations.length === 1 && /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+SUPPORTED_COPILOT_RUNTIME\s*:\s*&str\s*=\s*"(\d+\.\d+\.\d+)"\s*;\s*(?:\/\/.*)?$/.exec(declarations[0])
  if (!cli) {
    throw new Error(`${runtimeSource}: require one literal const SUPPORTED_COPILOT_RUNTIME: &str = "x.y.z"; update the bounded parser if the declaration format changes`)
  }
  return { sdk: sdk[1], cli: cli[1] }
}

function checkRuntime(section, expected) {
  const values = {}
  for (const [key, label] of [['sdk', 'SDK'], ['cli', 'CLI']]) {
    const matches = [...section.text.matchAll(new RegExp(`\\b${label}\\s+\x60([^\x60]+)\x60`, 'g'))]
    if (matches.length !== 1) {
      throw new Error(`${section.location}: require exactly one ${label} version in backticks in the current runtime contract`)
    }
    values[key] = matches[0][1]
  }
  if (values.sdk !== expected.sdk || values.cli !== expected.cli) {
    throw new Error(`${section.location}: current Copilot versions differ from Cargo.toml and ${runtimeSource}\n  Expected: SDK ${expected.sdk}, CLI ${expected.cli}\n  Actual: SDK ${values.sdk}, CLI ${values.cli}\n  Update this current contract after verifying the new supported pair.`)
  }
}

export async function validateDocumentation(root = defaultRoot) {
  const errors = []
  let expectedCommands
  let scripts
  let copilotVersions
  const attempt = async (operation) => {
    try { return await operation() } catch (error) { errors.push(error.message) }
  }
  await attempt(async () => {
    const text = await read(root, 'package.json')
    let manifest
    try { manifest = JSON.parse(text) } catch {
      throw new Error('package.json: invalid JSON; repair the manifest before checking documented commands')
    }
    scripts = manifest?.scripts
    if (!scripts || typeof scripts !== 'object' || !Object.hasOwn(scripts, 'check')) {
      throw new Error('package.json: require a scripts.check validation sequence')
    }
    expectedCommands = expandCommands([scripts.check], scripts, 'package.json scripts.check')
  })
  await attempt(async () => {
    const [cargo, runtime] = await Promise.all([read(root, 'Cargo.toml'), read(root, runtimeSource)])
    copilotVersions = sourceVersions(cargo, runtime)
  })
  let validationDocuments = 0
  let runtimeDocuments = 0
  for (const file of VALIDATION_DOCUMENTS) {
    await attempt(async () => {
      const section = markedSection(await read(root, file), file, 'validation-commands')
      const documented = documentedCommands(section)
      if (!expectedCommands) return
      const actual = expandCommands(documented, scripts, section.location)
      if (JSON.stringify(actual) !== JSON.stringify(expectedCommands)) {
        throw new Error(`${section.location}: validation commands differ from package.json scripts.check\n  Expected:\n    ${expectedCommands.join('\n    ')}\n  Actual:\n    ${actual.join('\n    ')}\n  Update the marked command sequence or correct scripts.check.`)
      }
      validationDocuments += 1
    })
  }
  for (const file of RUNTIME_DOCUMENTS) {
    await attempt(async () => {
      const section = markedSection(await read(root, file), file, 'copilot-runtime')
      if (!copilotVersions) return
      checkRuntime(section, copilotVersions)
      runtimeDocuments += 1
    })
  }
  return {
    ok: errors.length === 0,
    scope,
    validationDocuments,
    runtimeDocuments,
    validationCommands: expectedCommands?.length ?? 0,
    copilotVersions,
    errors,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await validateDocumentation()
  if (result.ok) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.error(`Documentation contract check failed:\n${result.errors.join('\n\n')}`)
    process.exitCode = 1
  }
}
