# Reproduce the verifier correction

Use a fresh checkout of the published commit. Run `python -X utf8 -m unittest discover -s tools -p test_public_evidence_verifier.py -v` on Windows with permission to create owned symlinks/junctions, and run the nine commands in validation.json. Record any skips rather than claiming those cases passed.

The recorded exact-byte driver exports the test module and four historical packets from the staged Git tree into a new owned directory, checks their blob hashes, executes all fourteen tests, and verifies the corrected gauntlet inventory and path metadata. Its local placeholders require explicit owned paths and a new output revision. Raw original metadata/archive bytes used by the correction driver are privately retained; that driver is a historical record and does not authorize reconstructing absent originals. No external service credentials or network calls are required.

The supplemental receipt and source-binding.json distinguish Windows CRLF worktree bytes from LF Git bytes. validation.png captures a saved validation report; it is not fresh application acceptance. Original application captures in earlier packets retain their original scope.
