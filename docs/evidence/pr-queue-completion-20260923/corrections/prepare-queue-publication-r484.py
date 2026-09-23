"""Prepare publication helpers that preserve the native execution tree explicitly."""
import ast
import hashlib
import json
from pathlib import Path

private = Path(__file__).resolve().parent
binding = private / 'queue-publication-helpers-r484.json'
if binding.exists():
    raise SystemExit('Preserve previous publication preparation.')
generated = []

def replace(text, old, new, count=1):
    if text.count(old) != count:
        raise SystemExit('Unexpected preparation boundary: ' + old[:100])
    return text.replace(old, new)

def source(name):
    return (private / name).read_text(encoding='utf-8-sig')

def save(original, name, text):
    path = private / name
    if path.exists():
        raise SystemExit('Preserve prepared helper: ' + name)
    if path.suffix == '.py':
        ast.parse(text)
    path.write_text(text, encoding='utf-8', newline='\n')
    generated.append({'original': original, 'original_sha256': digest(private / original),
                      'file': name, 'sha256': digest(path)})

digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assertion = source('assert-queue-validation-r422.py')
assertion = replace(assertion,
    "require(native['status'] == 'passed' and native['tested_staged_tree'] == tree, 'Matching native acceptance required.')",
    """native_tree = native['tested_staged_tree']
require(native['status'] == 'passed' and native['validation_source_tree'] == tree, 'Matching final validation source required.')
equivalence = json.loads((root / 'native-source-equivalence.json').read_text(encoding='utf-8'))
require(equivalence['status'] == 'verified-scope-equivalence'
        and equivalence['native_execution_tree'] == native_tree
        and equivalence['validation_source_tree'] == tree, 'Explicit native source equivalence required.')
allowed = sorted(['.github/workflows/ci.yml', 'tools/qa_multiplayer_object_sources.test.mjs',
                  'tools/qa_multiplayer_object_sources.test.ps1', 'tools/qa_multiplayer_preflight.ps1',
                  'tools/qa_multiplayer_preflight.test.ps1'])
require(sorted(item['file'] for item in equivalence['changed_paths']) == allowed
        and equivalence['outside_changed_paths'] == [], 'Unexpected native equivalence scope.')
require(git('diff', '--name-only', native_tree, tree).splitlines() == allowed, 'Native source equivalence no longer holds.')
for item in equivalence['changed_paths']:
    for revision, key in [(native_tree, 'before_sha256'), (tree, 'after_sha256')]:
        raw = subprocess.check_output(['git', '-C', str(repo), 'show', revision + ':' + item['file']])
        require(hashlib.sha256(raw).hexdigest() == item[key], 'A reviewed equivalence blob differs.')
for suite in native['suites']:
    native_receipt = json.loads((root / suite['receipt']['file']).read_text(encoding='utf-8'))
    require(native_receipt['status'] == 'passed'
            and native_receipt.get('tested_staged_tree', native_receipt.get('staged_tree')) == native_tree
            and suite['tested_staged_tree'] == native_tree, 'A native receipt lost its original source binding.')""")
save('assert-queue-validation-r422.py', 'assert-queue-validation-r484.py', assertion)

package = source('package-queue-validation-r423.py')
package = replace(package, "parser.add_argument('--native-selection', required=True, type=Path)",
                  "parser.add_argument('--native-selection', required=True, type=Path)\nparser.add_argument('--source-equivalence', required=True, type=Path)")
package = replace(package, 'queue-integration-r436.json', 'queue-integration-r483.json')
package = replace(package, "selection = read(args.native_selection)", """selection = read(args.native_selection)
equivalence = read(args.source_equivalence)
native_tree = selection['tested_staged_tree']
if selection['status'] != 'selected-observed-passing-evidence' or equivalence['status'] != 'verified-scope-equivalence':
    raise SystemExit('Observed native selection and explicit scope equivalence required.')
if equivalence['native_execution_tree'] != native_tree or equivalence['validation_source_tree'] != validation['staged_tree']:
    raise SystemExit('Execution and final validation tree identities differ from the reviewed equivalence.')
if sha(args.native_selection.read_bytes()) != equivalence['native_selection']['sha256']:
    raise SystemExit('Native selection changed after source equivalence review.')
sequence_path = Path(selection['sequence_receipt'])
sequence = read(sequence_path)
if sha(sequence_path.read_bytes()) != selection['sequence_sha256'] or sequence['status'] != 'passed' or sequence['tested_staged_tree'] != native_tree:
    raise SystemExit('Completed native sequence no longer matches the selection.')
allowed = sorted(['.github/workflows/ci.yml', 'tools/qa_multiplayer_object_sources.test.mjs',
                  'tools/qa_multiplayer_object_sources.test.ps1', 'tools/qa_multiplayer_preflight.ps1',
                  'tools/qa_multiplayer_preflight.test.ps1'])
if sorted(item['file'] for item in equivalence['changed_paths']) != allowed or equivalence['outside_changed_paths'] != [] or git('diff', '--name-only', native_tree, validation['staged_tree']).splitlines() != allowed:
    raise SystemExit('Native execution source differs outside the five reviewed standalone paths.')
for item in equivalence['changed_paths']:
    for tree, key in [(native_tree, 'before_sha256'), (validation['staged_tree'], 'after_sha256')]:
        raw = subprocess.check_output(['git', '-C', str(repo), 'show', tree + ':' + item['file']])
        if sha(raw) != item[key]:
            raise SystemExit('A reviewed source equivalence blob changed.')""")
