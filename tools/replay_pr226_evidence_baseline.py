"""Replay the retained PR226 baseline from immutable inputs in a new fixture.

This is retrospective failure reproduction, not current-scanner validation or
evidence of the original development sequence. Failed fixtures are preserved.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess


REVISION = 'e2bc71d9f673ec069e6f3b9dc84a13d5e366793d'
SOURCE = 'tools/check_evidence_personal_paths.mjs'
SOURCE_SHA256 = 'e001c5be5eb71d622dd341681d86b95c09ad2e3fe46b3503e406571f78d08272'
TESTS = 'tools/check_evidence_personal_paths.test.mjs'
TESTS_SHA256 = 'caee91c1dfca31da8372eb10c22274f2a57cc17be2bf0833c4c99db83b804427'
PACKETS = {
    'docs/evidence/pr226-integration-20260921': 'ae4087a32bd6f2c8ac537770d8fe24d833149cb7',
    'docs/evidence/pr226-local-validation': 'e618403a740f2452201859892d3ab5da27eb368a',
    'docs/evidence/pr-226-completion-20260922-r3': '9900d51081b6b85210bcfbccd5b0c455bec694ad',
}


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True, type=Path)
    parser.add_argument('--output-directory', required=True, type=Path)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    output = args.output_directory.absolute()
    require(not os.path.lexists(output), 'Preserve existing output; choose a new directory.')

    def git(*arguments):
        return subprocess.check_output(
            ['git', '-C', str(args.repository), *arguments], timeout=60)

    # Read every source from the pinned revision or the recovered exact fixture.
    # No current HEAD, mutable tests or working-tree evidence is copied.
    require(git('rev-parse', '--verify', REVISION + '^{commit}').decode().strip() == REVISION,
            'The immutable baseline revision is unavailable.')
    source = git('show', f'{REVISION}:{SOURCE}')
    require(sha(source) == SOURCE_SHA256, 'Pinned baseline source hash differs.')
    tests_path = Path(__file__).parent / 'fixtures/pr226-evidence-baseline/check_evidence_personal_paths.test.mjs'
    tests = tests_path.read_bytes()
    require(sha(tests) == TESTS_SHA256, 'Recovered baseline tests hash differs.')
    for name, expected in PACKETS.items():
        require(git('rev-parse', f'{REVISION}:{name}').decode().strip() == expected,
                'Pinned baseline evidence tree differs.')

    records = git('ls-tree', '-r', '-l', '-z', REVISION, '--', *PACKETS).split(b'\0')
    inputs = {SOURCE: source, TESTS: tests}
    admitted = []
    total = len(source) + len(tests)
    for record in filter(None, records):
        metadata, encoded_name = record.split(b'\t', 1)
        mode, kind, oid, size = metadata.split()
        name = encoded_name.decode('utf-8')
        path = PurePosixPath(name)
        require(mode == b'100644' and kind == b'blob' and name == path.as_posix()
                and not path.is_absolute() and '..' not in path.parts
                and not re.search(r'[\\:\x00-\x1f]', name)
                and any(name.startswith(packet + '/') for packet in PACKETS),
                'Unsupported baseline evidence entry.')
        size = int(size)
        total += size
        require(size <= 32 * 1024 * 1024 and total <= 128 * 1024 * 1024
                and len(admitted) < 2048, 'Baseline evidence exceeds replay bounds.')
        require(name not in inputs and all(name != row[0] for row in admitted),
                'Duplicate baseline input.')
        admitted.append((name, oid.decode('ascii'), size))
    require(all(any(name.startswith(packet + '/') for name, _, _ in admitted)
                for packet in PACKETS), 'A baseline evidence packet is empty.')
    for name, oid, size in admitted:
        raw = git('cat-file', 'blob', oid)
        require(len(raw) == size, 'Baseline blob size differs.')
        inputs[name] = raw

    environment = dict(os.environ)
    environment.pop('NODE_OPTIONS', None)
    environment.pop('NODE_TEST_CONTEXT', None)
    selected_node = subprocess.check_output(
        [args.node, '-p', 'process.platform + " " + process.version'],
        env=environment, timeout=30).decode().strip()
    require(selected_node == 'win32 v24.21.0',
            'This historical baseline requires Windows and Node v24.21.0.')

    # Admission is complete before allocating any fixture or result file.
    output.mkdir(parents=True, exist_ok=False)
    fixture = output / 'fixture'
    for name, raw in inputs.items():
        target = fixture / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        require(target.read_bytes() == raw, 'Materialized baseline input differs.')
    log = output / 'baseline.log'
    command = [args.node, '--test', '--test-reporter=tap', TESTS]
    with log.open('xb') as stream:
        result = subprocess.run(command, cwd=fixture, env=environment,
                                stdout=stream, stderr=subprocess.STDOUT, timeout=120)
    raw_log = log.read_bytes()
    text = raw_log.decode('utf-8')
    expected = {'tests': 16, 'pass': 8, 'fail': 8, 'cancelled': 0, 'skipped': 0, 'todo': 0}
    observed = {name: re.findall(rf'(?m)^# {name} ([0-9]+)\r?$', text)
                for name in expected}
    reproduced = result.returncode == 1 and all(
        observed[name] == [str(count)] for name, count in expected.items())
    receipt = {
        'recorded_at_utc': datetime.now(timezone.utc).isoformat(),
        'status': 'baseline_reproduced' if reproduced else 'unexpected_result',
        'revision': REVISION, 'source_sha256': SOURCE_SHA256,
        'tests_sha256': TESTS_SHA256, 'evidence_trees': PACKETS,
        'inputs': [{'path': name, 'sha256': sha(raw), 'bytes': len(raw)}
                   for name, raw in inputs.items()],
        'node': selected_node, 'command': command, 'test_exit_code': result.returncode,
        'log': log.name, 'log_sha256': sha(raw_log),
        'expected_summary': expected, 'observed_summary': observed,
        'scope': 'Retrospective immutable baseline; eight failures are expected. '
                 'This is not a passing current-scanner suite or original TDD chronology.',
    }
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: receipt[key] for key in
                      ('status', 'revision', 'source_sha256', 'tests_sha256',
                       'test_exit_code', 'log_sha256', 'expected_summary')}))
    require(reproduced, 'Baseline outcome differs; preserve the fixture and logs.')


if __name__ == '__main__':
    main()
