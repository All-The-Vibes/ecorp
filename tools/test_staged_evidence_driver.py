"""Admission regressions for the runnable PR362 staged-evidence driver."""
from pathlib import Path
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

DRIVER = Path(__file__).resolve().with_name('verify_pr362_staged_evidence.py')
FILE_LIMIT = 8 * 1024 * 1024
GATES = (
    ('migrations', 'node', ['tools/check_migrations.mjs']),
    ('documentation', 'pnpm', ['check:docs']),
    ('node-unit', 'pnpm', ['test:unit']),
    ('steward', 'pnpm', ['test:steward']),
    ('rust-format', 'cargo', ['fmt', '--check']),
    ('rust-clippy', 'cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']),
    ('rust-workspace', 'cargo', ['test', '--workspace']),
    ('web-build', 'pnpm', ['build:web']),
    ('web-lint', 'pnpm', ['lint:web']),
)


class StagedEvidenceDriver(unittest.TestCase):
    def invoke(self, *arguments, options=(), optimize=None):
        environment = dict(os.environ)
        environment.pop('PYTHONOPTIMIZE', None)
        environment['PYTHONDONTWRITEBYTECODE'] = '1'
        if optimize is not None:
            environment['PYTHONOPTIMIZE'] = optimize
        return subprocess.run([sys.executable, *options, str(DRIVER), *map(str, arguments)],
                              env=environment, capture_output=True, text=True, timeout=30,
                              check=False)

    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='ecorp-evidence-driver-test-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve(strict=True)
        repo = root / 'source'
        repo.mkdir()
        subprocess.run(['git', '-C', str(repo), 'init', '--quiet'], check=True,
                       capture_output=True, timeout=30)
        source = repo / 'source.txt'
        source.write_bytes(b'validated source\n')
        subprocess.run(['git', '-C', str(repo), 'add', '--', source.name], check=True,
                       capture_output=True, timeout=30)
        tree = subprocess.check_output(['git', '-C', str(repo), 'write-tree'], timeout=30).decode().strip()
        gate_log = root / 'gate.log'
        gate_log.write_bytes(b'fixture gate passed\n')
        validation = root / 'validation.json'
        record = {'status': 'passed', 'source_unchanged': True, 'staged_tree': tree,
                  'checks': [{'name': name, 'program': program, 'arguments': list(arguments),
                              'exit_code': 0, 'log': gate_log.name,
                              'sha256': hashlib.sha256(gate_log.read_bytes()).hexdigest()}
                             for name, program, arguments in GATES]}
        validation.write_text(json.dumps(record), encoding='utf-8')
        return root, repo, validation, record

    def assert_no_receipt(self, result, output, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertNotIn('"status": "passed"', result.stdout)
        self.assertFalse(output.exists(), 'Rejected admission created evidence output.')

    def reject_input(self, repo, validation, output, message):
        result = self.invoke('--repository', repo, '--validation', validation,
                             '--output-directory', output)
        self.assert_no_receipt(result, output, message)

    def directory_link(self, link, target):
        if os.name == 'nt':
            result = subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(link), str(target)],
                                    capture_output=True, text=True, timeout=30, check=False)
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            self.addCleanup(os.rmdir, link)
        else:
            link.symlink_to(target, target_is_directory=True)
            self.addCleanup(link.unlink)

    def test_oversized_validation_is_rejected_before_materialization(self):
        root, repo, validation, _ = self.fixture()
        # Still valid JSON: rejection must be the byte boundary, not parsing.
        with validation.open('ab') as stream:
            stream.write(b' ' * FILE_LIMIT)
        self.reject_input(repo, validation, root / 'evidence', 'evidence file exceeds byte limit')

    def test_oversized_gate_log_is_rejected_even_with_matching_digest(self):
        root, repo, validation, record = self.fixture()
        gate_log = root / 'gate.log'
        gate_log.write_bytes(b'x' * (FILE_LIMIT + 1))
        digest = hashlib.sha256(gate_log.read_bytes()).hexdigest()
        for row in record['checks']:
            row['sha256'] = digest
        validation.write_text(json.dumps(record), encoding='utf-8')
        self.reject_input(repo, validation, root / 'evidence', 'evidence file exceeds byte limit')

    def test_hardlinked_validation_is_rejected_before_materialization(self):
        root, repo, validation, _ = self.fixture()
        os.link(validation, root / 'validation-alias.json')
        self.assertEqual(validation.stat().st_nlink, 2)
        self.reject_input(repo, validation, root / 'evidence', 'hard-linked evidence entry')

    def test_hardlinked_gate_log_is_rejected_even_with_matching_digest(self):
        root, repo, validation, _ = self.fixture()
        os.link(root / 'gate.log', root / 'gate-alias.log')
        self.assertEqual((root / 'gate.log').stat().st_nlink, 2)
        self.reject_input(repo, validation, root / 'evidence', 'hard-linked evidence entry')

    def test_linked_validation_ancestor_is_rejected_before_resolution(self):
        root, repo, validation, _ = self.fixture()
        inputs = root / 'inputs'
        inputs.mkdir()
        validation.rename(inputs / validation.name)
        alias = root / 'input-alias'
        self.directory_link(alias, inputs)
        self.reject_input(repo, alias / validation.name, root / 'evidence', 'linked evidence path')

    def test_linked_gate_log_ancestor_is_rejected_before_resolution(self):
        root, repo, validation, record = self.fixture()
        inputs = root / 'inputs'
        inputs.mkdir()
        (root / 'gate.log').rename(inputs / 'gate.log')
        alias = root / 'input-alias'
        self.directory_link(alias, inputs)
        for row in record['checks']:
            row['log'] = 'input-alias/gate.log'
        validation.write_text(json.dumps(record), encoding='utf-8')
        self.reject_input(repo, validation, root / 'evidence', 'linked evidence path')

    def test_linked_repository_ancestor_is_rejected_before_resolution(self):
        root, repo, validation, _ = self.fixture()
        alias = root / 'source-alias'
        self.directory_link(alias, repo)
        self.reject_input(alias, validation, root / 'evidence', 'linked evidence path')

    def test_oversized_staged_blob_is_rejected_before_materialization(self):
        root, repo, validation, record = self.fixture()
        source = repo / 'tools/test_public_evidence_verifier.py'
        source.parent.mkdir()
        source.write_bytes(b'#' * (FILE_LIMIT + 1))
        report = repo / 'docs/evidence/2026-09-21-pr362-gauntlet-remediation.md'
        report.parent.mkdir(parents=True)
        report.write_bytes(b'Owned source-admission fixture.\n')
        subprocess.run(['git', '-C', str(repo), 'add', '--', str(source), str(report)],
                       check=True, capture_output=True, timeout=30)
        record['staged_tree'] = subprocess.check_output(
            ['git', '-C', str(repo), 'write-tree'], timeout=30).decode().strip()
        validation.write_text(json.dumps(record), encoding='utf-8')
        self.reject_input(repo, validation, root / 'evidence', 'Staged evidence blob exceeds byte limit')

    def reject_optimized(self, **kwargs):
        with tempfile.TemporaryDirectory(prefix='ecorp-evidence-optimized-test-') as temporary:
            root = Path(temporary)
            output = root / 'must-not-exist'
            result = self.invoke('--repository', root / 'missing-source', '--validation',
                                 root / 'missing-validation', '--output-directory', output, **kwargs)
            self.assert_no_receipt(result, output, 'assertions must be enabled')

    def test_dash_o_refuses_before_source_or_output_access(self):
        self.reject_optimized(options=('-O',))

    def test_dash_oo_refuses_before_source_or_output_access(self):
        self.reject_optimized(options=('-OO',))

    def test_environment_one_refuses_before_source_or_output_access(self):
        self.reject_optimized(optimize='1')

    def test_environment_two_refuses_before_source_or_output_access(self):
        self.reject_optimized(optimize='2')

    def test_normal_mode_exposes_explicit_replay_arguments(self):
        result = self.invoke('--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        for argument in ('--repository', '--validation', '--output-directory'):
            self.assertIn(argument, result.stdout)

    def test_failed_gate_cannot_produce_a_fixture(self):
        root, repo, validation, record = self.fixture()
        record['checks'][3]['exit_code'] = 1
        validation.write_text(json.dumps(record), encoding='utf-8')
        output = root / 'evidence'
        result = self.invoke('--repository', repo, '--validation', validation, '--output-directory', output)
        self.assert_no_receipt(result, output, 'Nine passing gates are required')

    def test_duplicate_gate_cannot_replace_a_required_command(self):
        root, repo, validation, record = self.fixture()
        record['checks'][-1] = dict(record['checks'][0])
        validation.write_text(json.dumps(record), encoding='utf-8')
        self.reject_input(repo, validation, root / 'evidence', 'Nine canonical unique gate commands are required')

    def test_substituted_gate_name_program_and_arguments_are_rejected(self):
        for field, value in (('name', 'invented-gate'), ('program', 'echo'),
                             ('arguments', ['--version'])):
            with self.subTest(field=field):
                root, repo, validation, record = self.fixture()
                record['checks'][0][field] = value
                validation.write_text(json.dumps(record), encoding='utf-8')
                self.reject_input(repo, validation, root / 'evidence', 'Nine canonical unique gate commands are required')

    def test_missing_gate_command_metadata_is_rejected(self):
        for field in ('name', 'program', 'arguments'):
            with self.subTest(field=field):
                root, repo, validation, record = self.fixture()
                del record['checks'][0][field]
                validation.write_text(json.dumps(record), encoding='utf-8')
                self.reject_input(repo, validation, root / 'evidence', 'Nine canonical unique gate commands are required')

    def stage_and_bind(self, repo, validation, record):
        subprocess.run(['git', '-C', str(repo), 'add', '--all'], check=True,
                       capture_output=True, timeout=30)
        record['staged_tree'] = subprocess.check_output(
            ['git', '-C', str(repo), 'write-tree'], timeout=30).decode().strip()
        validation.write_text(json.dumps(record), encoding='utf-8')

    def evidence_source(self, repo):
        source = repo / 'tools/test_public_evidence_verifier.py'
        source.parent.mkdir()
        source.write_bytes(b'# owned admission fixture\n')
        report = repo / 'docs/evidence/2026-09-21-pr362-gauntlet-remediation.md'
        report.parent.mkdir(parents=True)
        report.write_bytes(b'Owned admission fixture.\n')
        packet = repo / 'docs/evidence/pr362-combined-20260921'
        packet.mkdir()
        return packet

    def test_staged_entry_limit_rejects_before_materialization(self):
        root, repo, validation, record = self.fixture()
        packet = self.evidence_source(repo)
        for number in range(1023):
            (packet / f'entry-{number}.bin').touch()
        self.stage_and_bind(repo, validation, record)
        self.reject_input(repo, validation, root / 'evidence', 'Staged evidence exceeds entry limit')

    def test_staged_total_bytes_rejects_before_materialization(self):
        root, repo, validation, record = self.fixture()
        packet = self.evidence_source(repo)
        for number in range(8):
            with (packet / f'entry-{number}.bin').open('wb') as stream:
                stream.truncate(FILE_LIMIT)
        self.stage_and_bind(repo, validation, record)
        self.reject_input(repo, validation, root / 'evidence', 'Staged evidence exceeds total byte limit')

    @staticmethod
    def inventory_module():
        spec = importlib.util.spec_from_file_location('staged_evidence_inventory',
            DRIVER.with_name('staged_evidence_inventory.py'))
        module = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'dont_write_bytecode', True):
            spec.loader.exec_module(module)
        return module

    @staticmethod
    def tree_record(name, size=0, mode='100644'):
        return f'{mode} blob {"a" * 40} {size}\t{name}\0'.encode('utf-8')

    def check_inventory_stream(self, data, message=None, exit_code=0):
        module = self.inventory_module()
        reads = []
        stopped = []

        class Stream(io.BytesIO):
            def read1(self, size):
                reads.append(size)
                return super().read1(size)

        class Child:
            stdout = Stream(data)
            returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout):
                self.returncode = -9 if stopped else exit_code
                return self.returncode

            def kill(self):
                stopped.append(self)

        child = Child()
        with patch.object(module.subprocess, 'Popen', return_value=child) as spawned:
            if message:
                with self.assertRaisesRegex(AssertionError, message):
                    module.staged_blobs('owned-source', 'a' * 40, ['docs/evidence'], FILE_LIMIT)
                if exit_code == 0:
                    self.assertEqual(stopped, [child], 'Only the exact retained child must be stopped.')
                result = None
            else:
                result = module.staged_blobs('owned-source', 'a' * 40, ['docs/evidence'], FILE_LIMIT)
                self.assertEqual(stopped, [])
            self.assertIn('-l', spawned.call_args.args[0])
            self.assertIn('-z', spawned.call_args.args[0])
        self.assertTrue(child.stdout.closed)
        self.assertTrue(reads)
        self.assertTrue(all(0 < size <= 4096 for size in reads))
        return result

    def test_staged_entry_exact_boundary_is_accepted(self):
        rows = b''.join(self.tree_record(f'docs/evidence/item-{n}') for n in range(1024))
        self.assertEqual(len(self.check_inventory_stream(rows)), 1024)
        self.check_inventory_stream(rows + self.tree_record('docs/evidence/extra'),
                                    'Staged evidence exceeds entry limit')

    def test_staged_total_exact_boundary_is_accepted(self):
        rows = b''.join(self.tree_record(f'item-{n}', FILE_LIMIT) for n in range(8))
        self.assertEqual(len(self.check_inventory_stream(rows)), 8)
        self.check_inventory_stream(rows + self.tree_record('extra', 1),
                                    'Staged evidence exceeds total byte limit')

    def test_staged_path_byte_boundary_and_plus_one(self):
        name = 'a/' * 500 + 'x' * 24
        self.assertEqual(len(name.encode('utf-8')), 1024)
        self.assertEqual(list(self.check_inventory_stream(self.tree_record(name))), [name])
        self.check_inventory_stream(self.tree_record(name + 'x'), 'Staged evidence path exceeds byte limit')

    def test_staged_paths_reject_aliases_and_file_directory_collisions(self):
        for name in ('../escape', '/absolute', 'C:/absolute', 'a\\b', 'a//b', './a',
                     'a/../b', 'a/CON.txt', 'a/trailing.', 'a/new\nline', 'a/question?'):
            with self.subTest(name=name):
                self.check_inventory_stream(self.tree_record(name), 'Unsafe staged evidence path')
        for names in (('A.txt', 'a.txt'), ('a', 'a/file'), ('a/file', 'A')):
            with self.subTest(names=names):
                self.check_inventory_stream(b''.join(self.tree_record(name) for name in names),
                                            'Colliding staged evidence path')

    def test_staged_unterminated_record_is_bounded(self):
        self.check_inventory_stream(b'x' * 8192, 'Staged evidence record exceeds byte limit')
        self.check_inventory_stream(self.tree_record('a')[:-1], 'Incomplete staged evidence inventory')

    def test_staged_git_failure_and_non_regular_modes_are_rejected(self):
        self.check_inventory_stream(self.tree_record('a'), 'Git staged evidence inventory failed', exit_code=1)
        self.check_inventory_stream(self.tree_record('a', mode='120000'), 'Staged evidence must be regular files')

    def test_different_staged_tree_cannot_produce_a_fixture(self):
        root, repo, validation, record = self.fixture()
        record['staged_tree'] = 'f' * 40
        validation.write_text(json.dumps(record), encoding='utf-8')
        output = root / 'evidence'
        result = self.invoke('--repository', repo, '--validation', validation, '--output-directory', output)
        self.assert_no_receipt(result, output, 'Source differs from passing validation')

    def test_unstaged_source_cannot_produce_a_fixture(self):
        root, repo, validation, _ = self.fixture()
        (repo / 'source.txt').write_bytes(b'not validated\n')
        output = root / 'evidence'
        result = self.invoke('--repository', repo, '--validation', validation, '--output-directory', output)
        self.assert_no_receipt(result, output, 'Unstaged source changes are not validated')

    def test_changed_gate_log_cannot_produce_a_fixture(self):
        root, repo, validation, _ = self.fixture()
        (root / 'gate.log').write_bytes(b'altered result\n')
        output = root / 'evidence'
        result = self.invoke('--repository', repo, '--validation', validation, '--output-directory', output)
        self.assert_no_receipt(result, output, 'Gate log changed')

    def test_gate_log_paths_cannot_escape_the_validation_directory(self):
        for path in ('/outside.log', 'C:/outside.log', '../outside.log', 'nested/../../outside.log',
                     'C:outside.log', '\\\\host\\share\\outside.log', 'gate.log:stream', '.',
                     'nested//gate.log', 'nested/./gate.log', 'NUL', 'nested./gate.log', '', None):
            with self.subTest(path=path):
                root, repo, validation, record = self.fixture()
                record['checks'][0]['log'] = path
                validation.write_text(json.dumps(record), encoding='utf-8')
                result = self.invoke('--repository', repo, '--validation', validation,
                                     '--output-directory', root / 'evidence')
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / 'evidence').exists())
                self.assertIn('Gate logs must use receipt-relative paths.', result.stderr)
                self.assertNotIn('FileNotFoundError', result.stderr,
                                 'Unsafe names must be rejected before opening an unrelated file.')

    def test_regression_summary_requires_the_exact_complete_suite(self):
        module = self.inventory_module()
        module.require_regression_count('test_case ... ok\n\nRan 63 tests in 1.0s\n\nOK\n', 63)
        module.require_regression_count('test_case ... ok\r\n\r\nRan 63 tests in 1.0s\r\n\r\nOK\r\n', 63)
        for output in ('Ran 0 tests in 1.0s\nOK\n', 'Ran 60 tests in 1.0s\nOK\n',
                       'Ran 62 tests in 1.0s\nOK\n', 'Ran 64 tests in 1.0s\nOK\n',
                       'Ran 63 tests in 1.0s\nOK (skipped=1)\n',
                       'Ran 63 tests in 1.0s\nFAILED (failures=1)\n',
                       'Ran 63 tests in 1.0s\nOK\nRan 63 tests in 1.0s\nOK\n', ''):
            with self.subTest(output=output):
                with self.assertRaises(AssertionError):
                    module.require_regression_count(output, 63)

    def test_missing_discovery_file_is_rejected_before_materialization(self):
        root, repo, validation, record = self.fixture()
        self.evidence_source(repo)
        for name in ('staged_evidence_inventory.py', 'verify_pr362_staged_evidence.py'):
            (repo / 'tools' / name).write_text('# owned admission fixture\n', encoding='utf-8')
        self.stage_and_bind(repo, validation, record)
        self.reject_input(repo, validation, root / 'evidence',
                          'Required staged replay source or discovery file is missing')

    def test_existing_evidence_is_preserved(self):
        root, repo, validation, _ = self.fixture()
        output = root / 'evidence'
        output.mkdir()
        marker = output / 'prior-receipt.txt'
        marker.write_bytes(b'preserve original evidence\n')
        result = self.invoke('--repository', repo, '--validation', validation, '--output-directory', output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Preserve existing evidence output', result.stderr)
        self.assertEqual(marker.read_bytes(), b'preserve original evidence\n')
        self.assertEqual(list(output.iterdir()), [marker])


if __name__ == '__main__':
    unittest.main()
