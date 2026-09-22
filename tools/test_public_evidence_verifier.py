"""Exercise the public evidence verifier in normal and optimized interpreters."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


EVIDENCE = Path(__file__).resolve().parents[1] / "docs" / "evidence"
PACKETS = (
    "pr362-startup-20260921",
    "pr362-regressions-20260921",
    "pr362-combined-20260921",
)
VERIFIER = EVIDENCE / PACKETS[-1] / "verify_public.py"


class PublicEvidenceVerifierTests(unittest.TestCase):
    def invoke(self, script=VERIFIER, options=(), optimize=None):
        environment = dict(os.environ)
        environment.pop("PYTHONOPTIMIZE", None)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        if optimize is not None:
            environment["PYTHONOPTIMIZE"] = optimize
        return subprocess.run(
            [sys.executable, *options, str(script)],
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def test_normal_interpreter_accepts_intact_packet(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"result": "PASS"', result.stdout)

    def test_normal_interpreter_rejects_corrupted_packet(self):
        with tempfile.TemporaryDirectory(prefix="ecorp-public-evidence-test-") as root:
            base = Path(root)
            for packet in PACKETS:
                shutil.copytree(EVIDENCE / packet, base / packet)
            readme = base / PACKETS[0] / "README.md"
            readme.write_bytes(readme.read_bytes() + b"\ncontrolled fixture corruption\n")
            result = self.invoke(base / PACKETS[-1] / "verify_public.py")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('"result": "PASS"', result.stdout)

    def assert_optimization_refused(self, **kwargs):
        result = self.invoke(**kwargs)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn('"result": "PASS"', result.stdout)
        self.assertIn("assertions must be enabled", result.stderr)

    def test_dash_o_is_refused(self):
        self.assert_optimization_refused(options=("-O",))

    def test_dash_oo_is_refused(self):
        self.assert_optimization_refused(options=("-OO",))

    def test_environment_level_one_is_refused(self):
        self.assert_optimization_refused(optimize="1")

    def test_environment_level_two_is_refused(self):
        self.assert_optimization_refused(optimize="2")


if __name__ == "__main__":
    unittest.main()
