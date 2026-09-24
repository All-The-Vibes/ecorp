"""Build isolated historical/current regression fixtures; never alter PR source."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

base = Path(__file__).parent
product = Path(r'C:\Users\shyamsridhar\code\ecorp-pr358-completion-20260922')
out = base / 'pr358-retrospective-r1'
out.mkdir(exist_ok=False)

def git(repo, *args):
    return subprocess.check_output(['git', '--no-replace-objects', '-c', 'core.longpaths=true', '-C', str(repo), *args])

def textgit(repo, *args):
    return git(repo, *args).decode().strip()

def digest(data):
    return hashlib.sha256(data).hexdigest()

head = textgit(product, 'rev-parse', 'HEAD')
tree = textgit(product, 'write-tree')
assert not git(product, 'diff', '--name-only').strip()
main = textgit(product, 'rev-parse', 'origin/main')
source_path = 'crates/crony-store/src/aggregate_breaker_tests.rs'
source = git(product, 'show', ':' + source_path).decode()

def function(name):
    start = re.search(r'(?m)^(?:pub\(super\) )?(?:async )?fn ' + re.escape(name) + r'\(', source)
    assert start, name
    end = re.search(r'(?m)^}\s*$', source[start.start():])
    assert end, name
    return source[start.start():start.start() + end.end()].rstrip() + '\n'

common = source[:source.index('async fn fixture(')]
common += '\n'.join(function(name) for name in ['fixture', 'run_id', 'add_run'])
attribute = '#[sqlx::test(migrations = "../../db/migrations")]\n#[ignore = "requires explicitly owned retrospective PostgreSQL"]\n'
aggregate = common + '\n' + attribute + function('issue56_mission_hard_budget_fences_all_active_runs')
lease = common + '\n' + function('queue_control') + '\n' + function('wait_for_control_blocker')
lease += '\ninclude!("pr358_retrospective_dispatch_adapter.rs");\n\n'
original = function('issue56_control_dispatch_revalidates_lease_after_run_wait')
case_list = '[\n        "renew",\n        "release",\n        "transfer",\n        "expire",\n        "release_reacquire",\n    ]'
assert original.count(case_list) == 1
for case in ['renew', 'release_reacquire']:
    test = original.replace('issue56_control_dispatch_revalidates_lease_after_run_wait',
                            'issue56_control_dispatch_revalidates_lease_after_run_wait_' + case)
    test = test.replace(case_list, '["' + case + '"]')
    test = test.replace('.with_progress_command_dispatch(', '.retrospective_progress_dispatch(')
    lease += attribute + test + '\n'
adapter_prefix = '''// Compatibility-only callback bridge; the regression assertions are shared.
impl PgStore {
    async fn retrospective_progress_dispatch<F>(
        &self, command: &PendingRunnerCommand, dispatch: F,
    ) -> Result<RunnerCommandDispatchOutcome>
    where F: FnOnce(Option<Uuid>) -> Result<bool> {
'''
adapters = {
    'historical': adapter_prefix + '        self.with_progress_command_dispatch(command, || dispatch(None).expect("regression callback returned error")).await\n    }\n}\n',
    'current': adapter_prefix + '        self.with_progress_command_dispatch(command, dispatch).await\n    }\n}\n',
}
snapshot = textgit(product, '-c', 'user.name=ECorp QA', '-c', 'user.email=qa@ecorp.invalid',
                   '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', head, '-p', main,
                   '-m', 'Private PR 358 retrospective source snapshot; never publish')
assert textgit(product, 'rev-parse', snapshot + '^{tree}') == tree
baselines = {
    'aggregate-before': textgit(product, 'rev-parse', 'f635b74fb54d5e74ae6a0efb31055871d26dfda0^'),
    'lease-before': textgit(product, 'rev-parse', '2e02c95a44fe4b1f7b103ac68c51e8c18476bca8'),
    'current': snapshot,
}
record = {
    'status': 'prepared', 'product_head': head, 'product_staged_tree': tree, 'target_main': main,
    'source_test_path': source_path, 'source_test_git_sha256': digest(source.encode()),
    'method': 'Retrospective execution, not original TDD. Historical product source is unchanged. Shared tests retain current fixtures and assertions; renewal and reacquisition run separately so a first failure cannot hide the other case. Only the old callback shape is bridged in a separate test-only adapter.',
    'shared_tests': {'aggregate_sha256': digest(aggregate.encode()), 'lease_sha256': digest(lease.encode())},
    'cases': [],
}
for name, revision in baselines.items():
    repo = product.parent / ('ecorp-pr358-regression-' + name + '-20260923-r1')
    assert not repo.exists(), repo
    subprocess.run(['git', '-c', 'core.longpaths=true', '-C', str(product), 'worktree', 'add', '--detach', str(repo), revision], check=True,
                   stdout=(out / (name + '-checkout.log')).open('wb'), stderr=subprocess.STDOUT)
    assert not git(repo, 'status', '--porcelain=v1').strip()
    src = repo / 'crates/crony-store/src'
    added = []
    modules = []
    if name != 'lease-before':
        (src / 'pr358_retrospective_aggregate.rs').write_text(aggregate, encoding='utf-8', newline='\n')
        modules.append('pr358_retrospective_aggregate')
        added.append('pr358_retrospective_aggregate.rs')
    if name != 'aggregate-before':
        (src / 'pr358_retrospective_lease.rs').write_text(lease, encoding='utf-8', newline='\n')
        adapter = adapters['historical' if name == 'lease-before' else 'current']
        (src / 'pr358_retrospective_dispatch_adapter.rs').write_text(adapter, encoding='utf-8', newline='\n')
        modules.append('pr358_retrospective_lease')
        added += ['pr358_retrospective_lease.rs', 'pr358_retrospective_dispatch_adapter.rs']
    with (src / 'lib.rs').open('a', encoding='utf-8', newline='\n') as file:
        for module in modules:
            file.write('\n#[cfg(test)]\nmod ' + module + ';\n')
    paths = ['crates/crony-store/src/lib.rs'] + ['crates/crony-store/src/' + f for f in added]
    git(repo, 'add', '--', *paths)
    test_tree = textgit(repo, 'write-tree')
    record['cases'].append({'name': name, 'repository': str(repo), 'source_commit': revision,
                            'original_tree': textgit(repo, 'rev-parse', 'HEAD^{tree}'),
                            'test_tree': test_tree, 'expected_exit': 0 if name == 'current' else 101,
                            'expected_tests': 3 if name == 'current' else (2 if name == 'lease-before' else 1),
                            'files': {f: digest((src / f).read_bytes()) for f in added},
                            'test_only_changed_paths': git(repo, 'diff', '--cached', '--name-only').decode().splitlines()})
assert textgit(product, 'write-tree') == tree and not git(product, 'diff', '--name-only').strip()
(out / 'preparation.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': 'prepared', 'source_tree': tree, 'fixtures': [r['name'] for r in record['cases']]}))
