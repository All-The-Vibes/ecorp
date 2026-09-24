from pathlib import Path
import hashlib
import json
import subprocess

base = Path(__file__).resolve().parent
repo = Path(r'<reviewed-worktree>')
baseline = Path(r'<local-user>\code\ecorp-pr359-room-baseline-20260923')
head = 'd360d3bd1001d8cb9baff0323408865de6c42a6b'
path = 'crates/crony-server/src/main.rs'
test = 'crates/crony-server/src/factory_connection_tests.rs'
git = lambda where, *args: subprocess.check_output(['git', '-C', str(where), *args])
sha = lambda data: hashlib.sha256(data).hexdigest()
assert git(repo, 'rev-parse', 'HEAD').decode().strip() == head
assert git(baseline, 'rev-parse', 'HEAD').decode().strip() == head
assert not git(baseline, 'status', '--porcelain').strip()
original = git(repo, 'show', head + '^1:' + path)
call = b'.agents_for_planning(corp_id, input.actor_id)'
assert original.count(call) == 1
adapted = original.replace(call, b'.agents_for_planning(corp_id, input.actor_id, None)')
assert (baseline / test).read_bytes() == (repo / test).read_bytes()
receipt_path = base / 'pr359-room-retrospective-source-r1.json'
assert not receipt_path.exists()
(baseline / path).write_bytes(adapted)
subprocess.run(['git', '-C', str(baseline), 'add', '--', path], check=True)
record = {
    'candidate_head': head,
    'baseline_head': head,
    'baseline_staged_tree': git(baseline, 'write-tree').decode().strip(),
    'historical_planner_commit': git(repo, 'rev-parse', head + '^1').decode().strip(),
    'historical_main_git_sha256': sha(original),
    'baseline_main_git_sha256': sha(git(baseline, 'show', ':' + path)),
    'candidate_main_git_sha256': sha(git(repo, 'show', 'HEAD:' + path)),
    'test_git_sha256': sha(git(repo, 'show', 'HEAD:' + test)),
    'test_worktree_sha256': sha((repo / test).read_bytes()),
    'baseline_scope': 'Exact historical main.rs with one interface-only bridge: the former two-argument agents_for_planning call supplies None to the current store signature. None selects the original default/oldest-room behavior. The entire candidate test and current store are identical in both variants. No test assertions are changed.',
    'chronology': 'Retrospective behavioral regression, not original development chronology.',
}
receipt_path.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
(base / 'pr359-room-historical-main-r1.rs').write_bytes(original)
print(json.dumps(record))
