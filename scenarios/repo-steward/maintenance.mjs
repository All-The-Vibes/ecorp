import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, requireThat, StewardError } from './lib/common.mjs';
import { collectSnapshot } from './lib/github.mjs';
import { MAX_ATTEMPTS, runAuditCycle, readAuditState, setAuditControl } from './lib/recurring-audit.mjs';
import { collectorBinding, collectorPolicy } from './lib/collector-profile.mjs';

const commands = new Set(['once', 'watch', 'status', 'pause', 'resume', 'stop']);
const sourceFlags = ['snapshot', 'live'];
const valueFlags = new Set(['state-dir', 'source-commit', 'snapshot', 'corpus', 'cycles', 'interval-ms', 'duration-ms', 'reason', 'collector-profile', 'collector-profile-sha256']);
const integerArg = (value, min, max, label) => {
  requireThat(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'ARGUMENT', `${label} must be a positive integer.`);
  const number = Number(value);
  requireThat(Number.isSafeInteger(number) && number >= min && number <= max, 'ARGUMENT', `${label} is outside its supported bound.`);
  return number;
};

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  requireThat(commands.has(command), 'ARGUMENT', 'Choose once, watch, status, pause, resume or stop.');
  const args = { command }, seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    requireThat(/^--[a-z][a-z0-9-]*$/.test(flag) && !seen.has(flag), 'ARGUMENT', 'Unknown or duplicate option.');
    seen.add(flag);
    const key = flag.slice(2);
    if (key === 'live') { args.live = true; continue; }
    requireThat(valueFlags.has(key), 'ARGUMENT', 'Unsupported option.');
    const value = rest[++i];
    requireThat(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.startsWith('--') && !/[\r\n\0]/.test(value), 'ARGUMENT', 'An option value is missing or invalid.');
    args[key] = value;
  }
  requireThat(typeof args['state-dir'] === 'string', 'ARGUMENT', '--state-dir is required.');
  args.stateDirectory = path.resolve(args['state-dir']);
  const executes = command === 'once' || command === 'watch';
  const controls = ['pause', 'resume', 'stop'].includes(command);
  requireThat(Boolean(args['collector-profile']) === Boolean(args['collector-profile-sha256']), 'ARGUMENT', 'Collector profile path and SHA-256 must be supplied together.');
  if (args['collector-profile']) {
    requireThat(/^[a-f0-9]{64}$/.test(args['collector-profile-sha256']), 'ARGUMENT', 'Collector profile SHA-256 must be lowercase hexadecimal.');
    requireThat(!executes || args.live && !args.snapshot, 'ARGUMENT', 'A collector profile cannot relabel supplied snapshots as live.');
    args.collectorProfile = { path: path.resolve(args['collector-profile']), sha256: args['collector-profile-sha256'] };
  }
  if (executes || controls) requireThat(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(args['source-commit'] || ''), 'ARGUMENT', 'An exact lowercase --source-commit is required.');
  if (executes) requireThat(sourceFlags.filter(key => args[key]).length === 1, 'ARGUMENT', 'Select exactly one input: --snapshot PATH or --live.');
  else requireThat(!sourceFlags.some(key => args[key]) && !args.corpus, 'ARGUMENT', 'State and control commands cannot collect snapshots or load feedback.');
  if (controls) requireThat(typeof args.reason === 'string' && args.reason.trim().length > 0 && args.reason.length <= 1000, 'ARGUMENT', 'Control changes require a bounded --reason.');
  else requireThat(args.reason === undefined, 'ARGUMENT', '--reason is only supported for control changes.');
  if (command === 'status') requireThat(args['source-commit'] === undefined, 'ARGUMENT', 'status reads the recorded source binding.');
  if (command === 'watch') {
    args.cycles = integerArg(args.cycles, 1, MAX_ATTEMPTS, '--cycles');
    args.intervalMs = integerArg(args['interval-ms'], args.live ? 60000 : 1000, 3600000, '--interval-ms');
    args.durationMs = integerArg(args['duration-ms'] || '3600000', 1000, 3600000, '--duration-ms');
  } else {
    requireThat(args.cycles === undefined && args['interval-ms'] === undefined && args['duration-ms'] === undefined, 'ARGUMENT', 'Recurrence options require watch.');
    args.cycles = 1;
    args.durationMs = 3600000;
  }
  return args;
}

