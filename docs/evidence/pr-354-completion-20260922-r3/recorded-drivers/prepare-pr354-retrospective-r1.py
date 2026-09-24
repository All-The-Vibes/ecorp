from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).parent
product = Path(r'C:\Users\shyamsridhar\code\ecorp-pr354-completion-20260922')
baseline = Path(r'C:\Users\shyamsridhar\code\ecorp-pr354-retrospective-20260922-r1')
output = root / 'pr354-retrospective-r1'
base = '08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce'
relative = 'crates/crony-server/src/main.rs'
git = lambda repo, *args: subprocess.check_output(['git', '-C', str(repo), *args])
sha = lambda data: hashlib.sha256(data).hexdigest()
assert not baseline.exists() and not output.exists()
assert not git(product, 'diff', '--name-only').strip()
original = (product / relative).read_text()
start = '    #[tokio::test]\n    async fn issue256_start_dispatch_rechecks_capabilities_after_selection() {'
end = '    #[test]\n    fn model_less_adapter_reports_the_invalid_model_requirement() {'
assert original.count(start) == 1 and original.count(end) == 1
test = original[original.index(start):original.index(end)]
assert test.count('stale {changed} capability reached enqueue') == 1
source = git(product, 'show', base + ':' + relative).decode()
assert source.count(end) == 1 and start not in source
for required in ('fn reconnect_test_connection(', 'fn reconnect_test_command(', 'fn model(', 'RunnerRequirements,', 'send_command_to_current_runner,', 'mpsc, oneshot'):
    assert required in source, required
subprocess.run(['git', '-C', str(product), 'worktree', 'add', '--detach', str(baseline), base], check=True)
(baseline / relative).write_bytes(source.replace(end, test + end, 1).encode())
subprocess.run(['git', '-C', str(baseline), 'add', '--', relative], check=True)
assert git(baseline, 'diff', '--cached', '--name-only').decode().splitlines() == [relative]
output.mkdir()
patch = git(baseline, 'diff', '--cached', '--binary', base)
(output / 'baseline-test-only.patch').write_bytes(patch)
(output / 'candidate-test-original.rs').write_bytes(test.encode())
manifest = {
    'scope': 'Retrospective behavior comparison, not original TDD chronology. The baseline overlay adds only the exact existing candidate test function; all baseline production code is unchanged.',
    'setup_driver_sha256': sha(Path(__file__).read_bytes()),
    'baseline_repository': str(baseline), 'baseline_commit': base,
    'baseline_committed_tree': git(baseline, 'rev-parse', 'HEAD^{tree}').decode().strip(),
    'baseline_tested_tree': git(baseline, 'write-tree').decode().strip(),
    'baseline_test_only_patch_sha256': sha(patch), 'test_function_sha256': sha(test.encode()),
    'candidate_repository': str(product), 'candidate_head': git(product, 'rev-parse', 'HEAD').decode().strip(),
    'candidate_tested_tree': git(product, 'write-tree').decode().strip(),
}
(output / 'source-manifest.json').write_bytes((json.dumps(manifest, indent=2) + '\n').encode())
print(json.dumps(manifest))
