from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

base = Path(__file__).resolve().parent
repo = Path(r'<reviewed-worktree>')
mode = sys.argv[1]
assert mode in ('red', 'green')
log = base / f'pr237-admission-{mode}-r1.log'
receipt = base / f'pr237-admission-{mode}-r1.json'
assert not log.exists() and not receipt.exists()
git = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args]).decode().strip()
before = git('write-tree')
command = [r'<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe',
           '--test', '--test-reporter=spec', '--test-concurrency=1', 'tools/factory_budget_start.test.mjs']
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
with log.open('wb') as output:
    result = subprocess.run(command, cwd=repo, stdout=output, stderr=subprocess.STDOUT)
record = dict(mode=mode, command=command, head=git('rev-parse', 'HEAD'), staged_tree=before,
              source_unchanged=before == git('write-tree') and not git('diff', '--name-only'),
              exit_code=result.returncode, started_at_utc=started,
              finished_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              log=str(log), sha256=hashlib.sha256(log.read_bytes()).hexdigest())
receipt.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
print(json.dumps(record))
print(log.read_text(encoding='utf-8', errors='replace')[-11000:])
sys.exit(0 if mode == 'red' and result.returncode != 0 else result.returncode)