function summary(result, sourceCommit) {
  const reference = value => value && /^artifact-[a-f0-9]{64}\.json$/.test(value.file || '')
    && /^[a-f0-9]{64}$/.test(value.sha256 || '') && Number.isSafeInteger(value.bytes) && value.bytes > 0
    ? { file: value.file, sha256: value.sha256, bytes: value.bytes } : undefined;
  return {
    status: result.status,
    source_commit: result.sourceCommit || sourceCommit,
    attempts: result.attempts ?? result.checkpoint?.attempts,
    new_findings: Array.isArray(result.newFindings) ? result.newFindings.length : undefined,
    resolved_findings: Array.isArray(result.resolvedFindingIds) ? result.resolvedFindingIds.length : undefined,
    receipt: reference(result.receipt), checkpoint: reference(result.checkpoint), handoff: reference(result.handoff),
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const { collect = collectSnapshot, cycle = runAuditCycle, state = readAuditState, control = setAuditControl,
    load = readJson, now = () => new Date(), sleep = delay, signal } = dependencies;
  const sourceCommit = args['source-commit'];
  const collectorProfile = args.collectorProfile ?? null;
  const policy = collectorPolicy(collectorProfile);
  const base = { mode: 'audit-only', remote_mutations: 0, state_directory: args.stateDirectory,
    ...(collectorProfile ? { collector: collectorBinding(policy) } : {}) };
  if (args.command === 'status') {
    const current = await state({ stateDirectory: args.stateDirectory, collectorProfile });
    return { ...base, ...(current ? summary(current) : { status: 'not-initialized' }) };
  }
  if (['pause', 'resume', 'stop'].includes(args.command)) {
    const result = await control({ stateDirectory: args.stateDirectory, sourceCommit, action: args.command, reason: args.reason, now: now(), collectorProfile });
    return { ...base, ...summary(result, sourceCommit) };
  }
  const started = now().getTime(), results = [];
  let exitReason = 'cycle-limit';
  for (let index = 0; index < args.cycles; index++) {
    if (signal?.aborted) { exitReason = 'interrupted'; break; }
    if (now().getTime() - started >= args.durationMs) { exitReason = 'duration-limit'; break; }
    const current = await state({ stateDirectory: args.stateDirectory, collectorProfile });
    if (current) {
      requireThat(current.sourceCommit === sourceCommit, 'SOURCE_DRIFT', 'State belongs to a different source revision.');
      if (current.status === 'paused' || current.status === 'stopped') { exitReason = current.status; break; }
      requireThat(current.attempts < MAX_ATTEMPTS, 'ATTEMPT_BOUND', 'The audit attempt bound is exhausted; no further input is collected.');
    }
    // Reload inputs for every admitted cycle. A stale input is never made fresh here.
    let snapshot, corpus, inputAcquisitionFailed = false;
    try {
      snapshot = args.live ? await collect({ collectorProfile }) : load(path.resolve(args.snapshot));
      corpus = args.corpus ? load(path.resolve(args.corpus), 1048576) : null;
    } catch { inputAcquisitionFailed = true; }
    if (signal?.aborted) { exitReason = 'interrupted'; break; }
    if (now().getTime() - started >= args.durationMs) { exitReason = 'duration-limit'; break; }
    const result = await cycle({ stateDirectory: args.stateDirectory, snapshot, sourceCommit,
      source: args.live ? 'live-github-two-pass' : 'provided-snapshot', now: now(), corpus, collectorProfile, inputAcquisitionFailed });
    results.push(summary(result, sourceCommit));
    if (result.status === 'paused' || result.status === 'stopped') { exitReason = result.status; break; }
    if (index + 1 < args.cycles) {
      const remaining = args.durationMs - (now().getTime() - started);
      if (remaining <= 0) { exitReason = 'duration-limit'; break; }
      try { await sleep(Math.min(args.intervalMs, remaining), undefined, signal ? { signal } : undefined); }
      catch (error) { if (signal?.aborted && error.name === 'AbortError') { exitReason = 'interrupted'; break; } throw error; }
    }
  }
  return { ...base, source_commit: sourceCommit, completed_cycles: results.length, exit_reason: exitReason, cycles: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const interrupt = new AbortController();
  process.once('SIGINT', () => interrupt.abort());
  process.once('SIGTERM', () => interrupt.abort());
  main(process.argv.slice(2), { signal: interrupt.signal }).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.exit_reason === 'interrupted') process.exitCode = 130;
  }).catch(error => {
    process.stderr.write(JSON.stringify({ error: error instanceof StewardError ? error.code : 'AUDIT_FAILED',
      message: 'Local audit did not complete. Retained state must be inspected before retry; raw inputs and errors are withheld.' }) + '\n');
    process.exitCode = 1;
  });
}