package = replace(package,
    "if receipt['status'] != 'passed' or receipt.get('tested_staged_tree', receipt.get('staged_tree')) != validation['staged_tree']:",
    "if sha(Path(item['receipt']).read_bytes()) != item['receipt_sha256'] or receipt['status'] != 'passed' or receipt.get('tested_staged_tree', receipt.get('staged_tree')) != native_tree:")
package = replace(package, "A native receipt is not passed on the current tested source.",
                  "A native receipt changed or did not pass on its original execution source.")
package = replace(package, "'tested_staged_tree': validation['staged_tree'], 'status': 'passed',",
                  "'tested_staged_tree': validation['staged_tree'], 'native_execution_tree': native_tree,\n    'native_source_equivalence': 'native-source-equivalence.json', 'status': 'passed',")
package = replace(package, "write_json('validation.json', public)",
    """write_json('validation.json', public)
write_json('native-source-equivalence.json', equivalence)
copy_artifact(sequence_path, 'native/sequence-receipt.json', selection['sequence_sha256'])
copy_artifact(private / 'queue-validation-r454/validation.json', 'native/execution-source-validation.json')
copy_artifact(args.native_selection, 'native/selection.json', equivalence['native_selection']['sha256'])""")
package = replace(package,
    "native_public = {'status': 'passed', 'tested_staged_tree': validation['staged_tree'], 'suites': [],",
    "native_public = {'status': 'passed', 'tested_staged_tree': native_tree, 'validation_source_tree': validation['staged_tree'], 'source_equivalence': 'native-source-equivalence.json', 'suites': [],")
package = replace(package, "receipt_artifact = copy_artifact(item['receipt'], prefix + '/receipt.json')",
                  "receipt_artifact = copy_artifact(item['receipt'], prefix + '/receipt.json', item['receipt_sha256'])")
package = replace(package, "suite = {'name': item['name'], 'status': 'passed', 'receipt': receipt_artifact,",
                  "suite = {'name': item['name'], 'status': 'passed', 'tested_staged_tree': native_tree, 'receipt': receipt_artifact,")
package = replace(package,
    "`native-acceptance.json` binds five successful owned native suites:",
    "`native-acceptance.json` retains the original execution tree `{native_tree}` for five successful owned native suites:")
package = replace(package,
    "Original native receipts, step logs and selected browser artifacts are retained under `native/`.",
    "Original native receipts, step logs and selected browser artifacts are retained under `native/`. These suites executed before the final five-file PR319 preflight/test/CI update. `native-source-equivalence.json` proves every other tracked entry is identical to the final validation tree, with exact before/after blob hashes for all five reviewed paths. Application code, dependencies and native drivers are unchanged; the final full validation and focused native preflight checks cover the changed standalone paths. Original execution receipts are not relabeled as fresh runs on the final tree.")
package = replace(package,
    "Use the current supported #354/#355 replay scripts and the source-bound receipt for the respective native suites.",
    "Use `native/factory-readiness/run-pr354-native-first-run-r477.ps1` for Factory replay with explicit owned fixture paths and a source-bound validation receipt. It checks the current sixteen named Factory SQLx cases; the retained historical replay expected nine. The existing #355 replay remains the deliverable driver. Failed earlier native attempts and private driver corrections are retained under `corrections/`.")
package = replace(package,
    "tree=validation['staged_tree'])",
    "tree=validation['staged_tree'], native_tree=native_tree)")
