"""Admission regressions for the runnable PR362 staged-evidence driver."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

DRIVER = Path(__file__).resolve().with_name('verify_pr362_staged_evidence.py')


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
                  'checks': [{'name': str(index), 'exit_code': 0, 'log': str(gate_log),
                              'sha256': hashlib.sha256(gate_log.read_bytes()).hexdigest()}
                             for index in range(9)]}
        validation.write_text(json.dumps(record), encoding='utf-8')
        return root, repo, validation, record

    def assert_no_receipt(self, result, output, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertNotIn('"status": "passed"', result.stdout)
        self.assertFalse(output.exists(), 'Rejected admission created evidence output.')

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
