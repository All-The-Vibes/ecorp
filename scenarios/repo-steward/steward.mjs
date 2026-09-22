import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPolicy, markdown, readJson, requireThat, ROOT, safeText, StewardError } from './lib/common.mjs';
import { collectSnapshot } from './lib/github.mjs';
import { audit, createSteward, renderReport } from './lib/steward.mjs';
import { fixtureSnapshot } from './fixtures/demo.mjs';

export function parseArgs(argv) {
  const args = { command: 'audit', dryRun: argv.length === 0, format: 'json' };
  const seen = new Set();
  let offset = 0;
  if (argv[0] && !argv[0].startsWith('--')) { args.command = argv[0]; offset = 1; }
  requireThat(['audit', 'ask', 'collect'].includes(args.command), 'ARGUMENT', 'Supported commands: audit, ask, collect. There is no apply command.');
  for (let i = offset; i < argv.length; i++) {
    const flag = argv[i];
    requireThat(!seen.has(flag), 'ARGUMENT', 'Duplicate arguments are not accepted.'); seen.add(flag);
    if (['--dry-run', '--live', '--fixture'].includes(flag)) { args[{ '--dry-run': 'dryRun', '--live': 'live', '--fixture': 'fixture' }[flag]] = true; continue; }
    requireThat(['--snapshot', '--question', '--format', '--out'].includes(flag), 'ARGUMENT', 'Unknown option; no write, account-switch, or deployment options are supported.');
    const value = argv[++i];
    requireThat(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'ARGUMENT', 'An option value is missing.');
    args[flag.slice(2)] = value;
  }
  requireThat(['json', 'markdown'].includes(args.format), 'ARGUMENT', 'Format must be json or markdown.');
  const sources = [args.live, args.fixture, args.snapshot].filter(Boolean).length;
  requireThat(sources <= 1 && (args.dryRun || sources === 1), 'ARGUMENT', 'Choose exactly one source: --fixture, --snapshot PATH, or --live.');
  requireThat(!(args.dryRun && args.out), 'ARGUMENT', 'A dry run cannot write an output file.');
  requireThat(!args.out || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.(json|md)$/.test(args.out), 'OUTPUT', '--out accepts a new filename only, inside this package output directory.');
  requireThat(!args.question || args.command === 'ask', 'ARGUMENT', '--question is only valid with ask.');
  requireThat(args.command !== 'ask' || typeof args.question === 'string' && args.question.length <= 2000, 'ARGUMENT', 'ask requires --question with at most 2000 characters.');
  requireThat(args.command !== 'collect' || args.live && args.format === 'json', 'ARGUMENT', 'collect requires --live and JSON output.');
  return args;
}

function writeOutput(filename, text) {
  const root = fileURLToPath(ROOT), output = path.join(root, 'output');
  mkdirSync(output, { recursive: false });
  return writeOutputExisting(root, output, filename, text);
}
function writeOutputExisting(root, output, filename, text) {
  requireThat(!lstatSync(output).isSymbolicLink() && realpathSync(output) === path.join(realpathSync(root), 'output'), 'OUTPUT', 'Output directory must not be redirected.');
  const destination = path.join(output, filename);
  writeFileSync(destination, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return destination;
}
function saveNewOutput(filename, text) {
  try { return writeOutput(filename, text); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return writeOutputExisting(fileURLToPath(ROOT), fileURLToPath(new URL('output/', ROOT)), filename, text);
  }
}

export async function main(argv = process.argv.slice(2), { collect = collectSnapshot } = {}) {
  const args = parseArgs(argv), policy = loadPolicy();
  if (args.dryRun) return { output: JSON.stringify({ agent: policy.name, mode: 'audit-only', dry_run: true, repository: policy.repository, project: `${policy.project_owner}/${policy.project_number}`, planned_command: args.command,
    input: args.live ? 'two bounded GitHub reads, personally authenticated as Bakar404' : args.fixture ? 'synthetic fixture' : args.snapshot ? 'provided snapshot' : 'none selected',
    live_reads_performed: 0, files_written: 0, github_mutations: 0, assignee_changes: 0, teams_access: false, agent_process_started: false }, null, 2) };
  const snapshot = args.live ? await collect() : args.fixture ? fixtureSnapshot() : readJson(path.resolve(args.snapshot));
  const source = args.live ? 'live-github-two-pass' : args.fixture ? 'synthetic-fixture' : 'provided-snapshot';
  let result, output;
  if (args.command === 'collect') { result = snapshot; output = JSON.stringify(result, null, 2); }
  else if (args.command === 'ask') {
    result = createSteward(snapshot, { source }).ask(args.question);
    output = args.format === 'markdown' ? `${markdown(result.text)}\n\n${result.references.map(r => `[${r.kind} #${r.number}](${r.url})`).join('\n')}\n` : JSON.stringify(result, null, 2);
  } else { result = audit(snapshot, { source }); output = args.format === 'markdown' ? renderReport(result) : JSON.stringify(result, null, 2); }
  if (args.out) return { output: JSON.stringify({ output_file: saveNewOutput(args.out, output + '\n'), mode: 'audit-only', github_mutations: 0 }) };
  return { output, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(result.output + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ error: error instanceof StewardError ? error.code : 'OPERATION_FAILED', message: error instanceof StewardError ? safeText(error.message) : 'Operation failed; raw response, credentials, and stack are withheld. No GitHub mutation was attempted.' }) + '\n');
    process.exitCode = 1;
  });
}
