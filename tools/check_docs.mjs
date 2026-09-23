import { readFileSync, lstatSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const START = '<!-- BEGIN GENERATED VALIDATION CONTRACT -->'
export const END = '<!-- END GENERATED VALIDATION CONTRACT -->'

export function renderContract(pkg, nodeVersion, rustVersion, config) {
  if (!pkg.scripts?.test || !pkg.scripts?.['test:js'] || !pkg.scripts?.check) throw new Error('Required validation scripts missing')
  if (!/^\d+\.\d+\.\d+$/u.test(nodeVersion) || !/^\d+\.\d+\.\d+$/u.test(rustVersion)) throw new Error('Toolchains must be exact versions')
  const rows = Object.entries(pkg.scripts).filter(([name]) => /^(test|check)/u.test(name))
    .map(([name, command]) => `| \`pnpm ${name}\` | \`${command.replaceAll('|', '\\|')}\` |`)
  return `${START}\nNode: **${nodeVersion}**. Rust: **${rustVersion}**. Package manager: **${pkg.packageManager}**.\n\n` +
    `| Entry point | Implementation |\n| --- | --- |\n${rows.join('\n')}\n\n` +
    `Node test roots: ${config.nodeTestRoots.map(value => `\`${value}\``).join(', ')}.\n` +
    (config.nodeTestExcludes?.length ? `Node test exclusions (dedicated fixture/replay lanes): ${config.nodeTestExcludes.map(value => `\`${value}\``).join(', ')}.\n` : '') +
    `Rust suite: \`${config.rustCommand.join(' ')}\`.\n\n${config.ignoredTests}\n${END}`
}

export function replaceContract(document, generated) {
  if (document.split(START).length !== 2 || document.split(END).length !== 2 || document.indexOf(START) > document.indexOf(END)) {
    throw new Error('Exactly one ordered generated block is required; refusing to overwrite prose')
  }
  const eol = document.includes('\r\n') ? '\r\n' : '\n'
  const nativeGenerated = generated.replaceAll(/\r?\n/gu, eol)
  return document.slice(0, document.indexOf(START)) + nativeGenerated + document.slice(document.indexOf(END) + END.length)
}

export function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some(arg => !['--dry-run', '--write'].includes(arg))) throw new Error('Usage: node tools/check_docs.mjs [--dry-run|--write]')
  const target = path.join(root, 'docs', 'VALIDATION.md')
  if (lstatSync(path.join(root, 'docs')).isSymbolicLink() || lstatSync(target).isSymbolicLink()) throw new Error('Documentation target cannot be redirected')
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const config = JSON.parse(readFileSync(path.join(root, 'test.config.json'), 'utf8'))
  const nodeVersion = readFileSync(path.join(root, '.node-version'), 'utf8').trim()
  const rustVersion = readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8').match(/channel\s*=\s*"([^"]+)"/u)?.[1]
  const generated = renderContract(pkg, nodeVersion, rustVersion, config)
  const before = readFileSync(target, 'utf8')
  const expected = replaceContract(before, generated)
  if (args.includes('--dry-run')) { console.log(JSON.stringify({ dry_run: true, changed: before !== expected, target: 'docs/VALIDATION.md', generated }, null, 2)); return 0 }
  if (before === expected) return 0
  if (!args.includes('--write')) { console.error('Documentation contract drift: run pnpm check:docs:preview, review, then pnpm check:docs:write'); return 1 }
  // Only this derived block changes. Never rewrite authored or historical evidence.
  if (readFileSync(target, 'utf8') !== before) throw new Error('Documentation changed during preparation')
  writeFileSync(target, expected)
  if (readFileSync(target, 'utf8') !== expected) throw new Error('Documentation write could not be verified')
  console.log('Updated only the generated validation contract; rerun pnpm check:docs')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
