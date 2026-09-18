"""Pure safeguards for the opt-in PR265 acceptance driver; no running stack needed."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("activity_acceptance", Path(__file__).with_name("e2e_factory_run_activity.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class AcceptanceGuards(unittest.TestCase):
    def test_rejects_relative_broad_and_product_paths(self):
        for value in ("relative", str(Path.home()), str(driver.PRODUCT),
                      str(Path.home() / "qa/other-test"), str(Path.home() / "qa/../qa/pr265-run-activity-test")):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                driver.validate_root(value)

    def test_accepts_only_named_dedicated_root(self):
        root = Path.home() / "qa/pr265-run-activity-unit-test"
        self.assertEqual(driver.validate_root(str(root)), root.resolve())

    def test_stateful_checkpoint_cannot_be_prepared_again(self):
        suite = driver.Acceptance.__new__(driver.Acceptance)
        suite.cp = {"status": "preparing", "operations": [{"name": "claim", "completed": True}]}
        suite.snapshot = lambda: self.fail("No API access after a stateful checkpoint")
        with self.assertRaises(AssertionError):
            suite.prepare()

    def test_uncertain_mutation_is_recorded_and_not_retried(self):
        suite = driver.Acceptance.__new__(driver.Acceptance)
        suite.cp = {"operations": []}
        calls = []
        suite.save = lambda: None
        def failed_request(*args):
            calls.append(args)
            raise TimeoutError("uncertain outcome")
        suite.request = failed_request
        with self.assertRaises(TimeoutError):
            suite.post("claim", "/api/owned/claim", {})
        self.assertFalse(suite.cp["operations"][0]["completed"])
        with self.assertRaises(AssertionError):
            suite.post("claim", "/api/owned/claim", {})
        self.assertEqual(len(calls), 1)

    def test_fixture_sql_never_inherits_ambient_database_credentials(self):
        suite = driver.Acceptance.__new__(driver.Acceptance)
        suite.pg = Path("C:/owned/pgsql/bin")
        suite.receipt = {"plan": {"database": {"port": 15465}}}
        with patch.dict(os.environ, {"PGPASSWORD": "synthetic-not-a-real-secret", "PGSERVICE": "other-db"}), \
             patch.object(driver.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="1")) as run:
            self.assertEqual(suite.sql("SELECT 1;"), "1")
        options = run.call_args.kwargs
        self.assertNotIn("PGPASSWORD", options["env"])
        self.assertNotIn("PGSERVICE", options["env"])
        self.assertEqual(options["env"]["PGDATABASE"], "pr265_activity")
        self.assertEqual(options["env"]["PGHOST"], "127.0.0.1")
        self.assertNotIn("shell", options)

    def test_dry_run_does_not_verify_processes_send_requests_or_write_checkpoint(self):
        root = Path.home() / "qa/pr265-run-activity-unit-test"
        def init(suite, _args):
            suite.qa, suite.server, suite.web = root, "http://127.0.0.1:18865", "http://127.0.0.1:15865"
        output = io.StringIO()
        with patch.object(driver.Acceptance, "__init__", init), \
             patch.object(driver.Acceptance, "ownership") as ownership, \
             patch.object(driver.Acceptance, "request") as request, \
             patch.object(driver.Acceptance, "save") as save, \
             patch("sys.argv", ["acceptance", "--qa-root", str(root), "--postgres-bin", "C:/owned/bin", "--dry-run"]), \
             contextlib.redirect_stdout(output):
            driver.main()
        report = json.loads(output.getvalue())
        self.assertTrue(report["dry_run"])
        self.assertFalse(report["writes"])
        ownership.assert_not_called()
        request.assert_not_called()
        save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
