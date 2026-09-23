"""Preserve the failed line-number matcher and run the same source on a fresh fixture."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).parent
old = root / 'pr355-retrospective-r1'
new = root / 'pr355-retrospective-r2'
driver_path = root / 'run-pr355-retrospective-r3.ps1'
assert not new.exists() and not driver_path.exists()
manifest = json.loads((old / 'source-manifest.json').read_text(encoding='utf-8-sig'))
test = Path(manifest['baseline_repository']) / 'crates/crony-store/src/deliverable_failure_tests.rs'
assert hashlib.sha256(test.read_bytes()).hexdigest() == manifest['baseline_test_sha256']
lines = test.read_text().splitlines()
assert lines[177].strip() == 'assert_eq!(after["tasks"][0]["status"], "failed");'
prior = json.loads((old / 'receipt.json').read_text(encoding='utf-8-sig'))
assert prior['status'] == 'failed'
assert prior['commands'][0]['expected_behavior_observed']
red = prior['commands'][1]
assert red['exit_code'] == 101 and not red['expected_behavior_observed']
raw = Path(red['log']).read_bytes()
assert hashlib.sha256(raw).hexdigest() == red['sha256']
assert b'deliverable_failure_tests.rs:178:5:' in raw
assert b'left: String("ready")' in raw and b'right: "failed"' in raw
driver = (root / 'run-pr355-retrospective-r2.ps1').read_text(encoding='utf-8-sig')
for before, after in [
    ("$root=Join-Path $PSScriptRoot 'pr355-retrospective-r1'", "$root=Join-Path $PSScriptRoot 'pr355-retrospective-r2'"),
    ("$qa='C:\\Users\\shyamsridhar\\code\\qa\\pr355-retrospective-20260922-r1'", "$qa='C:\\Users\\shyamsridhar\\code\\qa\\pr355-retrospective-20260922-r2'"),
    ('$port=59475', '$port=59476'),
    ("'deliverable_failure_tests.rs:177:'", "'deliverable_failure_tests\\.rs:178:5:'"),
]:
    assert driver.count(before) == 1, before
    driver = driver.replace(before, after)
new.mkdir()
for name in ['source-manifest.json', 'baseline-test-only.patch', 'candidate-test-original.rs', 'baseline-test-compatible.rs']:
    (new / name).write_bytes((old / name).read_bytes())
driver_path.write_text(driver, encoding='utf-8', newline='\n')
(new / 'retry-provenance.json').write_text(json.dumps({
    'reason': 'The previous run reproduced the intended task ready-versus-failed assertion at line 178, but its matcher required line 177. Preserve that failed receipt and rerun unchanged product and test bytes with the verified line number and a fresh owned database.',
    'previous_receipt_sha256': hashlib.sha256((old / 'receipt.json').read_bytes()).hexdigest(),
    'previous_driver_sha256': hashlib.sha256((root / 'run-pr355-retrospective-r2.ps1').read_bytes()).hexdigest(),
    'corrected_driver_sha256': hashlib.sha256(driver_path.read_bytes()).hexdigest(),
    'baseline_tested_tree': manifest['baseline_tested_tree'],
    'candidate_tested_tree': manifest['candidate_tested_tree'],
}, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'driver': str(driver_path), 'evidence': str(new), 'assertion_line': 178}))
