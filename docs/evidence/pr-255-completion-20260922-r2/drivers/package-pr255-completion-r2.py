"""Retain #255's coverage correction and unchanged native acceptance."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

if not __debug__:
    raise SystemExit('Run evidence packaging without Python optimization.')
root = Path(__file__).parent
repo = Path(r'C:\Users\shyamsridhar\code\ecorp-pr255-completion-20260922')
name = 'pr-255-completion-20260922-r2'
prior_name = 'pr-255-completion-20260922-r1'
out = repo / 'docs/evidence' / name
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
sha = lambda b: hashlib.sha256(b).hexdigest()
git = lambda *a: subprocess.check_output(['git', '-C', str(repo), *a]).decode().strip()
gates = read(root / 'pr255-validation-r2/validation.json')
native = read(root / 'pr255-native-r4-lifecycle.json')
coverage_root = repo / 'output/coverage/web-models-pr255-r1'
coverage = read(coverage_root / 'summary.json')
run = read(coverage_root / 'run.json')
assert gates['status'] == native['status'] == 'passed'
assert gates['staged_tree'] == git('write-tree')
assert gates['head'] == git('rev-parse', 'HEAD') == '7f1db19f215bf1fbfafe1899014efddd33de3206'
assert coverage['ok'] and coverage['sourceStable'] and coverage['exitCode'] == 0
assert run['ok'] and run['sourceStable'] and coverage['files'] == 19
assert coverage['thresholds'] == {'lines': 99, 'functions': 95, 'branches': 97}
assert run['before']['files'] == run['after']['files']
for item in run['after']['files']:
    assert sha((repo / item['file']).read_bytes()) == item['sha256'], item['file']
change = git('diff', '--name-only', native['tested_staged_tree'], gates['staged_tree'],
             '--', '.', f':(exclude)docs/evidence/{prior_name}/**').splitlines()
assert change == ['tools/coverage_web_models.mjs'], change
assert git('diff', '--name-only', gates['head'], gates['staged_tree']).splitlines() == change
subprocess.run([sys.executable, str(root / 'package-validation.py'), '255', str(repo),
    '--validation-directory', str(root / 'pr255-validation-r2'), '--packet-name', name,
    '--scope', 'Nine contributor gates and the explicit web-model coverage lane pass. The only change from the previously reviewed implementation is adding factoryAuthority.ts to the measured denominator; all native/browser application source and earlier acceptance evidence remain unchanged.',
    '--fixes', 'Correct the hosted Web model coverage failure by classifying the authority model as measured production code. Keep all line/function/branch thresholds and prior native acceptance intact.'], check=True)
files = []
def retain(source, relative, exact=False):
    raw = Path(source).read_bytes()
    public = raw
    if not exact:
        text = raw.decode('utf-8-sig')
        for value, label in [(str(repo), '<reviewed-worktree>'), (str(root), '<private-evidence>'), (str(Path.home()), '<local-user>')]:
            for spelling in sorted({value, value.replace('\\', '/'), value.replace('\\', '\\\\')}, key=len, reverse=True):
                text = text.replace(spelling, label)
        public = ('\n'.join(line.rstrip() for line in text.splitlines()).rstrip('\n') + '\n').encode()
    target = out / relative
    assert not target.exists(), relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(public)
    files.append({'file': relative, 'original_sha256': sha(raw), 'published_sha256': sha(public), 'exact_bytes': exact})
for leaf in ['summary.json', 'run.json', 'tests.log']:
    retain(coverage_root / leaf, 'coverage/' + leaf)
for leaf in ['pr255-hosted-checks-r71.json', 'pr255-hosted-web-job-r71.json', 'pr255-hosted-web-annotations-r71.json']:
    retain(root / leaf, 'hosted-failure/' + leaf)
retain(Path(__file__), 'drivers/package-pr255-completion-r2.py', exact=True)
binding = {
    'tested_staged_tree': gates['staged_tree'],
    'prior_published_head': gates['head'],
    'native_tested_tree': native['tested_staged_tree'],
    'native_receipt': f'../{prior_name}/native-lifecycle.json',
    'native_raw_receipt_sha256': sha((root / 'pr255-native-r4-lifecycle.json').read_bytes()),
    'changed_paths_from_native_tree_excluding_named_prior_packet': change,
    'coverage_input_manifest_sha256': run['after']['sourceManifestSha256'],
    'all_coverage_input_hashes_verified_against_current_worktree': True,
    'prior_packet_unchanged': git('diff', '--name-only', gates['head'], gates['staged_tree'], '--', f'docs/evidence/{prior_name}') == '',
    'files': files,
}
(out / 'source-binding.json').write_text(json.dumps(binding, indent=2) + '\n', encoding='utf-8')
with (out / 'README.md').open('a', encoding='utf-8') as stream:
    stream.write(f'''
## Hosted coverage correction

Hosted job 106984498747 in workflow run 35798906572 rejected the changed TypeScript source set before executing model coverage. The authority model was missing from the explicit model list. The one-line correction includes factoryAuthority.ts in measurement; it does not add an exclusion or lower a threshold.

The focused coverage run measured 19 production models using 26 test files: lines 99.64%, functions 97.06%, branches 97.21%. Required thresholds remain 99%, 95%, 97%. Its complete input hashes, before/after stability record, command results and summary are under coverage/. Every input hash was checked against the candidate before packaging.

## Retained native scope

The prior packet ../{prior_name}/ remains byte-for-byte unchanged. Comparing its native-tested tree {native['tested_staged_tree']} to the current gate tree, while excluding only that named evidence packet, finds exactly tools/coverage_web_models.mjs. No server, runner, protocol, store, migration, application UI, native fixture or browser driver changed. Its six store/four server SQLx cases, two APIs/two runners, independent-ledger rejection, controller race, reconnect/rotation/handoff and actual browser mission/artifact hashes remain credited to their original source. No new native run is claimed for this instrumentation-only correction.

Local gates and coverage used Node 24.21.0; the repository pin is 24.19.0. Hosted checks still validate the pin. Issue 161 remains partial/non-closing with the same development-identity, same-host and deterministic-provider limits. Migration 0042 and the downstream unmerged #283 allocation remain unchanged.
''')
body = (root / 'pr255-body-completion-r1.md').read_text(encoding='utf-8')
body += f'''
## Coverage follow-up

Hosted job 106984498747 exposed a missing explicit coverage classification for factoryAuthority.ts. It is now included in the measured production-model denominator, with thresholds unchanged. All nine contributor gates pass on tree {gates['staged_tree']}. The 19-model/26-test-file coverage lane passes at 99.64% lines, 97.06% functions and 97.21% branches.

docs/evidence/{name}/ retains the failure metadata, coverage input hashes/results, fresh nine-gate logs and source comparison proving that the previous native/browser implementation is unchanged. The original packet, reproduction and scoped acceptance remain intact. Local Node is 24.21.0 versus the repository's 24.19.0 pin.
'''
review = f'Codex-assisted maintainer review of the coverage correction: factoryAuthority.ts now participates in the explicit production-model denominator. The thresholds remain unchanged; the measured 19-model lane and all nine contributor gates pass on tree {gates["staged_tree"]}. The source comparison proves the native/browser implementation and original acceptance packet are unchanged. Evidence: docs/evidence/{name}/. Prior partial issue-161 scope and ordinary independent protected review remain applicable.\n'
for leaf, value in [('pr255-body-completion-r2.md', body), ('pr255-review-completion-r2.md', review)]:
    target = root / leaf
    assert not target.exists()
    target.write_text(value, encoding='utf-8')
print(json.dumps({'packet': str(out), 'tree': gates['staged_tree'], 'coverage': coverage['coverage']}))
