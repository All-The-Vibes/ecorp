import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { loadPolicy, requireThat, SCOPE } from './common.mjs';

// A local profile selects an expected read principal. It grants no permission,
// changes no credentials, and cannot broaden the fixed GitHub query scope.
const fields = ['schema_version', 'kind', 'collector_login', 'repository', 'repository_id', 'project_owner', 'project_number', 'project_id'];
const scopeFields = ['repository', 'repository_id', 'project_owner', 'project_number', 'project_id'];
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;

export function readCollectorProfile(reference) {
  requireThat(reference && typeof reference === 'object' && !Array.isArray(reference)
    && Object.keys(reference).length === 2 && typeof reference.path === 'string' && path.isAbsolute(reference.path)
    && /^[a-f0-9]{64}$/.test(reference.sha256 || ''), 'COLLECTOR_PROFILE', 'An explicit absolute collector profile and SHA-256 are required.');
  const absolute = path.resolve(reference.path);
  for (let current = absolute;;) {
    const stat = lstatSync(current);
    requireThat(!stat.isSymbolicLink(), 'COLLECTOR_PROFILE_PATH', 'Collector profile paths must not be redirected.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  requireThat(normalized(realpathSync(absolute)) === normalized(absolute), 'COLLECTOR_PROFILE_PATH', 'Collector profile must resolve to its explicit path.');
  const stat = lstatSync(absolute);
  requireThat(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 8192, 'COLLECTOR_PROFILE_BOUND', 'Collector profile must be a bounded ordinary file.');
  const bytes = readFileSync(absolute);
  requireThat(bytes.length === stat.size && createHash('sha256').update(bytes).digest('hex') === reference.sha256,
    'COLLECTOR_PROFILE_CHANGED', 'Collector profile bytes differ from the selected hash.');
  let profile, text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); profile = JSON.parse(text); }
  catch { requireThat(false, 'COLLECTOR_PROFILE', 'Collector profile must be valid UTF-8 JSON.'); }
  requireThat(profile && typeof profile === 'object' && !Array.isArray(profile)
    && Object.keys(profile).length === fields.length && fields.every(key => Object.hasOwn(profile, key))
    && profile.schema_version === 1 && profile.kind === 'repo-steward-readonly-collector-profile',
    'COLLECTOR_PROFILE', 'Unsupported collector profile; credentials, URLs and query options are not accepted.');
  requireThat(typeof profile.collector_login === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(profile.collector_login),
    'COLLECTOR_PROFILE', 'Collector profile requires one bounded GitHub login.');
  for (const key of scopeFields) requireThat(profile[key] === SCOPE[key], 'COLLECTOR_PROFILE_SCOPE', 'Collector profile cannot change the approved repository or Project.');
  // All accepted values are fixed strings, a login or integers: this flat
  // schema has no nested keys or quoted-key syntax inside a valid value.
  const parsedKeys = [...text.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map(match => JSON.parse(`"${match[1]}"`));
  requireThat(parsedKeys.length === fields.length && new Set(parsedKeys).size === fields.length, 'COLLECTOR_PROFILE', 'Duplicate collector profile keys are not accepted.');
  return Object.freeze({ ...profile, sha256: reference.sha256 });
}

export function collectorPolicy(reference = null, base = loadPolicy()) {
  if (reference === null) {
    const { collector_profile_sha256: _ignored, ...policy } = base;
    return { ...policy, collector_login: SCOPE.collector_login };
  }
  const profile = readCollectorProfile(reference);
  return { ...base, collector_login: profile.collector_login, collector_profile_sha256: profile.sha256 };
}

export function collectorBinding(policy) {
  return { collector_login: policy.collector_login, profile_sha256: policy.collector_profile_sha256 ?? null };
}
