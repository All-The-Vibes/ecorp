"""Package observed queue validation and native acceptance without changing source."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--validation', required=True, type=Path)
parser.add_argument('--native-selection', required=True, type=Path)
parser.add_argument('--source-equivalence', required=True, type=Path)
parser.add_argument('--prior-validation', action='append', default=[], type=Path)
parser.add_argument('--correction-artifact', action='append', default=[], type=Path)
args = parser.parse_args()
private = Path(__file__).parent.resolve()
repo = Path(r'<reviewed-worktree>')
packet = 'docs/evidence/pr-queue-completion-20260923'
out = repo / packet
node = Path(r'<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe')
read = lambda path: json.loads(path.read_text(encoding='utf-8-sig'))
sha = lambda raw: hashlib.sha256(raw).hexdigest()
git = lambda *argv: subprocess.check_output(['git', '-C', str(repo), *argv], text=True).strip()
validation = read(args.validation / 'validation.json')
inputs = read(private / 'queue-integration-r483.json')
expected_names = ['migrations', 'state-audit-compatibility', 'documentation', 'rust-format', 'state-audit-evm', 'rust-clippy', 'rust-workspace', 'node-unit', 'steward', 'web-build', 'web-lint']
if validation['status'] != 'passed' or not validation['source_unchanged'] or [c['name'] for c in validation['checks']] != expected_names or any(c['exit_code'] for c in validation['checks']):
    raise SystemExit('All current named gates must pass on unchanged source.')
if git('write-tree') != validation['staged_tree'] or git('diff', '--name-only') or git('ls-files', '--others', '--exclude-standard'):
    raise SystemExit('The source has changed since validation.')
if out.exists():
    raise SystemExit('Preserve the already published or prepared packet.')
selection = read(args.native_selection)
equivalence = read(args.source_equivalence)
native_tree = selection['tested_staged_tree']
if selection['status'] != 'selected-observed-passing-evidence' or equivalence['status'] != 'verified-scope-equivalence':
    raise SystemExit('Observed native selection and explicit scope equivalence required.')
if equivalence['native_execution_tree'] != native_tree or equivalence['validation_source_tree'] != validation['staged_tree']:
    raise SystemExit('Execution and final validation tree identities differ from the reviewed equivalence.')
if sha(args.native_selection.read_bytes()) != equivalence['native_selection']['sha256']:
    raise SystemExit('Native selection changed after source equivalence review.')
sequence_path = Path(selection['sequence_receipt'])
sequence = read(sequence_path)
if sha(sequence_path.read_bytes()) != selection['sequence_sha256'] or sequence['status'] != 'passed' or sequence['tested_staged_tree'] != native_tree:
    raise SystemExit('Completed native sequence no longer matches the selection.')
allowed = sorted(['.github/workflows/ci.yml', 'tools/qa_multiplayer_object_sources.test.mjs',
                  'tools/qa_multiplayer_object_sources.test.ps1', 'tools/qa_multiplayer_preflight.ps1',
                  'tools/qa_multiplayer_preflight.test.ps1'])
if sorted(item['file'] for item in equivalence['changed_paths']) != allowed or equivalence['outside_changed_paths'] != [] or git('diff', '--name-only', native_tree, validation['staged_tree']).splitlines() != allowed:
    raise SystemExit('Native execution source differs outside the five reviewed standalone paths.')
for item in equivalence['changed_paths']:
    for tree, key in [(native_tree, 'before_sha256'), (validation['staged_tree'], 'after_sha256')]:
        raw = subprocess.check_output(['git', '-C', str(repo), 'show', tree + ':' + item['file']])
        if sha(raw) != item[key]:
            raise SystemExit('A reviewed source equivalence blob changed.')
required_native = {'audit', 'delegated', 'database', 'factory-readiness', 'deliverable-failure'}
if {item['name'] for item in selection['suites']} != required_native or len(selection['suites']) != 5:
    raise SystemExit('All five native suite receipts are required.')
for item in selection['suites']:
    receipt = read(Path(item['receipt']))
    if sha(Path(item['receipt']).read_bytes()) != item['receipt_sha256'] or receipt['status'] != 'passed' or receipt.get('tested_staged_tree', receipt.get('staged_tree')) != native_tree:
        raise SystemExit('A native receipt changed or did not pass on its original execution source.')

def normalized(value):
    text = value
    for original, replacement in [(str(repo), '<reviewed-worktree>'), (str(private), '<private-evidence>'), (str(Path.home()), '<local-user>')]:
        for variant in sorted({original, original.replace('\\', '/'), original.replace('\\', '\\\\')}, key=len, reverse=True):
            text = re.sub(re.escape(variant), lambda _: replacement, text, flags=re.I)
    text = re.sub(r'(?<![A-Za-z0-9_])' + re.escape(Path.home().name) + r'(?![A-Za-z0-9_])', '<local-user>', text, flags=re.I)
    return '\n'.join(line.rstrip() for line in text.replace('\r\n', '\n').splitlines()).rstrip('\n') + '\n'

def write_json(relative, value):
    path = out / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(normalized(json.dumps(value, indent=2)), encoding='utf-8')

def copy_artifact(source, relative, expected=None, redact=False):
    source = Path(source)
    raw = source.read_bytes()
    if expected is not None and sha(raw) != expected:
        raise SystemExit('An original evidence artifact changed: ' + relative)
    path = out / relative
    if not path.resolve().is_relative_to(out.resolve()) or path.exists():
        raise SystemExit('Invalid or duplicate evidence destination.')
    path.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() in ('.png', '.jpg', '.webp'):
        data = raw
        treatment = 'Exact original image bytes.'
    else:
        text = raw.decode('utf-8-sig', errors='strict')
        if redact:
            text = subprocess.check_output([str(node), str(private / 'redact-queue-payload-r423.mjs'), str(repo), str(source)], encoding='utf-8')
        data = normalized(text).encode('utf-8')
        treatment = 'Local paths normalized; LF and trailing whitespace normalized.' + (' Capability fields redacted once using the product helper.' if redact else '')
    path.write_bytes(data)
    return {'file': relative, 'original_sha256': sha(raw), 'published_sha256': sha(data), 'treatment': treatment}

def counts(name, text):
    if name in ('rust-workspace', 'state-audit-evm'):
        rows = re.findall(r'test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;', text)
        if not rows:
            raise SystemExit('Missing actual Rust test counts.')
        return {'passed': sum(int(r[0]) for r in rows), 'failed': sum(int(r[1]) for r in rows), 'ignored': sum(int(r[2]) for r in rows), 'summaries': len(rows)}
    if name in ('node-unit', 'steward'):
        result = {}
        for key, label in [('tests','tests'), ('passed','pass'), ('failed','fail'), ('skipped','skipped'), ('cancelled','cancelled')]:
            values = re.findall(r'^(?:#|\u2139) ' + label + r' (\d+)$', text, re.M)
            if not values:
                raise SystemExit('Missing actual Node test counts.')
            result[key] = int(values[-1])
        return result
    return None

out.mkdir(parents=True, exist_ok=False)
(out / '.gitignore').write_text('# Intentionally retained validation logs.\n!*.log\n', encoding='utf-8')
(out / '.gitattributes').write_text('# Preserve published evidence bytes on every checkout.\n* -text\n', encoding='utf-8')
public = {
    'schema_version': 1, 'prs': sorted(item['number'] for item in inputs['inputs']),
    'source_head': validation['head'], 'target_main': validation['target_main'],
    'tested_staged_tree': validation['staged_tree'], 'native_execution_tree': native_tree,
    'native_source_equivalence': 'native-source-equivalence.json', 'status': 'passed',
    'started_at_utc': validation['started_at_utc'], 'finished_at_utc': validation['finished_at_utc'],
    'platform': 'Windows x64', 'node': validation['node'], 'pnpm': validation['pnpm'], 'rustc': validation['rustc'],
    'rust_test_threads': validation['test_threads'], 'git_core_longpaths': validation['git_core_longpaths'],
    'build_isolation': validation['build_isolation'],
    'original_receipt_sha256': sha((args.validation / 'validation.json').read_bytes()),
    'source_binding': 'The final staged/committed tree must equal the tested source after excluding only this newly added packet. All original PR heads remain ancestors.',
    'normalization': 'Published text replaces local source, fixture and user paths, uses LF, and removes trailing whitespace. Original and published hashes are distinct. No historical evidence is reclassified as current acceptance.',
    'checks': [], 'build_preparation': [],
}
for check in validation['checks']:
    artifact = copy_artifact(check['log'], check['name'] + '.log', check['sha256'])
    raw_text = Path(check['log']).read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    public['checks'].append({
        'name': check['name'], 'command': ' '.join([check['program'], *check['arguments']]),
        'exit_code': check['exit_code'], 'duration_seconds': check['duration_seconds'],
        'log': artifact['file'], 'original_log_sha256': artifact['original_sha256'], 'published_log_sha256': artifact['published_sha256'],
        'counts': counts(check['name'], raw_text),
    })
for key in ('workspace_refresh', 'native_mcp_build'):
    original = validation[key]
    artifact = copy_artifact(original['log'], 'build/' + key.replace('_', '-') + '.log', original['sha256'])
    public['build_preparation'].append({'name': key, 'exit_code': original['exit_code'], **artifact, 'binary_sha256': original.get('binary_sha256')})
write_json('validation.json', public)
write_json('native-source-equivalence.json', equivalence)
copy_artifact(sequence_path, 'native/sequence-receipt.json', selection['sequence_sha256'])
copy_artifact(private / 'queue-validation-r454/validation.json', 'native/execution-source-validation.json')
copy_artifact(args.native_selection, 'native/selection.json', equivalence['native_selection']['sha256'])
write_json('integration-inputs.json', {'main': inputs['main'], 'parents': inputs['parents'], 'inputs': [{key: item[key] for key in ('number','title','remote_head','head','pending_parents')} for item in inputs['inputs']]})

native_public = {'status': 'passed', 'tested_staged_tree': native_tree, 'validation_source_tree': validation['staged_tree'], 'source_equivalence': 'native-source-equivalence.json', 'suites': [], 'scope': 'Owned local browser/server/runner and PostgreSQL fixtures. Deterministic providers, local Anvil and synthetic Keycloak. Live Azure and production authentication were not executed.'}
for item in selection['suites']:
    native = read(Path(item['receipt']))
    prefix = 'native/' + item['name']
    receipt_artifact = copy_artifact(item['receipt'], prefix + '/receipt.json', item['receipt_sha256'])
    suite = {'name': item['name'], 'status': 'passed', 'tested_staged_tree': native_tree, 'receipt': receipt_artifact, 'artifacts': [], 'checks': []}
    for check in native.get('checks', native.get('steps', [])):
        if check.get('exit_code') != 0 or check.get('status', 'passed') != 'passed':
            raise SystemExit('A native step did not pass.')
        artifact = copy_artifact(check['log'], prefix + '/' + check['name'] + '.log', check['sha256'])
        suite['checks'].append({'name': check['name'], 'exit_code': 0, 'passed_tests': check.get('passed_tests'), **artifact})
    for artifact in item.get('artifacts', []):
        suite['artifacts'].append(copy_artifact(artifact['source'], prefix + '/' + artifact['name'], artifact.get('sha256'), artifact.get('redact', False)))
    native_public['suites'].append(suite)
write_json('native-acceptance.json', native_public)

prior = read(private / 'queue-validation-r410/validation.json')
prior_public = {key: prior[key] for key in ('head','staged_tree','status','started_at_utc','finished_at_utc','source_unchanged')}
prior_public['original_receipt_sha256'] = sha((private / 'queue-validation-r410/validation.json').read_bytes())
prior_public['failed_checks'] = []
for check in prior['checks']:
    if check['exit_code']:
        artifact = copy_artifact(check['log'], 'prior-attempts/' + check['name'] + '.log', check['sha256'])
        prior_public['failed_checks'].append({'name': check['name'], 'exit_code': check['exit_code'], **artifact})
prior_public['reason'] = 'Generated validation documentation drift and a 16 MiB Git-diff capture limit prevented the full Node lane. Both were corrected before the fresh passing run; prior failures remain failures.'
write_json('prior-attempts/validation-summary.json', prior_public)
for prior_directory in args.prior_validation:
    prior_directory = prior_directory.resolve()
    if prior_directory.parent != private or re.fullmatch(r'queue-validation-r[0-9]+', prior_directory.name) is None:
        raise SystemExit('Only explicitly selected task validation attempts may be retained.')
    prior_path = prior_directory / 'validation.json'
    prior = read(prior_path)
    if prior['status'] != 'failed' or not prior.get('finished_at_utc'):
        raise SystemExit('A retained failed attempt must have finished recording its actual outcome.')
    prior_public = {key: prior[key] for key in ('head', 'staged_tree', 'status', 'started_at_utc', 'finished_at_utc', 'source_unchanged')}
    prior_public['original_receipt_sha256'] = sha(prior_path.read_bytes())
    prior_public['checks'] = [{key: check[key] for key in ('name', 'exit_code', 'duration_seconds', 'sha256')} for check in prior['checks']]
    prior_public['failed_checks'] = []
    prefix = 'prior-attempts/' + prior_directory.name
    for check in prior['checks']:
        if check['exit_code']:
            artifact = copy_artifact(check['log'], prefix + '/' + check['name'] + '.log', check['sha256'])
            prior_public['failed_checks'].append({'name': check['name'], 'exit_code': check['exit_code'], **artifact})
    if not prior_public['failed_checks']:
        raise SystemExit('The selected attempt has no failed gate to retain.')
    prior_public['reason'] = 'This completed attempt failed. Its actual exit codes and failed-gate logs are retained; no failure is reclassified as a pass.'
    write_json(prefix + '/validation-summary.json', prior_public)
for name in ('queue-corrections-r414.json', 'queue-run-checks-correction-r415.json'):
    copy_artifact(private / name, 'corrections/' + name)
for name in ('queue-correction-focus-r419.log', 'queue-python-discovery-r419.log', 'queue-startup-focus-r420.log', 'queue-whitespace-crlf-r420.log'):
    copy_artifact(private / name, 'corrections/' + name)
for artifact in args.correction_artifact:
    artifact = artifact.resolve()
    if artifact.parent != private or not artifact.is_file():
        raise SystemExit('Only explicit private correction artifacts may be retained.')
    copy_artifact(artifact, 'corrections/' + artifact.name)
readme = '''# ECorp PR queue completion evidence

This packet records the combined maintainer review and completion of PRs {prs} on September 23, 2026. The integrated changes cover Factory intake and claim authority, readiness and worktree preservation, startup and verification tooling, aggregate budgets and agent lifecycle controls, verified research delivery, State Audit V1 with optional Base anchoring and archive readback, delegated protected-resource jobs, dependency updates, and repository review/validation workflows.

The implementation is checked against the current product, architecture, security, and evaluation contracts. Tenant/Corp authorization, runner lifetime, isolated write workspaces, evidence-backed completion, durable idempotent effects, scoped secret delivery, and monotonic budget/loop boundaries remain part of that review.

All eleven current recorded gates pass on tested tree `{tree}`. `validation.json` records exact commands, observed counts, ignored/skipped tests, and original/published log hashes. The recorded `pnpm test:js` lane discovers the full configured Node suite; the older `test:unit` subset is not used as its replacement. Only the standalone delegated live suite and immutable PR226 historical replay directory are assigned to their dedicated fixture lanes; adjacent security unit suites remain enrolled, and an exclusion is not a pass. Workspace Rust artifacts were refreshed and native MCP binaries rebuilt from the matching source.

`native-acceptance.json` retains the original execution tree `{native_tree}` for five successful owned native suites: audit/restart/archive/browser readback; delegated Keycloak browser/server/runner behavior; nonzero SQLx execution for Base, audit and delegated storage; Factory connection/dispatch readiness; and preserved deliverable-export failures. Original native receipts, step logs and selected browser artifacts are retained under `native/`. These suites executed before the final five-file PR319 preflight/test/CI update. `native-source-equivalence.json` proves every other tracked entry is identical to the final validation tree, with exact before/after blob hashes for all five reviewed paths. Application code, dependencies and native drivers are unchanged; the final full validation and focused native preflight checks cover the changed standalone paths. Original execution receipts are not relabeled as fresh runs on the final tree. Local Anvil, deterministic providers, development actors and synthetic Keycloak are explicitly fixture coverage. Live Azure and production identity/provider qualification are not claimed.

`integration-inputs.json` records every original PR head and the ordered commit parents. The final commit retains those heads as ancestors. Only this new evidence packet is excluded from comparison with the tested tree; previously retained evidence is included in source equality. Artifact hashes are listed in `artifact-manifest.json`. Text normalization is disclosed in the receipts and preserves original hashes separately. Historical failed attempts remain historical failures under `prior-attempts/`.

Reproduce in an isolated checkout with the repository-pinned toolchain: install with `pnpm install --frozen-lockfile` and run `pnpm check` with `RUST_TEST_THREADS=1`. Build the native `crony-mcp` and set `CRONY_MCP_TEST_BINARY` for the owned MCP lane. Use `native/factory-readiness/run-pr354-native-first-run-r477.ps1` for Factory replay with explicit owned fixture paths and a source-bound validation receipt. It checks the current sixteen named Factory SQLx cases; the retained historical replay expected nine. The existing #355 replay remains the deliverable driver. Failed earlier native attempts and private driver corrections are retained under `corrections/`. Hosted CI and security scans must pass on the actual published commit before merge.
'''.format(prs=', '.join('#' + str(number) for number in public['prs']), tree=validation['staged_tree'], native_tree=native_tree)
(out / 'README.md').write_text(readme, encoding='utf-8')
files = sorted([path for path in out.rglob('*') if path.is_file()])
write_json('artifact-manifest.json', {'schema_version': 1, 'files': [{'path': path.relative_to(out).as_posix(), 'sha256': sha(path.read_bytes())} for path in files]})
subprocess.run(['git', '-C', str(repo), 'add', '--', packet], check=True)
subprocess.run([str(Path(r'<local-user>\AppData\Local\Programs\Python\Python312\python.exe')), '-X', 'utf8', '-B', str(private / 'assert-queue-validation-r484.py'), str(repo)], check=True)
print(json.dumps({'packet': packet, 'source': validation['staged_tree'], 'artifacts': len(files), 'status': 'packaged'}))
