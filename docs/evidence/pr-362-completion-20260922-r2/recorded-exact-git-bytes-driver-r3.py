"""Run the verifier regressions against exact committed Git blobs in a new owned fixture."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, os, subprocess, sys

base = Path(__file__).parent
repo = Path(r'<reviewed-worktree>')
head = '8c3e718563be568221b16d2ac8dfc9cb5ca74486'
fixture = base / 'pr362-exact-git-bytes-r3'
receipt_path = base / 'pr362-exact-git-bytes-r3.json'
assert not fixture.exists() and not receipt_path.exists()
assert subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip() == head
prefixes = ['tools/test_public_evidence_verifier.py'] + [
    'docs/evidence/' + name for name in (
        'pr362-startup-20260921','pr362-regressions-20260921','pr362-combined-20260921')]
names = subprocess.check_output(['git','-C',str(repo),'ls-tree','-r','--name-only',head,'--',*prefixes],text=True).splitlines()
assert names and prefixes[0] in names
fixture.mkdir()
sha = lambda data: hashlib.sha256(data).hexdigest()
receipt = {'pr':362,'source_head':head,'started_at_utc':datetime.now(timezone.utc).isoformat(),
    'status':'running','scope':'Six verifier regressions on exact committed bytes; no native stack rerun.',
    'fixture':str(fixture),'files':[]}
for name in names:
    target = fixture / name
    assert target.resolve().is_relative_to(fixture.resolve())
    raw = subprocess.check_output(['git','-C',str(repo),'show',f'{head}:{name}'])
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(raw)
    assert target.read_bytes() == raw
    receipt['files'].append({'path':name,'git_blob_sha256':sha(raw),'executed_sha256':sha(target.read_bytes())})
manifest = 'docs/evidence/pr362-combined-20260921/manifest.json'
old = (repo/manifest).read_bytes()
exact = (fixture/manifest).read_bytes()
receipt['prior_manifest']={'worktree_sha256':sha(old),'git_blob_sha256':sha(exact),
    'crlf_to_lf_is_exact':old.replace(b'\r\n',b'\n')==exact,'crlf_count':old.count(b'\r\n')}
assert receipt['prior_manifest']['crlf_to_lf_is_exact']
environment = dict(os.environ)
environment.pop('PYTHONOPTIMIZE',None)
environment['PYTHONDONTWRITEBYTECODE']='1'
command = [sys.executable,'-X','utf8','-m','unittest','discover','-s','tools','-p','test_public_evidence_verifier.py','-v']
log = base/'pr362-exact-git-bytes-r3.log'
assert not log.exists()
with log.open('wb') as output:
    result = subprocess.run(command,cwd=fixture,env=environment,stdout=output,stderr=subprocess.STDOUT,timeout=180)
receipt['command']=command
receipt['log']={'file':str(log),'sha256':sha(log.read_bytes()),'exit_code':result.returncode}
receipt['finished_at_utc']=datetime.now(timezone.utc).isoformat()
receipt['status']='passed' if result.returncode==0 else 'failed'
receipt['source_unchanged']=all(sha((fixture/f['path']).read_bytes())==f['executed_sha256'] for f in receipt['files'])
assert receipt['source_unchanged']
receipt_path.write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':receipt['status'],'files':len(names),'receipt':str(receipt_path),'log':str(log)}))
sys.exit(result.returncode)
