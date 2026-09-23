import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone

private = Path(__file__).parent
repo = private.parents[3] / 'ecorp-pr362-completion-20260922'
fixture = private / 'pr362-controlled-verifier-fixture-r4'
receipt_path = private / 'pr362-controlled-verifier-r4.json'
assert not fixture.exists() and not receipt_path.exists()
fixture.mkdir()
(fixture / 'tools').mkdir()
test = 'tools/test_public_evidence_verifier.py'
shutil.copyfile(repo / test, fixture / test)
packets = ['pr362-startup-20260921', 'pr362-regressions-20260921', 'pr362-combined-20260921']
for name in packets:
    shutil.copytree(repo / 'docs/evidence' / name, fixture / 'docs/evidence' / name)
target = fixture / 'docs/evidence/pr362-combined-20260921'
original = private / 'pr362-verifier-original-r2'
sha = lambda data: hashlib.sha256(data).hexdigest()
paths = [test, '.github/workflows/ci.yml', 'docs/evidence/pr362-combined-20260921/verify_public.py', 'docs/evidence/pr362-combined-20260921/manifest.json']
record = {'started_at_utc': datetime.now(timezone.utc).isoformat(), 'status': 'running', 'description': 'Retrospective real subprocess regression using owned copies of all three complete evidence packets and the exact final test module; no product source was modified.', 'head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(), 'staged_tree': subprocess.check_output(['git','write-tree'],cwd=repo,text=True).strip(), 'python': subprocess.check_output(['python','--version'],text=True).strip(), 'source': {p: {'executed_sha256': sha((repo/p).read_bytes()), 'git_blob_sha256': sha(subprocess.check_output(['git','show', ':'+p],cwd=repo))} for p in paths}, 'runs': []}
env = dict(os.environ)
env.pop('PYTHONOPTIMIZE', None)
env['PYTHONDONTWRITEBYTECODE'] = '1'
command = ['python', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tools', '-p', 'test_public_evidence_verifier.py']
for phase, directory, expected in [('before', original, 1), ('after', repo/'docs/evidence/pr362-combined-20260921', 0)]:
    for name in ['verify_public.py', 'manifest.json']:
        shutil.copyfile(directory/name, target/name)
    log = private/f'pr362-verifier-{phase}-r4.log'
    with log.open('xb') as output:
        result = subprocess.run(command,cwd=fixture,env=env,stdout=output,stderr=subprocess.STDOUT,timeout=180)
    data = log.read_bytes()
    record['runs'].append({'phase':phase,'command':command,'working_directory':str(fixture),'exit_code':result.returncode,'log':str(log),'log_sha256':sha(data),'verifier_sha256':sha((target/'verify_public.py').read_bytes()),'manifest_sha256':sha((target/'manifest.json').read_bytes())})
    receipt_path.write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
    assert result.returncode == expected, data[-2000:]
    assert b'Ran 6 tests' in data
    assert (b'FAILED (failures=4)' in data) if phase == 'before' else data.rstrip().endswith(b'OK')
    print(f'{phase} exit={result.returncode}',flush=True)
assert all(sha((repo/p).read_bytes()) == record['source'][p]['executed_sha256'] for p in paths)
record['status'] = 'passed'
record['finished_at_utc'] = datetime.now(timezone.utc).isoformat()
receipt_path.write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
