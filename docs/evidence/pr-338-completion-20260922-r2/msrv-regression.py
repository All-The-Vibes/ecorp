"""Current-source, retrospective MSRV diagnostic and behavior checks."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone

private = Path(__file__).parent
repo = Path(r'<reviewed-worktree>')
source = repo / 'crates/crony-store/src/retained_provider_receipt.rs'
report = private / 'pr338-msrv-regression-r2.json'
assert not report.exists()
original = source.read_bytes()
new = b'binding.as_object().is_none_or(|object| object.len() != 2)'
old = b'!binding.as_object().is_some_and(|object| object.len() == 2)'
assert original.count(new) == 1 and old not in original
baseline = original.replace(new, old)
sha = lambda b: hashlib.sha256(b).hexdigest()
env = os.environ.copy()
env.update(CARGO_TARGET_DIR=str(repo / 'target-validation'), CARGO_BUILD_JOBS='2', RUST_TEST_THREADS='1')
record = {'status': 'running', 'started_at_utc': datetime.now(timezone.utc).isoformat(), 'head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(), 'staged_tree': subprocess.check_output(['git','write-tree'],cwd=repo,text=True).strip(), 'description': 'Retrospective Rust 1.94 strict-Clippy RED/GREEN, with unchanged behavior tests passing on both predicates. Not a reconstruction of original development chronology.', 'toolchain': subprocess.check_output(['rustc','+1.94.0','--version'],text=True).strip(), 'original_source_sha256': sha(original), 'baseline_source_sha256': sha(baseline), 'runs': []}
def save():
    report.write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
def run(name, args, expected, marker):
    log=private/f'pr338-{name}-r2.log'
    assert not log.exists()
    with log.open('xb') as output:
        result=subprocess.run(args,cwd=repo,env=env,stdout=output,stderr=subprocess.STDOUT,timeout=3600)
    data=log.read_bytes()
    record['runs'].append({'name':name,'command':args,'source_sha256':sha(source.read_bytes()),'exit_code':result.returncode,'log':str(log),'sha256':sha(data)})
    save()
    assert result.returncode==expected and marker in data, data[-4000:]
    print(f'{name} exit={result.returncode}',flush=True)
clippy=['cargo','+1.94.0','clippy','--locked','--workspace','--all-targets','--','-D','warnings']
focused=['cargo','+1.94.0','test','--locked','-p','crony-store','retained_provider_receipt']
try:
    source.write_bytes(baseline)
    save()
    run('msrv-clippy-before',clippy,101,b'clippy::nonminimal_bool')
    run('msrv-behavior-before',focused,0,b'5 passed; 0 failed')
finally:
    source.write_bytes(original)
    assert source.read_bytes()==original
    record['restored_sha256']=sha(source.read_bytes())
    save()
run('msrv-clippy-after',clippy,0,b'Finished')
run('msrv-behavior-after',focused,0,b'5 passed; 0 failed')
assert not subprocess.check_output(['git','diff','--name-only'],cwd=repo,text=True).strip()
record['status']='passed'
record['finished_at_utc']=datetime.now(timezone.utc).isoformat()
save()
