"""Verify recorded source trees using a private alternate Git index.

Run from a clone containing the final integration commit:
  python docs/evidence/pr-queue-reconciliation-20260923-r578/verify_source.py <commit>
No checkout, ref, repository index, or working file is changed.
"""
import json, os, subprocess, sys, tempfile
from pathlib import Path

repo = Path(__file__).resolve().parents[3]
revision = sys.argv[1] if len(sys.argv) == 2 else 'HEAD'
def git(*args, env=None):
    return subprocess.check_output(['git', '-C', str(repo), *args], env=env).decode().strip()
with tempfile.TemporaryDirectory(prefix='ecorp-evidence-index-') as owned:
    env = dict(os.environ, GIT_INDEX_FILE=str(Path(owned) / 'index'))
    git('read-tree', revision, env=env)
    for path in git('ls-files', '--', 'docs/evidence/pr-queue-reconciliation-20260923-r578', env=env).splitlines():
        git('update-index', '--force-remove', '--', path, env=env)
    final = git('write-tree', env=env)
    if final != '85d872ede83d697950674d891e16d6da15f2cd9f':
        raise SystemExit('The supplied commit does not reconstruct the recorded final execution tree.')
    for path in git('ls-files', '--', 'docs/evidence/pr-queue-corrections-20260923-r552', env=env).splitlines():
        git('update-index', '--force-remove', '--', path, env=env)
    for path in ['docs/VALIDATION.md', 'tests/readiness/cli.test.js', 'tools/readiness_contract.test.mjs', 'tools/run_checks.mjs']:
        entry = git('ls-tree', '4cc00784ff7a23c40d61bfce1e96152a22093f2f', '--', path).split()
        if len(entry) != 4 or entry[1] != 'blob' or entry[3] != path:
            raise SystemExit('Missing published readiness baseline blob.')
        git('update-index', '--add', '--cacheinfo', entry[0], entry[2], path, env=env)
    historical = git('write-tree', env=env)
    if historical != 'db307a6fc9768ca6caf9309d980b3e21fdd98051':
        raise SystemExit('The earlier corrective execution tree did not reconstruct.')
    print(json.dumps(dict(status='passed', final_tested_tree=final, historical_tested_tree=historical)))
