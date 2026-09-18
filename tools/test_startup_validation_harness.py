"""Guard tests for the disposable startup test harness; no Docker effects."""
import json
import subprocess
import unittest
from unittest.mock import patch

import test_startup_validation as harness


class ContainerOwnershipTests(unittest.TestCase):
    def test_timeout_after_creation_cleans_owned_container_and_preserves_error(self):
        database = harness.Postgres()
        calls = []
        timeout = subprocess.TimeoutExpired(['docker', 'run'], 45)

        def command(args, data=None):
            calls.append(args)
            if args[1] == 'run':
                raise timeout
            if args[1] == 'inspect':
                return json.dumps([{'Name': '/' + database.name,
                    'Config': {'Labels': {'ecorp.test-owner': database.owner}}}])
            return ''

        with patch.object(harness, 'command', command), patch.object(
            harness.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'owned-id\n', '')
        ):
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                database.__enter__()
        self.assertIs(raised.exception, timeout)
        self.assertIn(['docker', 'rm', '--force', 'owned-id'], calls)

    def test_cleanup_refuses_foreign_owner(self):
        database = harness.Postgres()
        metadata = json.dumps([{'Name': '/' + database.name,
            'Config': {'Labels': {'ecorp.test-owner': 'someone-else'}}}])
        with patch.object(harness, 'command', return_value=metadata) as command, patch.object(
            harness.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'foreign-id\n', '')
        ):
            with self.assertRaisesRegex(RuntimeError, 'unverified container'):
                database.__exit__(None, None, None)
        command.assert_called_once_with(['docker', 'inspect', 'foreign-id'])

    def test_cleanup_does_nothing_when_creation_never_happened(self):
        database = harness.Postgres()
        with patch.object(harness, 'command') as command, patch.object(
            harness.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')
        ):
            database.__exit__(None, None, None)
        command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
