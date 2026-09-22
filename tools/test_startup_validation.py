#!/usr/bin/env python3
"""Opt-in real-binary startup regressions; owns a disposable Docker PostgreSQL.

Requires Python 3.10+, Docker, postgres:17-alpine already present, and OpenSSL.
Never consumes DATABASE_URL or an operator's runtime. See docs/EVALS.md.
"""
import argparse
import contextlib
import hashlib
import http.server
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid


def command(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError(f"fixture command failed: {Path(args[0]).name}")
    return result.stdout.strip()


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def request(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    # Do not inherit proxy configuration, even in the test driver.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=2) as response:
        return json.load(response)


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    scenario = 'valid'
    calls = 0

    def log_message(self, *_):
        pass

    def parse_request(self):
        accepted = super().parse_request()
        if accepted:
            self.server.calls += 1
        return accepted

    def do_GET(self):
        if self.server.storage:
            payload = b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>fixture</Name><IsTruncated>false</IsTruncated></ListBucketResult>'
            status = 200
        else:
            issuer = f'http://127.0.0.1:{self.server.server_port}'
            scenario = self.server.scenario
            document = {'issuer': issuer, 'userinfo_endpoint': issuer + '/userinfo'}
            if scenario == 'mismatch':
                document['issuer'] = issuer + '/DO_NOT_LOG_DISCOVERY_SECRET'
            if scenario == 'userinfo':
                document['userinfo_endpoint'] = 'DO_NOT_LOG_USERINFO_SECRET'
            payload = json.dumps(document).encode()
            if scenario == 'malformed':
                payload = b'DO_NOT_LOG_RESPONSE_SECRET'
            status = 503 if scenario == 'unavailable' else 200
        self.send_response(status)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


@contextlib.contextmanager
def http_fixture(storage=False, tls=None):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    server.daemon_threads = True
    server.storage, server.scenario, server.calls = storage, 'valid', 0
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*tls)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class Postgres:
    def __init__(self):
        self.owner = uuid.uuid4().hex
        self.container = None
        self.name = 'ecorp-271-' + self.owner

    def __enter__(self):
        try:
            return self.start()
        except BaseException:
            try:
                self.__exit__(None, None, None)
            except Exception:
                print('Cleanup could not be verified for owned fixture ' + self.name, flush=True)
            raise

    def start(self):
        self.container = command(['docker', 'run', '--detach', '--pull=never',
            '--name', self.name, '--label', 'ecorp.test-owner=' + self.owner,
            '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw',
            '--env', 'POSTGRES_USER=fixture', '--env', 'POSTGRES_DB=fixture_admin',
            '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine'])
        binding = json.loads(command(['docker', 'inspect', self.container]))[0]['NetworkSettings']['Ports']['5432/tcp'][0]
        if binding['HostIp'] != '127.0.0.1' or int(binding['HostPort']) == 54329:
            raise RuntimeError('refuse unexpected database binding')
        self.port = int(binding['HostPort'])
        for _ in range(100):
            ready = subprocess.run(['docker', 'exec', self.container, 'pg_isready', '-h', '127.0.0.1', '-U', 'fixture', '-d', 'fixture_admin'], capture_output=True, timeout=5)
            if ready.returncode == 0:
                return self
            time.sleep(.1)
        raise RuntimeError('disposable PostgreSQL did not become ready')

    def __exit__(self, *_):
        # The daemon may have created the container even if docker run timed out
        # before returning its ID. Resolve only this invocation's exact name.
        result = subprocess.run(['docker', 'container', 'ls', '-aq', '--filter', 'name=^/'+self.name+'$'], capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise RuntimeError('could not verify disposable container cleanup')
        identity = result.stdout.strip()
        if not identity:
            return
        info = json.loads(command(['docker', 'inspect', identity]))[0]
        if info['Name'] != '/' + self.name or info['Config']['Labels'].get('ecorp.test-owner') != self.owner:
            raise RuntimeError('refuse cleanup of unverified container')
        command(['docker', 'rm', '--force', identity])

    def sql(self, db, query):
        return command(['docker', 'exec', '-i', self.container, 'psql', '-XqAt', '-U', 'fixture', '-d', db, '-v', 'ON_ERROR_STOP=1'], query)

    def create(self, template=None):
        db = 'case_' + uuid.uuid4().hex
        self.sql('fixture_admin', f'CREATE DATABASE {db}' + (f' TEMPLATE {template}' if template else '') + ';')
        return db

    def url(self, db):
        return f'postgres://fixture@127.0.0.1:{self.port}/{db}'

    def fingerprint(self, db):
        schema = command(['docker', 'exec', self.container, 'pg_dump', '-U', 'fixture', '-d', db, '--schema-only', '--schema=public', '--no-owner', '--no-privileges'])
        schema = '\n'.join(line for line in schema.splitlines() if not line.startswith(('\\restrict ', '\\unrestrict ')))
        # One session snapshots every public table, the migration ledger included,
        # and every sequence. Stable row ordering preserves duplicates.
        rows = self.sql(db, r"""
SELECT format('SELECT json_build_array(%L, coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), ''[]''::jsonb))::text FROM ONLY %I.%I t;', tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\gexec
SELECT format('SELECT json_build_array(%L,last_value,is_called)::text FROM %I.%I;', sequencename, schemaname, sequencename)
FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename
\gexec
""")
        return hashlib.sha256((schema + '\n' + rows).encode()).hexdigest()


class Server:
    def __init__(self, binary, directory, env, args=(), prepare=None):
        self.directory = directory
        directory.mkdir()
        for ancestor in (directory.resolve(), *directory.resolve().parents):
            assert not (ancestor / '.env').exists(), 'refuse dotenv ancestor'
        self.port = port()
        self.url = f'http://127.0.0.1:{self.port}'
        self.objects = directory / 'objects'
        self.env = {'PATH': os.defpath, 'HOME': str(directory), 'TMPDIR': str(directory),
                    'CRONY_BIND': f'127.0.0.1:{self.port}', 'CRONY_OBJECT_STORE_LOCAL_ROOT': str(self.objects), **env}
        if prepare:
            prepare(self.objects)
        self.log = tempfile.TemporaryFile()
        self.process = subprocess.Popen([str(binary), *args], cwd=directory, env=self.env,
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.log.close()

    def ready(self):
        for _ in range(150):
            if self.process.poll() is not None:
                raise AssertionError('server exited before readiness')
            try:
                health = request(self.url + '/health')
                assert health['status'] == 'ok'
                return health
            except (OSError, urllib.error.URLError):
                time.sleep(.1)
        raise AssertionError('server readiness timed out')

    def rejected(self):
        deadline = time.monotonic() + 20
        observed = False
        while self.process.poll() is None and time.monotonic() < deadline:
            with socket.socket() as sock:
                sock.settimeout(.02)
                observed |= sock.connect_ex(('127.0.0.1', self.port)) == 0
            time.sleep(.02)
        assert self.process.poll() is not None, 'rejection timed out'
        assert self.process.returncode > 0, 'expected ordinary nonzero exit'
        assert not observed, 'listener observed during rejected startup'
        assert not self.objects.exists(), 'rejected startup created artifact root'
        assert not list(self.directory.iterdir()), 'rejected startup wrote files'
        self.log.seek(0)
        output = self.log.read(4097)
        assert len(output) <= 4096, 'unbounded startup diagnostic'
        markers = [value.encode() for name, value in self.env.items() if ('KEY' in name or 'SECRET' in name) and value]
        for marker in [b'DO_NOT_LOG', b'postgres://', b'http://', b'https://', *markers]:
            assert marker not in output, 'configuration leaked in diagnostic'
        assert b'Stack backtrace' not in output, 'backtrace escaped bounded diagnostic'
        return output


def run(binary, root, postgres, oidc, storage, cert, baseline):
    base = {'CRONY_MODE': 'production', 'CRONY_SECRET_MASTER_KEY_HEX': '42' * 32,
        'CRONY_ARTIFACT_SIGNING_KEY_HEX': '53' * 33, 'CRONY_OBJECT_STORE_BACKEND': 's3',
        'CRONY_OBJECT_STORE_BUCKET': 'fixture', 'CRONY_OBJECT_STORE_ENDPOINT': f'https://127.0.0.1:{storage.server_port}',
        'CRONY_OBJECT_STORE_ACCESS_KEY': 'DO_NOT_LOG_ACCESS', 'CRONY_OBJECT_STORE_SECRET_KEY': 'DO_NOT_LOG_SECRET',
        'CRONY_OIDC_ISSUER': f'http://127.0.0.1:{oidc.server_port}', 'CRONY_ALLOW_INSECURE_OIDC': 'true',
        'CRONY_CORS_ORIGINS': 'https://example.invalid', 'SSL_CERT_FILE': str(cert)}
    cases = [
        ('missing_issuer', {'CRONY_OIDC_ISSUER': None}, 'valid', False),
        ('missing_master', {'CRONY_SECRET_MASTER_KEY_HEX': None}, 'valid', False),
        ('bad_master', {'CRONY_SECRET_MASTER_KEY_HEX': 'DO_NOT_LOG_MASTER'}, 'valid', False),
        ('short_master', {'CRONY_SECRET_MASTER_KEY_HEX': '42'*31}, 'valid', False),
        ('long_master', {'CRONY_SECRET_MASTER_KEY_HEX': '42'*33}, 'valid', False),
        ('missing_signing', {'CRONY_ARTIFACT_SIGNING_KEY_HEX': None}, 'valid', False),
        ('bad_signing', {'CRONY_ARTIFACT_SIGNING_KEY_HEX': 'DO_NOT_LOG_SIGNING'}, 'valid', False),
        ('short_signing', {'CRONY_ARTIFACT_SIGNING_KEY_HEX': '53'*31}, 'valid', False),
        ('backend', {'CRONY_OBJECT_STORE_BACKEND': 'DO_NOT_LOG_BACKEND'}, 'valid', False),
        ('local', {'CRONY_OBJECT_STORE_BACKEND': 'local'}, 'valid', False),
        ('http_flag', {'CRONY_OBJECT_STORE_ALLOW_HTTP': 'true'}, 'valid', False),
        ('bucket', {'CRONY_OBJECT_STORE_BUCKET': None}, 'valid', False),
        ('empty_bucket', {'CRONY_OBJECT_STORE_BUCKET': ''}, 'valid', False),
        ('access_only', {'CRONY_OBJECT_STORE_SECRET_KEY': None}, 'valid', False),
        ('secret_only', {'CRONY_OBJECT_STORE_ACCESS_KEY': None}, 'valid', False),
        ('endpoint', {'CRONY_OBJECT_STORE_ENDPOINT': 'DO_NOT_LOG_ENDPOINT'}, 'valid', False),
        ('endpoint_http', {'CRONY_OBJECT_STORE_ENDPOINT': f'http://127.0.0.1:{storage.server_port}'}, 'valid', False),
        ('zero_limit', {'CRONY_ARTIFACT_MAX_BYTES': '0'}, 'valid', False),
        ('bad_limit', {'CRONY_ARTIFACT_MAX_BYTES': 'DO_NOT_LOG_LIMIT'}, 'valid', False),
        ('cors', {'CRONY_CORS_ORIGINS': 'https://DO_NOT_LOG_CORS\ninvalid'}, 'valid', False),
        ('cors_wildcard', {'CRONY_CORS_ORIGINS': '*'}, 'valid', False),
        ('http_issuer', {'CRONY_ALLOW_INSECURE_OIDC': 'false'}, 'valid', False),
        ('bad_issuer', {'CRONY_OIDC_ISSUER': 'DO_NOT_LOG_ISSUER'}, 'valid', False),
        ('mismatch', {}, 'mismatch', True),
        ('metadata', {}, 'malformed', True),
        ('userinfo', {}, 'userinfo', True),
        ('discovery_status', {}, 'unavailable', True),
        ('backtraces', {'CRONY_SECRET_MASTER_KEY_HEX': 'DO_NOT_LOG_MASTER', 'RUST_BACKTRACE': 'full', 'RUST_LIB_BACKTRACE': 'full'}, 'valid', False),
        ('dev_invalid', {'CRONY_MODE': 'development', 'CRONY_OBJECT_STORE_BACKEND': 'local', 'CRONY_SECRET_MASTER_KEY_HEX': 'DO_NOT_LOG_MASTER'}, 'valid', False),
    ]
    templates = [('empty', None)]
    if not baseline:
        seed = postgres.create()
        dev = {'DATABASE_URL': postgres.url(seed), 'CRONY_MODE': 'development'}
        server = Server(binary, root/'seed', dev)
        try:
            server.ready()
            demo = request(server.url+'/api/demo/bootstrap?seed_crew=false', {})
            assert demo['corp_id']
        finally:
            server.close()
        before = postgres.fingerprint(seed)
        server = Server(binary, root/'restart', dev)
        try:
            server.ready()
            assert request(server.url+f"/api/corps/{demo['corp_id']}/snapshot?actor_id={demo['alice_actor_id']}")['snapshot']
        finally:
            server.close()
        assert postgres.fingerprint(seed) == before, 'quiescent restart changed demo data'
        # Recovery-sensitive records must change under valid startup and remain
        # unchanged under every rejected startup, not just an idle demo seed.
        postgres.sql(seed, f"INSERT INTO runner_nodes(id,corp_id,hostname,os,connection_epoch,status) VALUES ('recovery-fixture','{demo['corp_id']}','fixture','fixture','{uuid.uuid4()}','connected');")
        recovery = postgres.create(seed)
        def orphan(objects):
            path = objects/'staging'/'corps'/demo['corp_id']/str(uuid.uuid4())
            path.parent.mkdir(parents=True)
            path.write_bytes(b'orphan fixture')
            (objects/'retained-marker').write_bytes(b'preserve')
        server = Server(binary, root/'recovery', {**dev, 'DATABASE_URL':postgres.url(recovery), 'CRONY_RUNNER_GRACE_SECS':'60'}, prepare=orphan)
        try:
            server.ready()
            assert postgres.sql(recovery, "SELECT status FROM runner_nodes WHERE id='recovery-fixture';") == 'grace'
            assert not any(p.is_file() for p in (server.objects/'staging').rglob('*'))
            assert (server.objects/'retained-marker').read_bytes() == b'preserve'
        finally:
            server.close()
        assert postgres.sql(seed, "SELECT status FROM runner_nodes WHERE id='recovery-fixture';") == 'connected'
        templates.append(('seeded', seed))
        print('PASS runner and orphan-artifact startup recovery on a disposable clone', flush=True)
        print('PASS development startup, migration, demo persistence and restart', flush=True)
    for state, template in templates:
        for name, patch, scenario, discovery in (cases[:1] if baseline else cases):
            db = postgres.create(template)
            oidc.scenario, oidc.calls, storage.calls = scenario, 0, 0
            config = {**base, **patch, 'DATABASE_URL': postgres.url(db)}
            config = {k:v for k,v in config.items() if v is not None}
            before = postgres.fingerprint(db)
            server = Server(binary, root/(state+'_'+name), config)
            try:
                server.rejected()
            finally:
                server.close()
            assert postgres.fingerprint(db) == before, f'{state}/{name}: database changed'
            assert bool(oidc.calls) == discovery, f'{name}: unexpected discovery requests'
            assert storage.calls == 0, f'{name}: storage accessed before rejection'
            print('PASS', state, name, flush=True)
    cli_db = postgres.create()
    cli_config = {**base, 'DATABASE_URL': postgres.url(cli_db)}
    before = postgres.fingerprint(cli_db)
    oidc.scenario, oidc.calls, storage.calls = 'valid', 0, 0
    server = Server(binary, root/'cli_reject', cli_config, args=('--artifact-max-bytes', 'DO_NOT_LOG_CLI'))
    try:
        assert b'invalid startup arguments' in server.rejected()
    finally:
        server.close()
    assert postgres.fingerprint(cli_db) == before, 'CLI rejection changed the database'
    assert oidc.calls == storage.calls == 0, 'CLI rejection contacted a fixture'
    server = Server(binary, root/'help', cli_config, args=('--help',))
    try:
        assert server.process.wait(timeout=5) == 0
        server.log.seek(0)
        help_text = server.log.read(20000)
        for marker in (b'DO_NOT_LOG', b'42'*32, b'53'*33,
                b'postgres://crony:crony@127.0.0.1:54329/crony',
                postgres.url(cli_db).encode()):
            assert marker not in help_text, 'help exposed environment values'
        assert not list(server.directory.iterdir()), 'help wrote application files'
    finally:
        server.close()
    assert postgres.fingerprint(cli_db) == before, 'help changed the database'
    assert oidc.calls == storage.calls == 0, 'help contacted a fixture'
    print('PASS explicit CLI rejection and secret-safe help', flush=True)
    oidc.scenario = 'valid'
    for key_bytes in (32, 33):
        db = postgres.create()
        storage.calls = 0
        config = {**base, 'DATABASE_URL': postgres.url(db), 'CRONY_ARTIFACT_SIGNING_KEY_HEX': '53'*key_bytes}
        server = Server(binary, root/f'production_{key_bytes}', config)
        try:
            assert server.ready()['mode'] == 'production'
            assert storage.calls > 0, 'production recovery never reached TLS storage fixture'
            expected = len(json.loads((Path(__file__).resolve().parents[1]/'db/migrations/manifest.json').read_text())['migrations'])
            assert int(postgres.sql(db, 'SELECT count(*) FROM _sqlx_migrations;')) == expected
        finally:
            server.close()
        print('PASS production startup with TLS storage and signing bytes', key_bytes, flush=True)


def main():
    if not __debug__:
        raise RuntimeError('run regression assertions without Python optimization')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-binary', type=Path, required=True)
    parser.add_argument('--allow-disposable-docker', action='store_true', required=True)
    parser.add_argument('--baseline', action='store_true', help='run one rejection; an unfixed binary must FAIL')
    args = parser.parse_args()
    binary = args.server_binary.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='ecorp271-') as directory:
        root = Path(directory)
        ca, ca_key = root/'ca.pem', root/'ca-key.pem'
        cert, key, csr = root/'cert.pem', root/'key.pem', root/'request.pem'
        command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ca_key),
            '-out', str(ca), '-days', '1', '-subj', '/CN=ECorp disposable test CA',
            '-addext', 'basicConstraints=critical,CA:TRUE'])
        command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key),
            '-out', str(csr), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
            '-addext', 'basicConstraints=critical,CA:FALSE'])
        command(['openssl', 'x509', '-req', '-in', str(csr), '-CA', str(ca), '-CAkey', str(ca_key),
            '-CAcreateserial', '-out', str(cert), '-days', '1', '-copy_extensions', 'copy'])
        with Postgres() as postgres, http_fixture() as oidc, http_fixture(True, (cert, key)) as storage:
            # Exercise the fixture counter for methods other than GET.
            import http.client
            for method in ('HEAD', 'PUT', 'DELETE'):
                conn = http.client.HTTPConnection('127.0.0.1', oidc.server_port, timeout=2)
                conn.request(method, '/')
                conn.getresponse().read()
                conn.close()
            assert oidc.calls == 3, 'fixture does not count all methods'
            run(binary, root, postgres, oidc, storage, ca, args.baseline)
    print('All startup regressions passed; owned infrastructure removed.')


if __name__ == '__main__':
    main()
