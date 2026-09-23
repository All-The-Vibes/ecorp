"""Run the repository's unchanged startup assertions against owned native PG.

The PowerShell supervisor creates/stops the exact fixture. Only Docker transport,
fixture URL delivery, and required Windows OS variables are adapted here. The
original fingerprint, process lifecycle, rejection, recovery and TLS assertions
are imported verbatim; fixture files and database history remain on disk.
"""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


def main():
    if not __debug__:
        raise RuntimeError("Startup assertions must remain enabled")
    sys.dont_write_bytecode = True
    configuration = Path(os.environ["ECORP_STARTUP_FIXTURE_CONFIG"])
    config = json.loads(configuration.read_text(encoding="utf-8-sig"))
    qa = Path(config["qa_root"]).resolve(strict=True)
    product = Path(config["product"]).resolve(strict=True)
    driver = product / "tools/test_startup_validation.py"
    assert hashlib.sha256(driver.read_bytes()).hexdigest() == config["driver_sha256"]
    binary = Path(config["binary"]).resolve(strict=True)
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == config["binary_sha256"]
    ownership = json.loads((qa / "ownership.json").read_text(encoding="utf-8-sig"))
    assert ownership["test_owned"] is True
    assert ownership["purpose"] == "pr283-startup-validation"
    assert Path(ownership["workspace"]).resolve() == qa
    assert ownership["processes"]["postgres"]["pid"] == config["postgres_pid"]
    assert ownership["plan"]["database"]["port"] == config["port"]
    assert ownership["plan"]["database"]["user"] == "fixture"
    secret = (qa / "credentials/postgres-password.txt").read_text()
    assert re.fullmatch(r"[a-f0-9]{64}", secret)
    assert Path(os.environ["PGPASSFILE"]).resolve() == qa / "credentials/pgpass.conf"
    pg = Path(config["postgres_bin"]).resolve(strict=True)
    fixture_identity = "native-owned-" + config["nonce"]
    spec = importlib.util.spec_from_file_location("ecorp283_startup_driver", driver)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    original_command = module.command

    def native_command(arguments, data=None):
        if arguments[0] == "docker":
            # Preserve Postgres.fingerprint byte-for-byte, replacing only its
            # exact owned pg_dump invocation. Reject every other Docker action.
            assert arguments[:4] == ["docker", "exec", fixture_identity, "pg_dump"]
            arguments = [str(pg / "pg_dump.exe"), "-w", "-h", "127.0.0.1",
                         "-p", str(config["port"]), *arguments[4:]]
        return original_command(arguments, data)

    module.command = native_command

    class NativePostgres(module.Postgres):
        def start(self):
            self.container = fixture_identity
            self.port = config["port"]
            assert self.sql("fixture_admin", "SELECT current_user;") == "fixture"
            assert self.sql("fixture_admin", "SHOW port;") == str(self.port)
            assert Path(self.sql("fixture_admin", "SHOW data_directory;")).resolve() == qa / "database"
            return self

        def __exit__(self, *_):
            # The supervisor retains and stops the exact owned process even
            # when this interpreter fails. No Docker cleanup is translated.
            pass

        def sql(self, database, query):
            assert database == "fixture_admin" or re.fullmatch(r"case_[a-f0-9]{32}", database)
            return native_command([str(pg / "psql.exe"), "-XqAt", "-w", "-h", "127.0.0.1",
                                   "-p", str(self.port), "-U", "fixture", "-d", database,
                                   "-v", "ON_ERROR_STOP=1"], query)

        def url(self, database):
            assert re.fullmatch(r"case_[a-f0-9]{32}", database)
            return f"postgres://fixture:{secret}@127.0.0.1:{self.port}/{database}"

    class WindowsServer(module.Server):
        def __init__(self, binary, directory, env, args=(), prepare=None):
            required_os = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR") if key in os.environ}
            super().__init__(binary, directory, {**required_os, **env}, args, prepare)

    module.Server = WindowsServer
    root = qa / "cases"
    root.mkdir()
    ca, ca_key = root / "ca.pem", root / "ca-key.pem"
    cert, key, csr = root / "cert.pem", root / "key.pem", root / "request.pem"
    openssl = config["openssl"]
    native_command([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(ca_key),
                    "-out", str(ca), "-days", "1", "-subj", "/CN=ECorp disposable test CA",
                    "-addext", "basicConstraints=critical,CA:TRUE"])
    native_command([openssl, "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
                    "-out", str(csr), "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
                    "-addext", "basicConstraints=critical,CA:FALSE"])
    native_command([openssl, "x509", "-req", "-in", str(csr), "-CA", str(ca), "-CAkey", str(ca_key),
                    "-CAcreateserial", "-out", str(cert), "-days", "1", "-copy_extensions", "copy"])
    with NativePostgres() as postgres, module.http_fixture() as oidc, module.http_fixture(True, (cert, key)) as storage:
        for method in ("HEAD", "PUT", "DELETE"):
            conn = http.client.HTTPConnection("127.0.0.1", oidc.server_port, timeout=2)
            conn.request(method, "/")
            conn.getresponse().read()
            conn.close()
        assert oidc.calls == 3, "fixture does not count all methods"
        module.run(binary, root, postgres, oidc, storage, ca, False)
    assert hashlib.sha256(driver.read_bytes()).hexdigest() == config["driver_sha256"]
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == config["binary_sha256"]
    print("PASS all unchanged startup assertions on the owned native PostgreSQL fixture", flush=True)
    print("Fixture credentials reach server children through isolated environment delivery (reduced assurance).", flush=True)
    print("Supervisor will stop only its exact owned PostgreSQL; evidence and data remain retained.", flush=True)


if __name__ == "__main__":
    main()
