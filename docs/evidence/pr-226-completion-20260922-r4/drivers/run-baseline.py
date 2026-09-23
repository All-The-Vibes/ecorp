"""Run the current scanner regressions against a preserved original-source fixture."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone

base = Path(__file__).parent
repo = Path(r'<reviewed-worktree>')
fixture = base / 'pr226-evidence-read-baseline-r2'
fixture.mkdir(exist_ok=False)
(fixture/'tools').mkdir()
source = subprocess.check_output(['git', '-C', str(repo), 'show', 'HEAD:tools/check_evidence_personal_paths.mjs'])
tests = (repo/'tools/check_evidence_personal_paths.test.mjs').read_bytes()
(fixture/'tools/check_evidence_personal_paths.mjs').write_bytes(source)
(fixture/'tools/check_evidence_personal_paths.test.mjs').write_bytes(tests)
for packet in ('pr226-integration-20260921', 'pr226-local-validation', 'pr-226-completion-20260922-r3'):
    shutil.copytree(repo/'docs/evidence'/packet, fixture/'docs/evidence'/packet)
node = r'<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe'
command = [node, '--test', 'tools/check_evidence_personal_paths.test.mjs']
log = base/'pr226-evidence-read-baseline-r2.log'
with log.open('xb') as output:
    result = subprocess.run(command, cwd=fixture, stdout=output, stderr=subprocess.STDOUT, timeout=120)
receipt = {'at_utc': datetime.now(timezone.utc).isoformat(), 'fixture': str(fixture),
           'source_head': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD']).decode().strip(),
           'source_sha256': hashlib.sha256(source).hexdigest(), 'tests_sha256': hashlib.sha256(tests).hexdigest(),
           'command': command, 'exit_code': result.returncode, 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest(),
           'scope': 'Retrospective controlled baseline with current regression tests; no original TDD chronology claimed.'}
(fixture/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps(receipt))
