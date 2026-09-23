import { accessSync, constants, mkdtempSync, readFileSync, rmdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const exactVersion = /^\d+\.\d+\.\d+$/
const scope = 'Recommended host tool versions only; no dependency installation, build, or runtime acceptance'
const environmentNames = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'comspec', 'home', 'userprofile',
  'temp', 'tmp', 'rustup_home', 'cargo_home', 'pnpm_home', 'localappdata',
  'appdata', 'xdg_config_home', 'xdg_cache_home', 'lang', 'lc_all',
])

function declaredPins(directory) {
  const node = readFileSync(path.join(directory, '.node-version'), 'utf8').trim()
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const pnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '')?.[1]
  const toolchain = readFileSync(path.join(directory, 'rust-toolchain.toml'), 'utf8')
  const sections = [...toolchain.matchAll(/^\[toolchain\]\s*$/gm)]
  if (sections.length !== 1) throw new Error('invalid_pins')
  const section = toolchain.slice(sections[0].index + sections[0][0].length).split(/^\[/m)[0]
  const channels = [...section.matchAll(/^channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/gm)]
  const components = [...section.matchAll(/^components\s*=\s*(\[[^\n]+\])\s*$/gm)]
  if (!exactVersion.test(node) || !pnpm || channels.length !== 1 || components.length !== 1) {
    throw new Error('invalid_pins')
  }
  const required = JSON.parse(components[0][1])
  if (!Array.isArray(required) || required.length !== 2 ||
      !required.includes('rustfmt') || !required.includes('clippy')) throw new Error('invalid_pins')
  return { node, pnpm, rust: channels[0][1], components: required }
}

function childEnvironment(source) {
  const environment = Object.fromEntries(Object.entries(source)
    .filter(([name]) => environmentNames.has(name.toLowerCase())))
  // Corepack must report a missing cached package manager instead of downloading it.
  environment.COREPACK_ENABLE_NETWORK = '0'
  environment.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  return environment
}

function environmentValue(environment, name) {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

function commandPath(name, environment) {
  const directories = (environmentValue(environment, 'PATH') ?? '').split(path.delimiter)
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : ['']
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension)
      try {
        if (!statSync(candidate).isFile()) continue
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
        return candidate
      } catch { /* Continue through the configured executable search path. */ }
    }
  }
  return null
}

function commandVersion(program, args, expression, environment, directory) {
  if (!program) return { actual: null, error: 'command_missing' }
  let executable = program
  let argumentsList = args
  let windowsVerbatimArguments = false
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(program)) {
    // Only fixed version-query arguments enter this native batch-file adapter.
    if (/[&|<>^%!\r\n"]/.test(program) || args.some((arg) => !/^[\w.=-]+$/.test(arg))) {
      return { actual: null, error: 'unsupported_command_path' }
    }
    const windowsRoot = environmentValue(environment, 'SystemRoot')
    if (!windowsRoot || !path.isAbsolute(windowsRoot)) return { actual: null, error: 'command_missing' }
    executable = path.join(windowsRoot, 'System32', 'cmd.exe')
    argumentsList = ['/d', '/s', '/c', `""${program}" ${args.join(' ')}"`]
    windowsVerbatimArguments = true
  }
  const result = spawnSync(executable, argumentsList, {
    cwd: directory, env: environment, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments,
    timeout: 5000, maxBuffer: 16 * 1024,
  })
  if (result.error) return { actual: null, error: result.error.code === 'ETIMEDOUT' ? 'command_timeout' : 'command_failed' }
  if (result.status !== 0) return { actual: null, error: 'command_failed' }
  const actual = expression.exec(result.stdout.trim())?.[1]
  return actual ? { actual } : { actual: null, error: 'version_unrecognized' }
}

function pnpmVersion(environment) {
  let directory
  try { directory = mkdtempSync(path.join(tmpdir(), 'ecorp-toolchain-version-')) } catch {
    return { actual: null, error: 'probe_directory_unavailable' }
  }
  // pnpm 11 processes project configuration before even --version. Query the
  // installed CLI outside the repository, disable project hooks, and reject
  // automatic package-manager switching. The result is compared to our pin below.
  const result = commandVersion(commandPath('pnpm', environment),
    ['--ignore-pnpmfile', '--pm-on-fail=error', '--version'], /^(\d+\.\d+\.\d+)$/, environment, directory)
  try { rmdirSync(directory) } catch {
    // A version query should leave the directory empty; preserve unexpected files.
    return { actual: null, error: 'unexpected_probe_files' }
  }
  return result
}

export function verifyToolchain(directory = root) {
  let pins
  try { pins = declaredPins(directory) } catch {
    return { ok: false, scope, error: 'Cannot read exact Node, pnpm, and Rust pins from .node-version, package.json, and rust-toolchain.toml' }
  }
  const environment = childEnvironment(process.env)
  const checks = [{ tool: 'node', expected: pins.node, actual: process.versions.node }]
  const pnpm = pnpmVersion(environment)
  checks.push({ tool: 'pnpm', expected: pins.pnpm, ...pnpm })
  const rustup = commandPath('rustup', environment)
  const rustCommands = [
    ['rustc', pins.rust, /^rustc (\d+\.\d+\.\d+)\b/],
    ['cargo', pins.rust, /^cargo (\d+\.\d+\.\d+)\b/],
    ['rustfmt', 'installed component', /^rustfmt (\d+\.\d+\.\d+(?:-[\w.]+)?)\b/],
    ['cargo-clippy', 'installed component', /^clippy (\d+\.\d+\.\d+)\b/],
  ]
  for (const [tool, expected, expression] of rustCommands) {
    // `rustup run` requires an already installed named toolchain unless --install
    // is explicitly supplied. Never invoke a rustup shim that can auto-install.
    const program = rustup ?? commandPath(tool, environment)
    const args = rustup ? ['run', pins.rust, tool, '--version'] : ['--version']
    checks.push({ tool, expected, ...commandVersion(program, args, expression, environment, directory) })
  }
  for (const check of checks) check.ok = !check.error &&
    (check.expected === 'installed component' ? Boolean(check.actual) : check.actual === check.expected)
  return {
    ok: checks.every((check) => check.ok), scope, pins,
    rustSelection: rustup ? 'pinned installed rustup toolchain' : 'direct commands on PATH',
    checks,
    ...(checks.every((check) => check.ok) ? {} : {
      action: 'Install or select the declared tools separately, then rerun this doctor. Node 22.23.2 regression compatibility is separate from the recommended whole-repository toolchain.',
    }),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.length === 2 ? verifyToolchain() : {
    ok: false, scope, error: 'Usage: node tools/verify_toolchain.mjs',
  }
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.ok ? 0 : 1
}
