import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, requireThat, StewardError, validateSnapshot } from './lib/common.mjs';
import { createFeedbackCorpus, createFeedbackEvidence, proposeFeedback, reviewFeedback, retireFeedback,
  feedbackDigest, FEEDBACK_LIMITS } from './lib/feedback.mjs';

const fields = {
  init: ['snapshot', 'out', 'max-active'], evidence: ['snapshot', 'finding', 'out'],
  propose: ['corpus', 'input', 'out'], review: ['corpus', 'input', 'review-file', 'out'],
  retire: ['corpus', 'input', 'out'],
};

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  requireThat(Object.hasOwn(fields, command), 'ARGUMENT', 'Choose init, evidence, propose, review or retire.');
  const args = { command }, seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    requireThat(/^--[a-z-]+$/.test(flag) && !seen.has(flag) && fields[command].includes(flag.slice(2)), 'ARGUMENT', 'Unknown or duplicate option.');
    seen.add(flag);
    const value = rest[++i];
    requireThat(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.startsWith('--') && !/[\r\n\0]/.test(value), 'ARGUMENT', 'An option value is missing or invalid.');
    args[flag.slice(2)] = value;
  }
  for (const key of fields[command].filter(key => key !== 'max-active')) requireThat(args[key], 'ARGUMENT', `--${key} is required.`);
  if (args['max-active'] !== undefined) requireThat(/^[1-9][0-9]?$/.test(args['max-active']) && Number(args['max-active']) <= FEEDBACK_LIMITS.maxActive, 'ARGUMENT', `--max-active must be between 1 and ${FEEDBACK_LIMITS.maxActive}.`);
  return args;
}

export function saveNew(filename, value) {
  const absolute = path.resolve(filename), parent = path.dirname(absolute);
  // No recursive directory creation or redirected parent is implicit in a corpus update.
  let current = parent;
  for (;;) {
    const stat = lstatSync(current);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'OUTPUT', 'Output parent must be an existing unredirected directory.');
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  requireThat(normalize(realpathSync(parent)) === normalize(parent), 'OUTPUT', 'Output parent must resolve to its declared location.');
  const text = JSON.stringify(value, null, 2) + '\n';
  requireThat(Buffer.byteLength(text) <= 1048576, 'OUTPUT_BOUND', 'Feedback output exceeds one MiB.');
  writeFileSync(absolute, text, { flag: 'wx', mode: 0o600, encoding: 'utf8' });
  return absolute;
}

function readReview(filename) {
  const stat = lstatSync(filename);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 65536, 'REVIEW_BOUND', 'Review evidence must be a bounded nonempty regular file.');
  const bytes = readFileSync(filename);
  requireThat(bytes.length === stat.size, 'REVIEW_CHANGED', 'Review evidence changed while being read.');
  return createHash('sha256').update(bytes).digest('hex');
}

export function main(argv = process.argv.slice(2), { now = new Date() } = {}) {
  const args = parseArgs(argv);
  let output, record, recordDigest, transition = args.command;
  if (args.command === 'init') {
    const snapshot = validateSnapshot(readJson(path.resolve(args.snapshot)));
    output = createFeedbackCorpus({ scope: snapshot.scope, maxActive: Number(args['max-active'] || 8), now });
  } else if (args.command === 'evidence') {
    output = createFeedbackEvidence({ snapshot: readJson(path.resolve(args.snapshot)), findingId: args.finding, now, source: 'provided-snapshot' });
  } else {
    const corpus = readJson(path.resolve(args.corpus), 1048576);
    const input = readJson(path.resolve(args.input), 1048576);
    requireThat(input && typeof input === 'object' && !Array.isArray(input), 'ARGUMENT', 'Transition input must be an object.');
    let result;
    if (args.command === 'propose') result = proposeFeedback({ ...input, corpus, now });
    if (args.command === 'review') {
      const sha256 = readReview(path.resolve(args['review-file']));
      result = reviewFeedback({ ...input, corpus, now, reviewEvidence: { ...input.reviewEvidence, sha256 } });
    }
    if (args.command === 'retire') result = retireFeedback({ ...input, corpus, now });
    output = result.corpus;
    record = result.record;
    recordDigest = result.recordDigest;
    transition = result.transition;
  }
  const destination = saveNew(args.out, output);
  return { mode: 'advisory-only', output_file: destination, output_digest: feedbackDigest(output), transition,
    record_id: record?.id, record_digest: recordDigest, record_status: record?.status, evidence_id: output.evidence_id,
    authenticated_reviewer_identity: false, remote_mutations: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(), null, 2) + '\n'); }
  catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof StewardError ? error.code : 'FEEDBACK_FAILED',
      message: 'Feedback transition failed. Original corpus files remain unchanged; raw inputs and errors are withheld.' }) + '\n');
    process.exitCode = 1;
  }
}
