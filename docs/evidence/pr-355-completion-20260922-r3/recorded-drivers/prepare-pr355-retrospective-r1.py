from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).parent
product = Path(r'C:\Users\shyamsridhar\code\ecorp-pr355-completion-20260922')
baseline = Path(r'C:\Users\shyamsridhar\code\ecorp-pr355-retrospective-20260922-r1')
output = root / 'pr355-retrospective-r1'
base = '08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce'
assert not baseline.exists() and not output.exists(), 'Preserve prior work.'
git = lambda repo, *args: subprocess.check_output(['git', '-C', str(repo), *args])
assert not git(product, 'diff', '--name-only').strip()
output.mkdir()
subprocess.run(['git', '-C', str(product), 'worktree', 'add', '--detach', str(baseline), base], check=True)
original = (product / 'crates/crony-store/src/deliverable_failure_tests.rs').read_bytes()
test = original.decode().replace('RunFailureKind::DeliverableExport', '"deliverable_export"')
assert original.decode().count('RunFailureKind::DeliverableExport') == 2
test_path = baseline / 'crates/crony-store/src/deliverable_failure_tests.rs'
assert not test_path.exists()
test_path.write_bytes(test.replace('\r\n', '\n').encode())
lib = baseline / 'crates/crony-store/src/lib.rs'
text = lib.read_text()
anchor = '#[cfg(test)]\nmod retained_provider_receipt_tests;'
assert anchor in text
text = text.replace(anchor, '#[cfg(test)]\nmod deliverable_failure_tests;\n\n' + anchor, 1)
lib.write_bytes(text.encode())
subprocess.run(['git', '-C', str(baseline), 'add', '--', 'crates/crony-store/src/lib.rs', 'crates/crony-store/src/deliverable_failure_tests.rs'], check=True)
patch = git(baseline, 'diff', '--cached', '--binary', base)
(output / 'baseline-test-only.patch').write_bytes(patch)
(output / 'candidate-test-original.rs').write_bytes(original)
(output / 'baseline-test-compatible.rs').write_bytes(test_path.read_bytes())
sha = lambda data: hashlib.sha256(data).hexdigest()
manifest = {
    'scope': 'Retrospective behavior comparison, not original development chronology. Baseline production bytes are unchanged; its only overlay is the existing candidate test module with JSON strings replacing the future enum plus the test module declaration.',
    'baseline_repository': str(baseline), 'baseline_commit': base,
    'baseline_committed_tree': git(baseline, 'rev-parse', 'HEAD^{tree}').decode().strip(),
    'baseline_tested_tree': git(baseline, 'write-tree').decode().strip(),
    'baseline_test_only_patch_sha256': sha(patch),
    'baseline_test_sha256': sha(test_path.read_bytes()),
    'candidate_repository': str(product),
    'candidate_head': git(product, 'rev-parse', 'HEAD').decode().strip(),
    'candidate_tested_tree': git(product, 'write-tree').decode().strip(),
    'candidate_test_sha256': sha(original),
}
(output / 'source-manifest.json').write_bytes((json.dumps(manifest, indent=2) + '\n').encode())
print(json.dumps(manifest))
