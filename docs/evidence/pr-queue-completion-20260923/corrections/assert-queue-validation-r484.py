"""Read-only, exact-source validation of the combined queue before publication."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('repository', type=Path)
parser.add_argument('--committed', action='store_true')
args = parser.parse_args()
repo = args.repository.resolve()
packet = 'docs/evidence/pr-queue-completion-20260923'
root = repo / packet
receipt = json.loads((root / 'validation.json').read_text(encoding='utf-8'))
expected_prs = [226, 237, 255, 283, 293, 294, 304, 305, 319, 320, 323, 325, 332, 353, 354, 355, 358, 359]
expected_gates = {
    'migrations': 'node tools/check_migrations.mjs',
    'state-audit-compatibility': 'pnpm check:state-audit-compatibility',
    'documentation': 'pnpm check:docs',
    'rust-format': 'cargo fmt --check',
    'state-audit-evm': 'pnpm check:state-audit-evm',
    'rust-clippy': 'cargo clippy --workspace --all-targets --locked -- -D warnings',
    'rust-workspace': 'cargo test --workspace --locked',
    'node-unit': 'pnpm test:js',
    'steward': 'pnpm test:steward',
    'web-build': 'pnpm build:web',
    'web-lint': 'pnpm lint:web',
}

def require(condition, message):
    if not condition:
        raise SystemExit(message)

def git(*argv):
    return subprocess.check_output(['git', '-C', str(repo), *argv], text=True).strip()

require(receipt['status'] == 'passed' and sorted(receipt['prs']) == expected_prs, 'Exact completed queue receipt required.')
require(len(receipt['checks']) == len(expected_gates), 'Complete current validation plan required.')
require({item['name']: item['command'] for item in receipt['checks']} == expected_gates, 'Validation commands differ from the reviewed plan.')
require(all(item['exit_code'] == 0 for item in receipt['checks']), 'A gate did not pass.')
tree = receipt['tested_staged_tree']
require(re.fullmatch('[a-f0-9]{40}', tree) is not None, 'Invalid tested tree.')
require(not git('diff', '--name-only') and not git('ls-files', '--others', '--exclude-standard'), 'Unstaged source must be reviewed first.')
if args.committed:
    require(not git('diff', '--cached', '--name-only'), 'Committed queue must be clean.')
    delta = git('diff', '--name-only', tree, 'HEAD', '--', '.', f':(exclude){packet}/**')
else:
    delta = git('diff', '--cached', '--name-only', tree, '--', '.', f':(exclude){packet}/**')
require(not delta, 'Product source differs from the validated tree.')
for check in receipt['checks']:
    require(re.fullmatch('[a-z0-9-]+[.]log', check['log']) is not None, 'Invalid gate log path.')
    require(hashlib.sha256((root / check['log']).read_bytes()).hexdigest() == check['published_log_sha256'], 'Published gate log changed.')
    if check['name'] in ('rust-workspace', 'node-unit', 'steward'):
        counts = check['counts']
        require(counts['passed'] > 0 and counts['failed'] == 0, 'Real passing test counts required.')
native = json.loads((root / 'native-acceptance.json').read_text(encoding='utf-8'))
native_tree = native['tested_staged_tree']
require(native['status'] == 'passed' and native['validation_source_tree'] == tree, 'Matching final validation source required.')
equivalence = json.loads((root / 'native-source-equivalence.json').read_text(encoding='utf-8'))
require(equivalence['status'] == 'verified-scope-equivalence'
        and equivalence['native_execution_tree'] == native_tree
        and equivalence['validation_source_tree'] == tree, 'Explicit native source equivalence required.')
allowed = sorted(['.github/workflows/ci.yml', 'tools/qa_multiplayer_object_sources.test.mjs',
                  'tools/qa_multiplayer_object_sources.test.ps1', 'tools/qa_multiplayer_preflight.ps1',
                  'tools/qa_multiplayer_preflight.test.ps1'])
require(sorted(item['file'] for item in equivalence['changed_paths']) == allowed
        and equivalence['outside_changed_paths'] == [], 'Unexpected native equivalence scope.')
require(git('diff', '--name-only', native_tree, tree).splitlines() == allowed, 'Native source equivalence no longer holds.')
for item in equivalence['changed_paths']:
    for revision, key in [(native_tree, 'before_sha256'), (tree, 'after_sha256')]:
        raw = subprocess.check_output(['git', '-C', str(repo), 'show', revision + ':' + item['file']])
        require(hashlib.sha256(raw).hexdigest() == item[key], 'A reviewed equivalence blob differs.')
for suite in native['suites']:
    native_receipt = json.loads((root / suite['receipt']['file']).read_text(encoding='utf-8'))
    require(native_receipt['status'] == 'passed'
            and native_receipt.get('tested_staged_tree', native_receipt.get('staged_tree')) == native_tree
            and suite['tested_staged_tree'] == native_tree, 'A native receipt lost its original source binding.')
require({item['name'] for item in native['suites']} == {'audit', 'delegated', 'database', 'factory-readiness', 'deliverable-failure'}, 'Required native suites missing.')
require(all(item['status'] == 'passed' for item in native['suites']), 'A native acceptance suite failed.')
manifest = json.loads((root / 'artifact-manifest.json').read_text(encoding='utf-8'))
listed = set()
for item in manifest['files']:
    relative = item['path']
    selected = (root / relative).resolve()
    require(selected.is_relative_to(root.resolve()) and selected.is_file(), 'Invalid evidence path.')
    require(relative not in listed, 'Duplicate manifest entry.')
    listed.add(relative)
    require(hashlib.sha256(selected.read_bytes()).hexdigest() == item['sha256'], 'An evidence artifact changed.')
actual = {path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file() and path.name != 'artifact-manifest.json'}
require(listed == actual, 'Evidence manifest is incomplete.')
inputs = json.loads((root / 'integration-inputs.json').read_text(encoding='utf-8'))
require(sorted(item['number'] for item in inputs['inputs']) == expected_prs, 'Original input list changed.')
if args.committed:
    parents = git('show', '-s', '--format=%P', 'HEAD').split()
    require(parents == inputs['parents'], 'Combined commit must retain every recorded parent in order.')
    for item in inputs['inputs']:
        result = subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', item['remote_head'], 'HEAD'], capture_output=True)
        require(result.returncode == 0, 'An original PR head is missing from committed ancestry.')
require(git('write-tree') == (git('rev-parse', 'HEAD^{tree}') if args.committed else git('write-tree')), 'Index is inconsistent.')
print(json.dumps({'status': 'passed', 'prs': expected_prs, 'tested_staged_tree': tree, 'committed': args.committed, 'artifacts': len(listed)}))
