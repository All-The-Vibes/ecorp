"""Guard tests for the disposable startup test harness; no Docker effects."""
import json
import os
import subprocess
import socket
import ssl
import tempfile
from pathlib import Path
from types import SimpleNamespace
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
            def context_with_stricter_default(protocol):
                self.assertEqual(protocol, ssl.PROTOCOL_TLS_SERVER)
                context = ssl.SSLContext(protocol)
                context.minimum_version = ssl.TLSVersion.TLSv1_3
                return context

            # Replace only the fixture module's constructor lookup, not ssl.SSLContext:
            # keep real context/property/handshake semantics and system defaults intact.
            fixture_ssl = SimpleNamespace(SSLContext=context_with_stricter_default,
                PROTOCOL_TLS_SERVER=ssl.PROTOCOL_TLS_SERVER, TLSVersion=ssl.TLSVersion)
            with patch.object(harness, 'ssl', fixture_ssl), harness.http_fixture(True, (cert, key)) as server:
                self.assertEqual(server.socket.context.minimum_version, ssl.TLSVersion.TLSv1_2)
                client = ssl.create_default_context(cafile=str(cert))
                client.minimum_version = ssl.TLSVersion.TLSv1_2
                client.maximum_version = ssl.TLSVersion.TLSv1_2
                with socket.create_connection(('127.0.0.1', server.server_port), timeout=2) as sock:
                    with client.wrap_socket(sock, server_hostname='localhost') as connection:
                        self.assertEqual(connection.version(), 'TLSv1.2')
                        connection.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
                        self.assertIn(b'200 OK', connection.recv(4096))


class ContainerOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.elapsed = 0.0
        self.sleeps = []

        def sleep(seconds):
            self.assertGreater(seconds, 0)
            self.assertLessEqual(seconds, .25)
            self.sleeps.append(seconds)
            self.elapsed += seconds

        clock = SimpleNamespace(monotonic=lambda: self.elapsed, sleep=sleep)
        self.clock_patch = patch.object(harness, 'time', clock)
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)

    @staticmethod
    def metadata(database, **changes):
        return json.dumps([{'Name': '/' + database.name,
            'Config': {'Labels': {'ecorp.test-owner': database.owner}}, **changes}])

    @staticmethod
    def lookup(identity=''):
        return subprocess.CompletedProcess([], 0, identity, '')

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
        ) as lookup, patch('builtins.print') as diagnostic:
            database.__exit__(None, None, None)
        command.assert_not_called()
        self.assertEqual(self.elapsed, 5.0)
        self.assertEqual(lookup.call_count, 20)
        self.assertEqual(len(self.sleeps), 20)
        self.assertIn(database.name, diagnostic.call_args.args[0])
        self.assertIn('may appear later', diagnostic.call_args.args[0])
        for call in lookup.call_args_list:
            self.assertEqual(call.args[0], ['docker', 'container', 'ls', '-aq',
                '--filter', 'name=^/' + database.name + '$'])
            self.assertGreater(call.kwargs['timeout'], 0)
            self.assertLessEqual(call.kwargs['timeout'], 5)

    def test_delayed_creation_is_removed_and_startup_error_is_preserved(self):
        database = harness.Postgres()
        timeout = subprocess.TimeoutExpired(['docker', 'run'], 45)
        calls = []

        def command(args, data=None):
            calls.append(args)
            if args[1] == 'run':
                raise timeout
            if args[1] == 'inspect':
                return self.metadata(database)
            return ''

        with patch.object(harness, 'command', command), patch.object(
            harness.subprocess, 'run', side_effect=[self.lookup(), self.lookup('owned-id\n')]
        ) as lookup:
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                database.__enter__()
        self.assertIs(raised.exception, timeout)
        self.assertIn(['docker', 'rm', '--force', 'owned-id'], calls)
        self.assertEqual(self.sleeps, [.25])
        self.assertEqual([call.kwargs['timeout'] for call in lookup.call_args_list], [5.0, 4.75])
        for call in lookup.call_args_list:
            self.assertEqual(call.args[0][-1], 'name=^/' + database.name + '$')

    def test_no_appearance_reports_uncertainty_and_preserves_startup_error(self):
        database = harness.Postgres()
        timeout = subprocess.TimeoutExpired(['docker', 'run'], 45)
        with patch.object(harness, 'command', side_effect=timeout) as command, patch.object(
            harness.subprocess, 'run', return_value=self.lookup()
        ), patch('builtins.print') as diagnostic:
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                database.__enter__()
        self.assertIs(raised.exception, timeout)
        self.assertEqual(command.call_count, 1)
        self.assertEqual(self.elapsed, 5.0)
        self.assertIn(database.name, diagnostic.call_args.args[0])
        self.assertIn('may appear later', diagnostic.call_args.args[0])

    def test_delayed_foreign_owner_is_preserved_with_original_startup_error(self):
        database = harness.Postgres()
        timeout = subprocess.TimeoutExpired(['docker', 'run'], 45)
        foreign = self.metadata(database, Config={'Labels': {'ecorp.test-owner': 'other'}})
        with patch.object(harness, 'command', side_effect=[timeout, foreign]) as command, patch.object(
            harness.subprocess, 'run', side_effect=[self.lookup(), self.lookup('foreign-id')]
        ), patch('builtins.print') as diagnostic:
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                database.__enter__()
        self.assertIs(raised.exception, timeout)
        self.assertEqual([call.args[0][1] for call in command.call_args_list], ['run', 'inspect'])
        self.assertEqual(self.sleeps, [.25])
        self.assertIn(database.name, diagnostic.call_args.args[0])

    def test_cleanup_refuses_unexpected_inspection_identity(self):
        database = harness.Postgres()
        for metadata in (self.metadata(database, Name='/different-container'),
                         json.dumps([json.loads(self.metadata(database))[0]] * 2)):
            with self.subTest(metadata=metadata), patch.object(harness, 'command', return_value=metadata) as command, patch.object(
                harness.subprocess, 'run', return_value=self.lookup('owned-id')
            ):
                with self.assertRaisesRegex(RuntimeError, 'unverified container'):
                    database.__exit__(None, None, None)
            command.assert_called_once_with(['docker', 'inspect', 'owned-id'])

    def test_cleanup_refuses_ambiguous_lookup_without_inspection_or_removal(self):
        database = harness.Postgres()
        with patch.object(harness, 'command') as command, patch.object(
            harness.subprocess, 'run', return_value=self.lookup('first-id\nsecond-id\n')
        ):
            with self.assertRaisesRegex(RuntimeError, 'unverified container'):
                database.__exit__(None, None, None)
        command.assert_not_called()

    def test_lookup_failure_preserves_startup_error_and_reports_uncertainty(self):
        for failure in (subprocess.CompletedProcess([], 1, '', 'private daemon diagnostic'),
                        subprocess.TimeoutExpired(['docker', 'container', 'ls'], 5)):
            with self.subTest(failure=type(failure).__name__):
                database = harness.Postgres()
                timeout = subprocess.TimeoutExpired(['docker', 'run'], 45)
                with patch.object(harness, 'command', side_effect=timeout) as command, patch.object(
                    harness.subprocess, 'run', side_effect=[self.lookup(), failure]
                ), patch('builtins.print') as diagnostic:
                    with self.assertRaises(subprocess.TimeoutExpired) as raised:
                        database.__enter__()
                self.assertIs(raised.exception, timeout)
                self.assertEqual(command.call_count, 1)
                self.assertIn(database.name, diagnostic.call_args.args[0])
                self.assertNotIn('private daemon diagnostic', diagnostic.call_args.args[0])

    def test_inspection_or_removal_failure_preserves_startup_error(self):
        for stage in ('inspect', 'rm'):
            with self.subTest(stage=stage):
                database = harness.Postgres()
                timeout = subprocess.TimeoutExpired(['docker', 'run'], 45)

                def command(args, data=None):
                    if args[1] == 'run':
                        raise timeout
                    if args[1] == stage:
                        raise RuntimeError('private daemon diagnostic')
                    return self.metadata(database)

                with patch.object(harness, 'command', command), patch.object(
                    harness.subprocess, 'run', return_value=self.lookup('owned-id')
                ), patch('builtins.print') as diagnostic:
                    with self.assertRaises(subprocess.TimeoutExpired) as raised:
                        database.__enter__()
                self.assertIs(raised.exception, timeout)
                self.assertIn(database.name, diagnostic.call_args.args[0])
                self.assertNotIn('private daemon diagnostic', diagnostic.call_args.args[0])

    def test_known_id_cleanup_never_waits_for_appearance(self):
        for identity in ('', 'owned-id'):
            with self.subTest(identity=identity):
                database = harness.Postgres()
                database.container = 'owned-id'
                with patch.object(harness, 'command', return_value=self.metadata(database)) as command, patch.object(
                    harness.subprocess, 'run', return_value=self.lookup(identity)
                ) as lookup, patch('builtins.print') as diagnostic:
                    database.__exit__(None, None, None)
                self.assertEqual(lookup.call_count, 1)
                self.assertEqual(lookup.call_args.kwargs['timeout'], 15)
                self.assertEqual(self.sleeps, [])
                diagnostic.assert_not_called()
                if identity:
                    self.assertEqual(command.call_args_list[-1].args[0], ['docker', 'rm', '--force', identity])
                else:
                    command.assert_not_called()

    def test_lookup_time_counts_towards_grace_without_oversleep(self):
        database = harness.Postgres()

        def slow_lookup(*args, **kwargs):
            self.elapsed += 4.9
            return self.lookup()

        with patch.object(harness, 'command') as command, patch.object(
            harness.subprocess, 'run', side_effect=slow_lookup
        ) as lookup, patch('builtins.print'):
            database.__exit__(None, None, None)
        command.assert_not_called()
        self.assertEqual(lookup.call_count, 1)
        self.assertEqual(self.elapsed, 5.0)
        self.assertEqual(len(self.sleeps), 1)
        self.assertAlmostEqual(self.sleeps[0], .1)


if __name__ == '__main__':
    unittest.main()
