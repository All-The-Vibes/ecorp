"""Guard tests for the disposable startup test harness; no Docker effects."""
import json
import os
import subprocess
import socket
import ssl
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import test_startup_validation as harness


class ServerEnvironmentTests(unittest.TestCase):
    def test_child_retains_only_required_platform_environment(self):
        with tempfile.TemporaryDirectory(prefix='ecorp-environment-') as directory:
            with patch.dict(os.environ, {'ECORP_TEST_UNRELATED_CREDENTIAL': 'not-for-child'}):
                with patch.object(harness.subprocess, 'Popen') as popen:
                    popen.return_value.poll.return_value = 0
                    server = harness.Server(Path('unused-binary'), Path(directory) / 'server', {})
                    try:
                        child = popen.call_args.kwargs['env']
                        self.assertNotIn('ECORP_TEST_UNRELATED_CREDENTIAL', child)
                        self.assertEqual(child['PATH'], os.defpath)
                        if os.name == 'nt':
                            self.assertEqual(child['SystemRoot'], os.environ['SystemRoot'])
                        else:
                            self.assertNotIn('SystemRoot', child)
                    finally:
                        server.close()


class TlsFixtureTests(unittest.TestCase):
    def test_actual_fixture_requires_tls12_and_accepts_a_verified_tls12_connection(self):
        with tempfile.TemporaryDirectory(prefix='ecorp-tls-policy-') as directory:
            cert, key = Path(directory) / 'cert.pem', Path(directory) / 'key.pem'
            harness.openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost',
                '-addext', 'subjectAltName=DNS:localhost'])
            with harness.http_fixture(True, (cert, key)) as server:
                self.assertEqual(server.socket.context.minimum_version, ssl.TLSVersion.TLSv1_2)
                client = ssl.create_default_context(cafile=str(cert))
                client.maximum_version = ssl.TLSVersion.TLSv1_2
                with socket.create_connection(('127.0.0.1', server.server_port), timeout=2) as sock:
                    with client.wrap_socket(sock, server_hostname='localhost') as connection:
                        self.assertEqual(connection.version(), 'TLSv1.2')
                        connection.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
                        self.assertIn(b'200 OK', connection.recv(4096))


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
