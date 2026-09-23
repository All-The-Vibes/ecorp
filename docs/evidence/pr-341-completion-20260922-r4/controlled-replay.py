import hashlib, json, os, subprocess
from datetime import datetime, timezone
from pathlib import Path

private = Path(__file__).parent
repo = Path(r'<reviewed-worktree>')
workflow = repo / '.github/workflows/security-scan.yml'
corrected = workflow.read_bytes()
previous = (private / 'pr341-workflow-before-r2.yml').read_bytes()
env = os.environ.copy()
node = r'<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe'
env['ECORP_GITLEAKS_BINARY'] = str(private / 'gitleaks-8.30.1/gitleaks.exe')
digest = lambda value: hashlib.sha256(value).hexdigest()
receipt = {'scope':'Retrospective replay of the preserved previous workflow with newly added regressions, then the corrected workflow. Not an original development chronology.',
           'started_at_utc': datetime.now(timezone.utc).isoformat(), 'runs':[]}
for relative in ['tools/secret_scan.test.mjs', 'tools/secret_scan_native.test.mjs']:
    receipt[relative + '_sha256'] = digest((repo / relative).read_bytes())
try:
    for label, contents, arguments in [
        ('native-before-r4', previous, ['--test', '--test-name-pattern=sensitive filename|partial timeout', 'tools/secret_scan_native.test.mjs']),
        ('all-after-r4', corrected, ['--test', 'tools/secret_scan.test.mjs', 'tools/secret_scan_native.test.mjs']),
    ]:
        workflow.write_bytes(contents)
        log = private / f'pr341-{label}.log'
        with log.open('xb') as output:
            run = subprocess.run([node, *arguments], cwd=repo, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=100)
        receipt['runs'].append({'label':label,'arguments':[node, *arguments], 'workflow_sha256':digest(contents),
                               'exit_code':run.returncode,'log':str(log),'log_sha256':digest(log.read_bytes())})
        print(label, 'exit', run.returncode, flush=True)
finally:
    workflow.write_bytes(corrected)
    receipt['corrected_workflow_restored'] = workflow.read_bytes() == corrected
    receipt['finished_at_utc'] = datetime.now(timezone.utc).isoformat()
    (private / 'pr341-controlled-regressions-r2.json').write_text(json.dumps(receipt, indent=2)+'\n',encoding='utf-8')
assert receipt['runs'][0]['exit_code'] != 0 and receipt['runs'][1]['exit_code'] == 0
