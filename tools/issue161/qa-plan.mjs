// Setup preview only. Reuse the owned QA supervisor from #237 for execution;
// this file never creates, starts, stops, resets or enrolls any resource.
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function createQaPlan(options, { exists = existsSync, realpath = realpathSync,
  platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const normalize = value => platform === 'win32' ? value.toLowerCase() : value
  assert.equal(options.dryRun, true, 'Only --dry-run is supported; execution needs separate approval')
  for (const key of ['qaRoot', 'pgBin', 'worktree', 'sourceCheckout']) {
    assert.ok(typeof options[key] === 'string' && paths.isAbsolute(options[key]), `${key} must be absolute`)
    assert.equal(normalize(paths.resolve(options[key])), normalize(options[key]), `${key} must be canonical`)
  }
  const { qaRoot, pgBin, worktree, sourceCheckout } = options
  assert.match(paths.basename(qaRoot), /^issue-161-[a-z0-9-]+$/u, 'Use a unique issue-161 QA root')
  assert.equal(paths.basename(paths.dirname(qaRoot)).toLowerCase(), 'qa', 'QA root must be below an explicit qa directory')
  for (const protectedRoot of [worktree, sourceCheckout]) {
    const relative = paths.relative(normalize(protectedRoot), normalize(qaRoot))
    assert.ok(relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative),
      'QA resources must remain outside implementation and retained source checkouts')
  }
  assert.equal(exists(qaRoot), false, 'Occupied QA root must be retained, not adopted or reset')
  // A non-existing leaf can still be redirected by a junction/symlink ancestor.
  for (const candidate of [paths.dirname(qaRoot), pgBin, worktree, sourceCheckout]) {
    assert.ok(exists(candidate), 'Required parent or executable directory is unavailable')
    assert.equal(normalize(realpath(candidate)), normalize(candidate), 'Redirected paths are not accepted')
  }
  for (const name of ['initdb', 'postgres', 'pg_ctl', 'psql']) {
    assert.ok(exists(paths.join(pgBin, name + (platform === 'win32' ? '.exe' : ''))), `${name} is unavailable`)
  }
  return {
    schema_version: 1,
    mode: 'dry_run',
    mutations: [],
    worktree,
    retained_source_checkout: sourceCheckout,
    qa_root: qaRoot,
    postgres_bin: pgBin,
    proposed_resources: {
      postgres_data: paths.join(qaRoot, 'pg-data'),
      postgres_port: 55461,
      databases: ['issue161_shared', 'issue161_independent', 'issue161_sqlx_maintenance'],
      shared_api: 'http://127.0.0.1:18971',
      independent_api: 'http://127.0.0.1:18972',
      web: 'http://127.0.0.1:15471',
      synthetic_source: paths.join(qaRoot, 'source'),
      runner_roots: [paths.join(qaRoot, 'runner-a'), paths.join(qaRoot, 'runner-b')],
      controller_count: 2,
      providers: 'deterministic fixtures only; no personal provider or GitHub credentials',
    },
    checks_after_approval: [
      'Recheck ports and canonical paths immediately before provisioning',
      'Apply actual migrations only to the new owned QA databases',
      'Run issue161 SQLx store and real-handler tests',
      'Race two native controllers with two native runners against one shared ledger',
      'Prove exact item/mission reuse after reconnect and source drift rejection',
      'Reject the shared pin on an independent ledger with the same Corp ID',
      'Exercise and capture the real browser authority display',
      'Stop only receipt-owned QA processes; retain data, worktrees and evidence',
    ],
    boundaries: {
      ports_are_reserved: false,
      services_started: false,
      controller_dispatched: false,
      retained_data_or_credentials_changed: false,
      github_effects_authorized: false,
      multi_host_acceptance: 'not covered by two local runner processes',
      supervisor: 'reuse coordinated PR #237 owned QA helpers; no competing lifecycle implementation',
    },
  }
}

export function parseOptions(args) {
  const options = { dryRun: false }
  const names = new Map([['--qa-root', 'qaRoot'], ['--pg-bin', 'pgBin'],
    ['--worktree', 'worktree'], ['--source-checkout', 'sourceCheckout']])
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run' && !options.dryRun) { options.dryRun = true; continue }
    const key = names.get(args[i])
    assert.ok(key && options[key] === undefined, 'Unknown or repeated option')
    const value = args[++i]
    assert.ok(value && !value.startsWith('--'), 'Option requires a value')
    options[key] = value
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = createQaPlan(parseOptions(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
}
