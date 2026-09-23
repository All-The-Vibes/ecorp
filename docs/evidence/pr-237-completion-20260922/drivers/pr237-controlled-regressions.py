import hashlib
import json
import os
from pathlib import Path
import subprocess

private=Path(__file__).parent
repo=Path(r'<reviewed-worktree>')
node=Path(r'<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe')
files=['tools/owned_test_stack.mjs','tools/ci_external_adapters_windows.ps1']
saved={name:(repo/name).read_bytes() for name in files}
receipt={'kind':'controlled pre-fix regression replay, not original author TDD history','checks':[]}
env=os.environ.copy()
env['ECORP_OWNED_PROCESS_TEST']='1'
env['PATH']=str(node.parent)+os.pathsep+env['PATH']
head=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
receipt['baseline_head']=head
try:
    for name in files:
        backup=private/('pr237-corrected-'+Path(name).name)
        if backup.exists(): raise RuntimeError('Preserve prior corrected-source backup')
        backup.write_bytes(saved[name])
        original=subprocess.check_output(['git','-C',str(repo),'show',f'{head}:{name}'])
        (repo/name).write_bytes(original)
    for name,pattern,test_file in [
        ('owned-launch','native start retains diagnostics and stops its child after identity failure','tools/owned_test_stack.test.mjs'),
        ('command-timeout','Windows bounded fixture command retains both streams','tools/ci_external_adapters_windows.test.mjs'),
    ]:
        log=private/f'pr237-{name}-before-r1.log'
        with log.open('xb') as output:
            result=subprocess.run([str(node),'--test','--test-name-pattern',pattern,test_file],cwd=repo,env=env,stdout=output,stderr=subprocess.STDOUT,timeout=140)
        receipt['checks'].append({'name':name,'exit_code':result.returncode,'expected_result':'failed before correction','log':str(log),'sha256':hashlib.sha256(log.read_bytes()).hexdigest()})
        if result.returncode==0: raise RuntimeError('Regression did not detect the original issue')
finally:
    for name,data in saved.items(): (repo/name).write_bytes(data)
    receipt['corrected_source_restored']=all((repo/name).read_bytes()==data for name,data in saved.items())
    (private/'pr237-controlled-regressions-r1.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