package = replace(package, 'assert-queue-validation-r422.py', 'assert-queue-validation-r484.py')
save('package-queue-validation-r423.py', 'package-queue-validation-r484.py', package)

description = source('prepare-queue-description-r429.py')
description = replace(description, 'Five fresh owned native suites pass:',
    "Five owned native suites pass on execution tree {native_tree}:")
description = replace(description,
    "- Local Anvil, deterministic providers, development actors and synthetic Keycloak are fixture coverage.",
    "- Native receipts retain their original execution tree. The final five-file PR319 change disables Git hooks, preserves the no-follow object-store checks, adds eleven object-alias regressions and enrolls the 25-case suite in required Windows CI. Exact Git tree and blob comparisons prove all runtime code, dependencies and native drivers are unchanged. Fresh focused native preflight checks and the final full validation cover those changed paths.\n- Local Anvil, deterministic providers, development actors and synthetic Keycloak are fixture coverage.")
description = replace(description, "tree=v['tested_staged_tree'], packet=packet,",
                      "tree=v['tested_staged_tree'], native_tree=native['tested_staged_tree'], packet=packet,")
description = replace(description, 'queue-pull-request-body-r429.md', 'queue-pull-request-body-r484.md')
save('prepare-queue-description-r429.py', 'prepare-queue-description-r484.py', description)

commit = source('commit-queue-r426.py')
commit = replace(commit, 'queue-commit-r426.json', 'queue-commit-r484.json')
commit = replace(commit, 'queue-integration-r436.json', 'queue-integration-r483.json')
commit = replace(commit, 'assert-queue-validation-r422.py', 'assert-queue-validation-r484.py', count=2)
commit = replace(commit, 'validation gates and five fresh native acceptance suites.',
                 'validation gates and five native suites with explicit source equivalence.')
save('commit-queue-r426.py', 'commit-queue-r484.py', commit)

for old, new in [
    ('publish-queue-r427.ps1', 'publish-queue-r484.ps1'),
    ('resolve-queue-feedback-r430.ps1', 'resolve-queue-feedback-r484.ps1'),
    ('merge-queue-r428.ps1', 'merge-queue-r484.ps1'),
    ('verify-queue-completion-r447.ps1', 'verify-queue-completion-r484.ps1')]:
    text = source(old)
    text = replace(text, 'queue-publication-r427.json', 'queue-publication-r484.json')
    text = replace(text, 'queue-integration-r436.json', 'queue-integration-r483.json')
    if 'assert-queue-validation-r422.py' in text:
        text = replace(text, 'assert-queue-validation-r422.py', 'assert-queue-validation-r484.py')
    if old == 'resolve-queue-feedback-r430.ps1':
        text = replace(text, "='r430'", "='r484'")
        text = replace(text, 'pr-feedback-queue-r437.json', 'pr-feedback-queue-r483.json')
        needle = " @{pr=319;id='PRRT_kwDOUIQ-ns6lKTd3';detail='The multiplayer preflight rejects reparse points throughout the common Git object database before its first Git invocation, including pack and loose-object fan-out paths. The native junction regressions are included in the full validation lane.'},"
        text = replace(text, needle, needle + "\n @{pr=319;id='PRRT_kwDOUIQ-ns6lRXWp';detail='The required Windows runner-platforms CI job explicitly executes tools/qa_multiplayer_object_sources.test.ps1 with 8.3 alias coverage required. All 25 native object-alias cases and the hook positive-control/suppression fixtures passed locally; the final full Node lane includes the object-source wrapper.'},")
        text = replace(text, 'All 11 local gates and five native acceptance suites pass on the recorded source tree.',
                       'All 11 local gates pass on the final validation tree. Five native suites retain their original execution tree, with the five-file standalone PR319 delta and runtime source equivalence documented in native-source-equivalence.json.')
    save(old, new, text)

binding.write_text(json.dumps({'status': 'prepared-not-executed', 'inputs': 'queue-integration-r483.json',
    'feedback': 'pr-feedback-queue-r483.json', 'validation': 'queue-validation-r479',
    'native_selection': 'queue-native-selection-r481.json', 'equivalence': 'queue-native-source-equivalence-r483.json',
    'helpers': generated,
    'scope': 'Preserve native execution tree identities, verify the exact five-file standalone delta, bind final full validation separately, retain original ancestry and failures, and resolve the reviewed new PR319 CI enrollment feedback. Preparation does not package, commit, push, merge or alter policy.'},
    indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': 'prepared-not-executed', 'helpers': len(generated), 'binding': str(binding)}))
