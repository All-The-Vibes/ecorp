"""Package only the completed final validation and explicitly selected native evidence."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
selection = read(root / 'queue-native-selection-r481.json')
plan = read(root / 'queue-package-inputs-r458.json')
equivalence = read(root / 'queue-native-source-equivalence-r483.json')
validation = read(root / 'queue-validation-r479/validation.json')
if validation['status'] != 'passed' or not validation['source_unchanged'] or validation['staged_tree'] != equivalence['validation_source_tree']:
    raise SystemExit('Final unchanged-source validation has not passed.')
corrections = []
for item in plan['correction_artifacts']:
    path = root / item['file']
    if sha(path) != item['sha256']:
        raise SystemExit('A preserved correction changed.')
    corrections.append(path)
corrections += [Path(p) for p in selection['correction_artifacts']]
corrections += [root / name for name in (
    'queue-pr319-candidate-r475.json',
    'queue-pr319-candidate-r475-objects.log',
    'queue-pr319-candidate-r475-preflight.log',
    'queue-application-binding-r483.json',
    'queue-pr319-integration-r483.json',
    'queue-native-source-equivalence-r483.json',
    'queue-publication-helpers-r484.json',
    'queue-feedback-binding-r486.json',
    'prepare-queue-application-r483.py',
    'apply-queue-pr319-r483.py',
    'prepare-queue-native-selection-r481.py',
    'select-queue-native-r481.py',
    'prepare-queue-publication-r484.py',
    'assert-queue-validation-r484.py',
    'package-queue-validation-r484.py',
    'queue-packaging-failure-r497.json',
    'queue-packaging-correction-r498.json',
    'prepare-queue-package-r498.py',
    'package-queue-validation-r498.py',
    'run-queue-package-r498.py',
)]
unique = {}
for path in corrections:
    path = path.resolve()
    if path.parent != root or not path.is_file():
        raise SystemExit('Only explicit retained private correction files may be packaged.')
    if path.name in unique and unique[path.name] != path:
        raise SystemExit('Conflicting correction destination.')
    unique[path.name] = path
argv = [sys.executable, '-X', 'utf8', '-B', str(root / 'package-queue-validation-r498.py'),
        '--validation', str(root / 'queue-validation-r479'),
        '--native-selection', str(root / 'queue-native-selection-r481.json'),
        '--source-equivalence', str(root / 'queue-native-source-equivalence-r483.json')]
for name in plan['prior_validation']:
    argv += ['--prior-validation', str(root / name)]
for path in unique.values():
    argv += ['--correction-artifact', str(path)]
subprocess.run(argv, check=True)
