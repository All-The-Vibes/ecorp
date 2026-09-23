"""Exercise the public evidence verifier in normal and optimized interpreters."""

from contextlib import contextmanager, nullcontext
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


EVIDENCE = Path(__file__).resolve().parents[1] / "docs" / "evidence"
PACKETS = (
    "pr362-startup-20260921",
    "pr362-regressions-20260921",
    "pr362-combined-20260921",
)
VERIFIER = EVIDENCE / PACKETS[-1] / "verify_public.py"
FILE_LIMIT = 8 * 1024 * 1024
ARCHIVE_LIMIT = 4 * 1024 * 1024
MEMBER_LIMIT = 1024 * 1024
ARCHIVE_TOTAL_LIMIT = 16 * 1024 * 1024
ARCHIVE_MEMBER_COUNT = 512
PACKET_FILE_COUNT = 128
PACKET_TOTAL_LIMIT = 32 * 1024 * 1024


class PublicEvidenceVerifierTests(unittest.TestCase):
    @staticmethod
    def verifier_module():
        spec = importlib.util.spec_from_file_location("public_evidence_verifier", VERIFIER)
        module = importlib.util.module_from_spec(spec)
        # Importing retained evidence must not create an unlisted __pycache__
        # directory in the packet, including when the caller allows bytecode.
        with patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(module)
        return module

    def test_module_import_preserves_packet_when_bytecode_is_enabled(self):
        with self.packet_copy() as base:
            packet = base / PACKETS[-1]
            before = {str(path.relative_to(packet)): path.read_bytes()
                      for path in packet.rglob("*") if path.is_file()}
            with patch.dict(self.verifier_module.__globals__, {"VERIFIER": packet / "verify_public.py"}):
                with patch.object(sys, "dont_write_bytecode", False):
                    self.verifier_module()
                    self.assertFalse(sys.dont_write_bytecode, "caller setting was not restored")
            self.assertFalse((packet / "__pycache__").exists())
            after = {str(path.relative_to(packet)): path.read_bytes()
                     for path in packet.rglob("*") if path.is_file()}
            self.assertEqual(after, before)
            result = self.invoke(packet / "verify_public.py")
            self.assertEqual(result.returncode, 0, result.stderr)

    def replace_archive(self, base, members, compression=zipfile.ZIP_DEFLATED):
        archive_path = base / PACKETS[0] / "receipts.zip"
        rows = []
        with zipfile.ZipFile(archive_path, "w", compression=compression) as archive:
            for name, data in members:
                archive.writestr(name, data)
                digest = hashlib.sha256(data).hexdigest()
                rows.append({"member": name, "public_sha256": digest,
                             "public_bytes": len(data), "raw_sha256": digest,
                             "representation": "unchanged bytes"})
        raw = archive_path.read_bytes()

        def update(manifest):
            row = next(row for row in manifest["delivered_files"] if row["path"] == "receipts.zip")
            row.update(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
            row.pop("canonical_lf_sha256", None)
            manifest["archive_members"] = rows

        self.mutate_manifest(base, update)

    @contextmanager
    def packet_copy(self):
        with tempfile.TemporaryDirectory(prefix="ecorp-public-evidence-test-") as root:
            # Canonicalize only our newly allocated fixture root. Evidence paths
            # remain lexical so the verifier can reject links inside a packet.
            base = Path(root).resolve(strict=True) / "evidence"
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
        with self.packet_copy() as base:
            readme = base / PACKETS[0] / "README.md"
            readme.write_bytes(readme.read_bytes() + b"\ncontrolled fixture corruption\n")
            result = self.invoke(base / PACKETS[-1] / "verify_public.py")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('"result": "PASS"', result.stdout)

    def add_delivered_file(self, base, packet, name, size=0):
        path = base / packet / name
        with path.open("wb") as stream:
            stream.truncate(size)
        manifest_path = base / packet / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["delivered_files"].append({"path": name, "bytes": size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def assert_inventory_refused_before_payload(self, base, message):
        verifier = self.verifier_module()
        original = verifier.read_file

        def manifests_only(root, relative, **kwargs):
            self.assertEqual(relative, "manifest.json", "Payload read before inventory admission.")
            return original(root, relative, **kwargs)

        with patch.object(verifier, "read_file", side_effect=manifests_only):
            with self.assertRaisesRegex(AssertionError, message):
                verifier.verify(base)

    def test_packet_file_count_boundary_and_plus_one(self):
        with self.packet_copy() as base:
            packet = base / PACKETS[0]
            for number in range(PACKET_FILE_COUNT - len(list(packet.iterdir()))):
                self.add_delivered_file(base, PACKETS[0], f"empty-{number}.bin")
            result = self.invoke(base / PACKETS[-1] / "verify_public.py")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.add_delivered_file(base, PACKETS[0], "one-too-many.bin")
            self.assert_inventory_refused_before_payload(base, "packet manifest exceeds file limit")

    def test_directory_entry_limit_is_streamed_before_payload(self):
        verifier = self.verifier_module()
        with self.packet_copy() as base:
            for number in range(PACKET_FILE_COUNT + 1):
                (base / PACKETS[0] / f"unlisted-{number}.bin").touch()
            with patch.object(Path, "iterdir", side_effect=RuntimeError("unbounded directory inventory")):
                with self.assertRaisesRegex(AssertionError, "packet directory exceeds file limit"):
                    verifier.verify(base)

    def test_packet_total_uses_all_actual_sizes_before_payload(self):
        with self.packet_copy() as base:
            # Each packet is below the aggregate ceiling; their combined bytes
            # exceed it. Deliberately false manifest sizes cannot shrink the budget.
            for packet in PACKETS:
                self.add_delivered_file(base, packet, "padding-a.bin", 6 * 1024 * 1024)
                self.add_delivered_file(base, packet, "padding-b.bin", 6 * 1024 * 1024)
                path = base / packet / "manifest.json"
                manifest = json.loads(path.read_bytes())
                for row in manifest["delivered_files"]:
                    row["bytes"] = 0
                path.write_text(json.dumps(manifest), encoding="utf-8")
            self.assert_inventory_refused_before_payload(base, "evidence packets exceed total byte limit")

    def test_packet_total_exact_boundary_is_accepted(self):
        verifier = self.verifier_module()
        with self.packet_copy() as base:
            total = sum(path.stat().st_size for packet in PACKETS
                        for path in (base / packet).iterdir())
            self.assertLess(total, PACKET_TOTAL_LIMIT)
            with patch.object(verifier, "MAX_PACKET_TOTAL_BYTES", total):
                verifier.verify(base)
            with patch.object(verifier, "MAX_PACKET_TOTAL_BYTES", total - 1):
                with self.assertRaisesRegex(AssertionError, "evidence packets exceed total byte limit"):
                    verifier.verify(base)

    def test_admitted_file_growth_cannot_expand_payload_read(self):
        verifier = self.verifier_module()
        original = verifier.read_file
        with self.packet_copy() as base:
            grown = False

            def grow_after_inventory(root, relative, **kwargs):
                nonlocal grown
                if relative != "manifest.json" and not grown:
                    grown = True
                    with (root / relative).open("ab") as stream:
                        stream.write(b"growth after admitted inventory")
                return original(root, relative, **kwargs)

            with patch.object(verifier, "read_file", side_effect=grow_after_inventory):
                with self.assertRaisesRegex(AssertionError, "evidence file exceeds byte limit"):
                    verifier.verify(base)
            self.assertTrue(grown)

    def test_file_at_absolute_byte_limit_is_accepted(self):
        verifier = self.verifier_module()
        with tempfile.TemporaryDirectory(prefix="ecorp-evidence-file-boundary-") as root:
            base = Path(root).resolve(strict=True)
            path = base / "boundary.bin"
            with path.open("wb") as stream:
                stream.truncate(FILE_LIMIT)
            self.assertEqual(len(verifier.read_file(base, path.name)), FILE_LIMIT)

    def test_file_over_absolute_byte_limit_is_rejected_before_open(self):
        verifier = self.verifier_module()
        with tempfile.TemporaryDirectory(prefix="ecorp-evidence-file-over-limit-") as root:
            base = Path(root).resolve(strict=True)
            path = base / "oversized.bin"
            with path.open("wb") as stream:
                stream.truncate(FILE_LIMIT + 1)
            with patch.object(verifier.os, "open", wraps=os.open) as opened:
                with self.assertRaisesRegex(AssertionError, "evidence file exceeds byte limit"):
                    verifier.read_file(base, path.name)
                opened.assert_not_called()

    def test_file_read_is_bounded_even_after_the_size_precheck(self):
        verifier = self.verifier_module()
        original = os.fdopen

        @contextmanager
        def instrumented_descriptor(*args, **kwargs):
            with original(*args, **kwargs) as stream:
                owner = self

                class BoundedRead:
                    def fileno(self):
                        return stream.fileno()

                    def read(self, size=-1):
                        owner.assertGreater(size, 0, "unbounded evidence read requested")
                        owner.assertLessEqual(size, FILE_LIMIT + 1)
                        return stream.read(size)

                yield BoundedRead()

        with tempfile.TemporaryDirectory(prefix="ecorp-evidence-read-bound-") as root:
            base = Path(root).resolve(strict=True)
            (base / "small.txt").write_bytes(b"bounded read")
            with patch.object(verifier.os, "fdopen", side_effect=instrumented_descriptor):
                self.assertEqual(verifier.read_file(base, "small.txt"), b"bounded read")

    def test_archive_member_byte_boundary_and_plus_one(self):
        for size in (MEMBER_LIMIT, MEMBER_LIMIT + 1):
            with self.subTest(size=size), self.packet_copy() as base:
                self.replace_archive(base, [("member.txt", b"x" * size)])
                if size == MEMBER_LIMIT:
                    result = self.invoke(base / PACKETS[-1] / "verify_public.py")
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assert_refused(base, "archive member exceeds byte limit")

    def test_archive_aggregate_boundary_and_plus_one_member(self):
        for count in (ARCHIVE_TOTAL_LIMIT // MEMBER_LIMIT, ARCHIVE_TOTAL_LIMIT // MEMBER_LIMIT + 1):
            with self.subTest(count=count), self.packet_copy() as base:
                self.replace_archive(base, [(f"member-{n}.txt", b"x" * MEMBER_LIMIT) for n in range(count)])
                if count * MEMBER_LIMIT == ARCHIVE_TOTAL_LIMIT:
                    result = self.invoke(base / PACKETS[-1] / "verify_public.py")
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assert_refused(base, "archive expansion exceeds byte limit")

    def test_archive_member_count_boundary_and_plus_one(self):
        for count in (ARCHIVE_MEMBER_COUNT, ARCHIVE_MEMBER_COUNT + 1):
            with self.subTest(count=count), self.packet_copy() as base:
                self.replace_archive(base, [(f"member-{n}.txt", b"") for n in range(count)])
                if count == ARCHIVE_MEMBER_COUNT:
                    result = self.invoke(base / PACKETS[-1] / "verify_public.py")
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assert_refused(base, "archive exceeds member limit")

    def test_compressed_archive_file_is_capped_before_zip_parsing(self):
        verifier = self.verifier_module()
        with self.packet_copy() as base:
            self.replace_archive(base, [(f"member-{n}.txt", b"x" * MEMBER_LIMIT) for n in range(5)],
                                 compression=zipfile.ZIP_STORED)
            self.assertGreater((base / PACKETS[0] / "receipts.zip").stat().st_size, ARCHIVE_LIMIT)
            with patch.object(verifier.zipfile, "ZipFile", side_effect=RuntimeError("ZIP was parsed")):
                with self.assertRaisesRegex(AssertionError, "evidence file exceeds byte limit"):
                    verifier.verify(base)

    def test_oversized_zip_member_is_refused_before_decompression(self):
        verifier = self.verifier_module()
        with self.packet_copy() as base:
            self.replace_archive(base, [("bomb.txt", b"x" * (MEMBER_LIMIT + 1))])
            with patch.object(verifier.zipfile.ZipFile, "open", side_effect=RuntimeError("ZIP payload was decompressed")):
                with self.assertRaisesRegex(AssertionError, "archive member exceeds byte limit"):
                    verifier.verify(base)

    def test_duplicate_archive_manifest_rows_are_rejected(self):
        with self.packet_copy() as base:
            self.mutate_manifest(base, lambda manifest: manifest["archive_members"].append(dict(manifest["archive_members"][0])))
            self.assert_refused(base, "duplicate archive path")

    def test_intact_copy_under_linked_temporary_parent_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="ecorp-public-evidence-temp-parent-") as root:
            parent = Path(root).resolve(strict=True)
            physical = parent / "physical-temp"
            physical.mkdir()
            alias = parent / "system-temp-alias"
            self.directory_link(alias, physical)
            try:
                copytree = shutil.copytree

                def copy_to_canonical_root(source, destination):
                    self.assertEqual(
                        destination, physical / "evidence" / source.name,
                        "the trusted allocated test root must be canonical before copying",
                    )
                    return copytree(source, destination)

                # Model the OS returning an already allocated temporary directory
                # through an alias, as macOS does for /var. Do not ask Windows
                # mkdtemp to create a directory through a junction.
                with (
                    patch.object(tempfile, "TemporaryDirectory", return_value=nullcontext(str(alias))),
                    patch.object(shutil, "copytree", side_effect=copy_to_canonical_root),
                ):
                    with self.packet_copy() as base:
                        result = self.invoke(base / PACKETS[-1] / "verify_public.py")
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIn('"result": "PASS"', result.stdout)
            finally:
                self.remove_directory_link(alias)

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

    def test_hard_linked_manifest_and_delivered_file_are_rejected(self):
        for name in ("manifest.json", "README.md"):
            with self.subTest(name=name), self.packet_copy() as base:
                entry = base / PACKETS[0] / name
                original = entry.read_bytes()
                target = base.parent / ("outside-" + name)
                target.write_bytes(original)
                entry.unlink()
                os.link(target, entry)
                try:
                    self.assertEqual(entry.stat().st_nlink, 2)
                    self.assertEqual(entry.read_bytes(), original)
                    self.assert_refused(base, "hard-linked evidence entry")
                finally:
                    entry.unlink()
                self.assertEqual(target.read_bytes(), original)
                self.assertEqual(target.stat().st_nlink, 1)

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
