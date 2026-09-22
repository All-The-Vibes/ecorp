"""Retrospective exporter/checker parity check with exact source restoration."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, os, subprocess

private = Path(__file__).parent
repo = Path(r'<reviewed-worktree>')
source = repo / 'crates/crony-runner/src/deliverable.rs'
original = source.read_bytes()
start = original.index(b'fn remove_git_tracing(')
end = original.index(b'fn git_error(', start)
mutated = original[:start] + b'fn remove_git_tracing(_command: &mut Command) {}\n\n' + original[end:]
env = os.environ.copy()
env.update(CARGO_TARGET_DIR=str(repo / 'target-validation'), CARGO_BUILD_JOBS='2', RUST_TEST_THREADS='1')
env['PATH'] = r'<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;' + env['PATH']
command = ['cargo', 'test', '--locked', '-p', 'crony-runner', '--bin', 'crony-runner',
           'deliverable::tests::native_export_matches_checker_under_inherited_tracing',
           '--', '--exact', '--nocapture', '--test-threads=1']
sha = lambda data: hashlib.sha256(data).hexdigest()
receipt = private / 'pr324-controlled-export-parity-r3.json'
assert not receipt.exists()
result = {
    'scope': 'Retrospective actual native-export mutation check; not original TDD chronology.',
    'source': 'crates/crony-runner/src/deliverable.rs',
    'original_sha256': sha(original), 'mutated_sha256': sha(mutated),
    'started_at_utc': datetime.now(timezone.utc).isoformat(), 'runs': [], 'status': 'running',
    'prior_attempts': [{
        'file': f'pr324-controlled-export-parity-r{revision}.json',
        'sha256': sha((private / f'pr324-controlled-export-parity-r{revision}.json').read_bytes()),
        'limitation': limitation,
    } for revision, limitation in [
        (1, 'Incorrect Cargo target selection; not defect regression evidence.'),
        (2, 'Both phases stopped at Windows short-name root validation; not defect RED/GREEN evidence. Original incomplete receipt retained.'),
    ]],
}
def save():
    receipt.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')

def run(phase):
    log = private / f'pr324-export-parity-{phase}-r3.log'
    with log.open('xb') as out:
        completed = subprocess.run(command, cwd=repo, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=2400)
    raw = log.read_bytes()
    result['runs'].append({'phase': phase, 'command': command, 'exit_code': completed.returncode,
                          'log': str(log), 'sha256': sha(raw)})
    save()
    print(phase, 'exit=' + str(completed.returncode), flush=True)
    if phase == 'before':
        assert completed.returncode == 101 and b'checker/exporter tree mismatch' in raw, raw[-4000:]
    else:
        assert completed.returncode == 0 and b'1 passed; 0 failed' in raw, raw[-4000:]
        assert all((name + ': source=').encode() in raw for name in [
            'GIT_TRACE', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_SETUP', 'GIT_TRACE2',
            'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF', 'git_trace', 'GiT_tRaCe2_EvEnT'])

try:
    try:
        source.write_bytes(mutated)
        save()
        run('before')
    finally:
        source.write_bytes(original)
        result['restored_exact_source'] = source.read_bytes() == original
        result['restored_sha256'] = sha(source.read_bytes())
        save()
    run('after')
    result['status'] = 'passed'
except BaseException as exc:
    result['status'] = 'failed'
    result['failure'] = str(exc)
    raise
finally:
    result['finished_at_utc'] = datetime.now(timezone.utc).isoformat()
    save()
