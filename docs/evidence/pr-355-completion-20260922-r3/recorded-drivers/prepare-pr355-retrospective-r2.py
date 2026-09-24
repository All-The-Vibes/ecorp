"""Resume only the verified, incomplete r1 setup; do not claim a test failure."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).parent
product = Path(r'C:\Users\shyamsridhar\code\ecorp-pr355-completion-20260922')
baseline = Path(r'C:\Users\shyamsridhar\code\ecorp-pr355-retrospective-20260922-r1')
output = root / 'pr355-retrospective-r1'
base = '08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce'
git = lambda repo, *args: subprocess.check_output(['git', '-C', str(repo), *args])
sha = lambda data: hashlib.sha256(data).hexdigest()
assert baseline.is_dir() and output.is_dir() and not list(output.iterdir())
assert git(baseline, 'rev-parse', 'HEAD').decode().strip() == base
assert not git(baseline, 'diff', '--cached', '--name-only').strip()
assert not git(baseline, 'diff', '--name-only').strip()
assert not git(product, 'diff', '--name-only').strip()
test_relative = 'crates/crony-store/src/deliverable_failure_tests.rs'
lib_relative = 'crates/crony-store/src/lib.rs'
original = (product / test_relative).read_bytes()
assert original.decode().count('RunFailureKind::DeliverableExport') == 2
compatible = original.decode().replace('RunFailureKind::DeliverableExport', '"deliverable_export"').replace('\r\n', '\n').encode()
assert (baseline / test_relative).read_bytes() == compatible
lib = baseline / lib_relative
original_lib = git(baseline, 'show', base + ':' + lib_relative)
assert lib.read_bytes().replace(b'\r\n', b'\n') == original_lib.replace(b'\r\n', b'\n')
text = lib.read_text()
anchor = '#[cfg(test)]\nmod budget_checkpoint_tests;'
assert text.count(anchor) == 1 and 'mod deliverable_failure_tests;' not in text
lib.write_bytes(text.replace(anchor, '#[cfg(test)]\nmod deliverable_failure_tests;\n\n' + anchor, 1).encode())
subprocess.run(['git', '-C', str(baseline), 'add', '--', lib_relative, test_relative], check=True)
assert set(git(baseline, 'diff', '--cached', '--name-only').decode().splitlines()) == {lib_relative, test_relative}
patch = git(baseline, 'diff', '--cached', '--binary', base)
(output / 'baseline-test-only.patch').write_bytes(patch)
(output / 'candidate-test-original.rs').write_bytes(original)
(output / 'baseline-test-compatible.rs').write_bytes(compatible)
manifest = {
    'scope': 'Retrospective behavior comparison, not original development chronology. Baseline production bytes are unchanged; the overlay contains the existing candidate test module with JSON strings replacing its later enum and a cfg(test) module declaration.',
    'setup_history': 'r1 created the detached checkout and compatible test file, then stopped on a missing module anchor before staging or executing any test. This was a setup failure, not behavioral RED. r2 verified that exact partial state before resuming.',
    'r1_setup_script_sha256': sha((root / 'prepare-pr355-retrospective-r1.py').read_bytes()),
    'r2_setup_script_sha256': sha(Path(__file__).read_bytes()),
    'baseline_repository': str(baseline), 'baseline_commit': base,
    'baseline_committed_tree': git(baseline, 'rev-parse', 'HEAD^{tree}').decode().strip(),
    'baseline_tested_tree': git(baseline, 'write-tree').decode().strip(),
    'baseline_test_only_patch_sha256': sha(patch),
    'baseline_test_sha256': sha(compatible),
    'candidate_repository': str(product),
    'candidate_head': git(product, 'rev-parse', 'HEAD').decode().strip(),
    'candidate_tested_tree': git(product, 'write-tree').decode().strip(),
    'candidate_test_sha256': sha(original),
}
(output / 'source-manifest.json').write_bytes((json.dumps(manifest, indent=2) + '\n').encode())
print(json.dumps(manifest))
