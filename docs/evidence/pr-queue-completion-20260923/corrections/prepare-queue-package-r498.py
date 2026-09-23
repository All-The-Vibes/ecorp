"""Preserve the original packager and accept the observed Node spec summary."""
import ast
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent
repo = Path(r'<reviewed-worktree>')
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
validation_path = root / 'queue-validation-r479/validation.json'
validation = read(validation_path)
expected_tree = '54c6dbd01b9cd027b1920c58a65f5651574247cd'
git = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
if (validation['status'] != 'passed' or not validation['source_unchanged']
        or validation['staged_tree'] != expected_tree or git('write-tree') != expected_tree
        or git('diff', '--name-only') or git('ls-files', '--others', '--exclude-standard')):
    raise SystemExit('Require the completed unchanged-source validation and no partial packet.')

old_path = root / 'package-queue-validation-r484.py'
new_path = root / 'package-queue-validation-r498.py'
old_run_path = root / 'run-queue-package-r487.py'
new_run_path = root / 'run-queue-package-r498.py'
receipt_path = root / 'queue-packaging-correction-r498.json'
if any(p.exists() for p in (new_path, new_run_path, receipt_path)):
    raise SystemExit('Preserve existing packaging correction files.')
old_source = old_path.read_text(encoding='utf-8')
needle = "re.findall(r'^# ' + label + r' (\\d+)$', text, re.M)"
replacement = "re.findall(r'^(?:#|\\u2139) ' + label + r' (\\d+)$', text, re.M)"
if old_source.count(needle) != 1:
    raise SystemExit('Unexpected summary parser; inspect before editing.')
new_source = old_source.replace(needle, replacement)
ast.parse(new_source)

def parser_from(source):
    functions = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'counts']
    if len(functions) != 1:
        raise SystemExit('Expected one private count parser.')
    scope = {'re': re}
    exec(compile(ast.Module(body=functions, type_ignores=[]), '<retained-count-parser>', 'exec'), scope)
    return scope['counts']

before = parser_from(old_source)
after = parser_from(new_source)
logs = {name: (root / 'queue-validation-r479' / (name + '.log')).read_text(encoding='utf-8-sig')
        for name in ('node-unit', 'steward')}
try:
    before('steward', logs['steward'])
except SystemExit as exc:
    observed_failure = str(exc)
else:
    raise SystemExit('The retained steward log did not reproduce the observed packaging failure.')
if observed_failure != 'Missing actual Node test counts.':
    raise SystemExit('Unexpected original parser failure.')
counts = {name: after(name, log) for name, log in logs.items()}
if counts['node-unit'] != before('node-unit', logs['node-unit']):
    raise SystemExit('TAP counts changed.')
if counts['node-unit'] != {'tests': 3052, 'passed': 3031, 'failed': 0, 'skipped': 21, 'cancelled': 0}:
    raise SystemExit('Full Node counts differ from the observed final summary.')
if counts['steward'] != {'tests': 227, 'passed': 227, 'failed': 0, 'skipped': 0, 'cancelled': 0}:
    raise SystemExit('Steward counts differ from the observed final summary.')

run_source = old_run_path.read_text(encoding='utf-8')
run_needle = "str(root / 'package-queue-validation-r484.py'),"
if run_source.count(run_needle) != 1:
    raise SystemExit('Unexpected package runner.')
run_source = run_source.replace(run_needle, "str(root / 'package-queue-validation-r498.py'),")
artifact_needle = "    'package-queue-validation-r484.py',\n)]"
artifact_replacement = """    'package-queue-validation-r484.py',
    'queue-packaging-failure-r497.json',
    'queue-packaging-correction-r498.json',
    'prepare-queue-package-r498.py',
    'package-queue-validation-r498.py',
    'run-queue-package-r498.py',
)]"""
if run_source.count(artifact_needle) != 1:
    raise SystemExit('Unexpected correction artifact list.')
run_source = run_source.replace(artifact_needle, artifact_replacement)
ast.parse(run_source)
new_path.write_text(new_source, encoding='utf-8')
new_run_path.write_text(run_source, encoding='utf-8')
record = {
    'status': 'verified-private-reporting-correction',
    'observed_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'source_tree': expected_tree,
    'validation_sha256': sha(validation_path),
    'preserved_failure': {'file': 'queue-packaging-failure-r497.json', 'sha256': sha(root / 'queue-packaging-failure-r497.json')},
    'change': 'Accept either the observed Node TAP # prefix or native spec U+2139 prefix for final numeric summaries. Product source and original logs are unchanged.',
    'verification': {'original_steward_parser': observed_failure, 'corrected_actual_counts': counts, 'tap_counts_unchanged': True},
    'files': [{'file': p.name, 'sha256': sha(p)} for p in (old_path, old_run_path, new_path, new_run_path, Path(__file__))],
}
receipt_path.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': record['status'], 'counts': counts, 'receipt': str(receipt_path)}))
