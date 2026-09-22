"""Exercise the public evidence verifier in normal and optimized interpreters."""

from contextlib import contextmanager
import json
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
    @contextmanager
    def packet_copy(self):
        with tempfile.TemporaryDirectory(prefix="ecorp-public-evidence-test-") as root:
            base = Path(root) / "evidence"
            for packet in PACKETS:
                shutil.copytree(EVIDENCE / packet, base / packet)
            yield base

    def assert_refused(self, base, message):
        result = self.invoke(base / PACKETS[-1] / "verify_public.py")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn('"result": "PASS"', result.stdout)
        self.assertIn(message, result.stderr)

    def directory_link(self, link, target):
        if os.name == "nt":
            result = subprocess.run(
                ["cmd", "/d", "/c", "mklink", "/J", str(link), str(target)],
                capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            link.symlink_to(target, target_is_directory=True)

    @staticmethod
    def remove_directory_link(link):
        if os.name == "nt":
            link.rmdir()
        else:
            link.unlink()

    def mutate_manifest(self, base, action):
        path = base / PACKETS[0] / "manifest.json"
        manifest = json.loads(path.read_bytes())
        action(manifest)
        path.write_text(json.dumps(manifest), encoding="utf-8")

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

    def test_unlisted_nested_directory_is_rejected(self):
        with self.packet_copy() as base:
            nested = base / PACKETS[0] / "unlisted"
            nested.mkdir()
            (nested / "payload.txt").write_text("unchecked payload", encoding="utf-8")
            self.assert_refused(base, "non-regular evidence entry")

    def test_linked_packet_is_rejected(self):
        with self.packet_copy() as base:
            packet = base / PACKETS[0]
            preserved = base.parent / "linked-packet-target"
            packet.rename(preserved)
            self.directory_link(packet, preserved)
            try:
                self.assert_refused(base, "linked evidence path")
            finally:
                self.remove_directory_link(packet)
            self.assertTrue((preserved / "manifest.json").is_file())

    def test_linked_root_and_ancestor_are_rejected(self):
        for depth in (0, 1):
            with self.subTest(depth=depth), self.packet_copy() as base:
                target = base if depth == 0 else base.parent
                alias = base.parent / "root-alias" if depth == 0 else base.parent / "ancestor-alias"
                self.directory_link(alias, target)
                try:
                    linked_base = alias if depth == 0 else alias / "evidence"
                    self.assert_refused(linked_base, "linked evidence path")
                finally:
                    self.remove_directory_link(alias)

    def test_linked_delivered_file_is_rejected(self):
        with self.packet_copy() as base:
            readme = base / PACKETS[0] / "README.md"
            original = readme.read_bytes()
            target = base.parent / "outside-readme.md"
            target.write_bytes(original)
            readme.unlink()
            try:
                readme.symlink_to(target)
            except OSError as error:
                self.skipTest(f"file symlink creation unavailable: {error}")
            try:
                self.assert_refused(base, "linked evidence path")
            finally:
                readme.unlink()
            self.assertEqual(target.read_bytes(), original)

    def test_unsafe_manifest_paths_are_rejected(self):
        for unsafe in ("../outside.txt", "/outside.txt", "C:/outside.txt", "nested/file.txt", "nested\\file.txt", "", "."):
            with self.subTest(path=unsafe), self.packet_copy() as base:
                self.mutate_manifest(base, lambda manifest: manifest["delivered_files"][0].update(path=unsafe))
                self.assert_refused(base, "unsafe packet filename")

    def test_image_path_cannot_escape_manifest_inventory(self):
        with self.packet_copy() as base:
            manifest = json.loads((base / PACKETS[0] / "manifest.json").read_bytes())
            source = base / PACKETS[0] / manifest["images"][0]["path"]
            outside = base / "outside.png"
            outside.write_bytes(source.read_bytes())
            self.mutate_manifest(base, lambda data: data["images"][0].update(path="../outside.png"))
            self.assert_refused(base, "unsafe packet filename")

    def test_duplicate_delivered_manifest_paths_are_rejected(self):
        with self.packet_copy() as base:
            self.mutate_manifest(base, lambda manifest: manifest["delivered_files"].append(dict(manifest["delivered_files"][0])))
            self.assert_refused(base, "duplicate packet filename")

    def test_readme_link_cannot_escape_the_verified_packets(self):
        import hashlib

        with self.packet_copy() as base:
            outside = base.parent / "outside.md"
            outside.write_text("not part of any evidence packet", encoding="utf-8")
            readme = base / PACKETS[0] / "README.md"
            readme.write_bytes(readme.read_bytes() + b"\n[escape](../../outside.md)\n")
            data = readme.read_bytes()
            def update(manifest):
                row = next(row for row in manifest["delivered_files"] if row["path"] == "README.md")
                row.update(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
                if "canonical_lf_sha256" in row:
                    row["canonical_lf_sha256"] = hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()
            self.mutate_manifest(base, update)
            self.assert_refused(base, "unsafe README evidence link")

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
